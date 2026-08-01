-- ============================================================================
--  CCDT migration 004 — O5 council clearance + activity log + O5 broadcast
--  Adds:
--    1. clearance level 5 (O5) — top of the existing scale
--    2. public.activity_log table (login, logout, archive CRUD, mail, promotions)
--    3. peek_activity_log RPC — O5 only
--    4. peek_set_clearance RPC — promote/demote with strict O5 rule
--    5. peek_send_message extended for O5 broadcast (recipient = 'all')
--    6. messages.priority extended with 'o5' (council broadcast)
--  All RPCs are SECURITY DEFINER. Idempotent; safe to re-run.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- 1) Extend required_clearance() to recognise level 5 (O5) class
--    Adds 'O5' as a valid classification. Documents tagged O5 require the
--    caller's clearance to be 5 (i.e. O5 council members).
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.required_clearance(p_class text)
returns int language sql immutable as $$
  select case coalesce(p_class,'')
    when 'PUBLIC' then 1
    when 'CONFIDENTIAL' then 2
    when 'SECRET' then 3
    when 'TOP SECRET' then 4
    when 'O5' then 5
    else 1 end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 2) ACTIVITY LOG
--    Free-form event log; O5 reads via RPC. Triggers on archives + messages
--    capture the obvious events automatically. auth events (login/logout)
--    are captured client-side via peek_log_activity() since we can't install
--    triggers on auth.users.
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.activity_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  username    citext,                -- captured at write time
  user_clearance int default 1,
  action      text not null check (action in (
                'login','logout','access','create','edit','delete',
                'send_message','broadcast','promote','demote',
                'register','register_username','change_password',
                -- vault operations (added with migration_006)
                'create_vault','delete_vault','set_vault_public',
                'invite','join_vault','join_request',
                'join_request_approve','join_request_decline',
                'set_member','fire','transfer_init',
                'transfer_accept','transfer_decline',
                'reset_vault_password','visit_grant','visit_revoke'
              )),
  target      text,                  -- archive_number, username, message_id, etc.
  detail      jsonb default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists activity_log_created_idx on public.activity_log (created_at desc);
create index if not exists activity_log_user_idx    on public.activity_log (user_id);
create index if not exists activity_log_action_idx  on public.activity_log (action);

alter table public.activity_log enable row level security;

-- Everyone authenticated can read the log (O5 is the *intended* audience,
-- but mirrors archive policy: read-clearance is permissive).
drop policy if exists "activity_log_read_authenticated" on public.activity_log;
create policy "activity_log_read_authenticated"
  on public.activity_log for select to authenticated using (true);

-- No direct inserts/updates/deletes — everything goes through RPCs.
drop policy if exists "activity_log_no_direct_write" on public.activity_log;
create policy "activity_log_no_direct_write"
  on public.activity_log for all to authenticated
  using (false) with check (false);

-- Generic activity-log writer. SECURITY DEFINER so the trigger / RPC bypasses
-- the no-write policy. `p_user_id` is captured; if null we fall back to
-- auth.uid(). `p_username` is the case the user had at the moment of the event.
create or replace function public.write_activity(
  p_action    text,
  p_target    text default null,
  p_detail    jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid;
  uname citext;
  cl int;
begin
  -- Resolve _forced_user_id (optional override) → null when missing or empty,
  -- so we never try to cast an empty string to uuid.
  if p_detail ? '_forced_user_id' and nullif(p_detail->>'_forced_user_id','') is not null then
    me := (p_detail->>'_forced_user_id')::uuid;
  else
    me := auth.uid();
  end if;
  if me is not null then
    select username into uname from public.users where id = me;
    select coalesce((raw_user_meta_data->>'clearance_level')::int, 1)
      into cl from auth.users where id = me;
  end if;
  insert into public.activity_log (user_id, username, user_clearance, action, target, detail)
  values (me, uname, coalesce(cl, 1), p_action, p_target,
          p_detail - '_forced_user_id');
end; $$;

revoke execute on function public.write_activity(text, text, jsonb) from public;
grant execute on function public.write_activity(text, text, jsonb) to authenticated;

-- peek_log_activity: O5 (level 5) reads activity since a timestamp.
-- Falls back to last 50 rows when no since given.
create or replace function public.peek_log_activity(p_since timestamptz default null)
returns table (
  id uuid, action text, target text, detail jsonb,
  username citext, user_clearance int, created_at timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  cl int;
begin
  cl := public.user_clearance();
  if cl < 5 then
    -- Non-O5 callers see only their OWN activity, capped to last 50.
    return query
      select a.id, a.action, a.target, a.detail, a.username, a.user_clearance, a.created_at
      from public.activity_log a
      where a.user_id = auth.uid()
        and (p_since is null or a.created_at > p_since)
      order by a.created_at desc
      limit 50;
    return;
  end if;
  -- O5 sees the entire log.
  return query
    select a.id, a.action, a.target, a.detail, a.username, a.user_clearance, a.created_at
    from public.activity_log a
    where (p_since is null or a.created_at > p_since)
    order by a.created_at desc
    limit 200;
end; $$;

revoke execute on function public.peek_log_activity(timestamptz) from public;
grant execute on function public.peek_log_activity(timestamptz) to authenticated;

-- Triggers: auto-log archive CRUD.
create or replace function public.log_archive_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.write_activity('create', new.archive_number,
    jsonb_build_object('classification', new.classification, 'title', new.title));
  return new;
end; $$;

drop trigger if exists archives_log_insert on public.archives;
create trigger archives_log_insert
  after insert on public.archives
  for each row execute function public.log_archive_insert();

create or replace function public.log_archive_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  act text;
begin
  if (tg_op = 'UPDATE') then
    if (old.title is distinct from new.title) or
       (old.content is distinct from new.content) or
       (old.classification is distinct from new.classification) or
       (old.department is distinct from new.department) then
      act := 'edit';
    else
      act := 'edit';
    end if;
  elsif (tg_op = 'DELETE') then
    act := 'delete';
  end if;
  perform public.write_activity(act, coalesce(old.archive_number, new.archive_number),
    jsonb_build_object('classification', coalesce(new.classification, old.classification)));
  return coalesce(new, old);
end; $$;

drop trigger if exists archives_log_change on public.archives;
create trigger archives_log_change
  after update or delete on public.archives
  for each row execute function public.log_archive_change();

-- Trigger on archive.access_archive RPC writes an 'access' event.
create or replace function public.access_archive(p_num text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rec public.archives%rowtype;
  req int;
  usr int;
begin
  if auth.uid() is null then
    return jsonb_build_object('status','denied','required',99,'have',0,'classification','NONE');
  end if;
  select * into rec from public.archives where archive_number = p_num;
  if rec.id is null then
    return jsonb_build_object('status','not_found');
  end if;
  req := public.required_clearance(rec.classification);
  usr := public.user_clearance();
  if req > usr then
    return jsonb_build_object('status','denied','required',req,'have',usr,'classification',rec.classification);
  end if;
  perform public.write_activity('access', rec.archive_number,
    jsonb_build_object('classification', rec.classification));
  return jsonb_build_object('status','ok','data', to_jsonb(rec));
end; $$;

-- Trigger on messages: log every send.
create or replace function public.log_message_send()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.write_activity(
    case when new.priority = 'o5' then 'broadcast' else 'send_message' end,
    new.id::text,
    jsonb_build_object('recipient', new.recipient, 'subject', new.subject,
                       'priority', new.priority, 'classification', new.classification));
  return new;
end; $$;

drop trigger if exists messages_log_send on public.messages;
create trigger messages_log_send
  after insert on public.messages
  for each row execute function public.log_message_send();

-- ──────────────────────────────────────────────────────────────────────────
-- 3) PROMOTION / DEMOTION (O5 only)
--    Rule: caller MUST be level 5 (O5). Target's new clearance must be
--    ≤ caller's clearance (i.e. an O5 can set anyone to anything 1–5).
--    For non-O5 callers, the rule is symmetric: their max-promotable target
--    is ≤ their own level. (L4 cannot promote to O5.)
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.peek_set_clearance(
  p_target_email text,
  p_new_level    int
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid;
  me_level int;
  tgt uuid;
  tgt_level int;
  tgt_username citext;
begin
  me := auth.uid();
  if me is null then
    return jsonb_build_object('status','denied','reason','not_authenticated');
  end if;
  if p_new_level is null or p_new_level < 1 or p_new_level > 5 then
    return jsonb_build_object('status','denied','reason','invalid_level',
                              'allowed','1 to 5');
  end if;
  me_level := public.user_clearance();
  -- O5 only. Even though a L4 could in theory move others within 1..4, we
  -- restrict clearance changes to O5 council members only — preventing any
  -- non-council operator from reshaping the hierarchy.
  if me_level < 5 then
    return jsonb_build_object('status','denied','reason','o5_only',
                              'your_level', me_level);
  end if;
  -- The new clearance cannot exceed the caller's clearance. O5 holds level 5,
  -- so they may set anyone to anything 1..5.
  if p_new_level > me_level then
    return jsonb_build_object('status','denied','reason','exceeds_caller',
                              'your_level', me_level, 'requested', p_new_level);
  end if;
  -- Resolve target by email.
  select id into tgt from auth.users where lower(email) = lower(p_target_email);
  if tgt is null then
    return jsonb_build_object('status','not_found','reason','no_such_email');
  end if;
  select coalesce((raw_user_meta_data->>'clearance_level')::int, 1)
    into tgt_level from auth.users where id = tgt;
  select username into tgt_username from public.users where id = tgt;
  -- Apply.
  update auth.users
     set raw_user_meta_data =
         coalesce(raw_user_meta_data, '{}'::jsonb)
         || jsonb_build_object('clearance_level', p_new_level)
   where id = tgt;
  -- Log it.
  perform public.write_activity(
    case when p_new_level > tgt_level then 'promote' else 'demote' end,
    p_target_email,
    jsonb_build_object('from', tgt_level, 'to', p_new_level, 'target_username', tgt_username));
  return jsonb_build_object('status','ok',
                            'target', p_target_email,
                            'username', tgt_username,
                            'from', tgt_level,
                            'to', p_new_level);
end; $$;

revoke execute on function public.peek_set_clearance(text, int) from public;
grant execute on function public.peek_set_clearance(text, int) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 4) EXTEND messages.priority to allow 'o5' (council broadcast)
-- ──────────────────────────────────────────────────────────────────────────
alter table public.messages drop constraint if exists messages_priority_check;
alter table public.messages
  add constraint messages_priority_check
  check (priority in ('normal','important','urgent','o5'));

-- ──────────────────────────────────────────────────────────────────────────
-- 5) EXTEND peek_send_message for O5 broadcast
--    When recipient = 'all' and the caller is O5, expand to one row per
--    user whose clearance is >= the message's required level, and tag the
--    subject with "[O5 BROADCAST]".
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.peek_send_message(
  p_recipient  citext,
  p_subject    text,
  p_body       text,
  p_priority   text,
  p_classification text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid;
  me_level int;
  usr int;
  req int;
  rid uuid;
  rec record;
  new_id uuid;
  broadcast_count int := 0;
  final_subject text;
begin
  me := auth.uid();
  if me is null then
    return jsonb_build_object('status','denied','reason','not_authenticated');
  end if;
  me_level := public.user_clearance();
  usr := me_level;
  req := public.required_clearance(p_classification);
  -- The sender must hold clearance >= the message's required level.
  if req > usr then
    return jsonb_build_object('status','denied','reason','insufficient_clearance',
                              'required',req,'have',usr);
  end if;
  -- Validate priority (now including 'o5').
  if p_priority not in ('normal','important','urgent','o5') then
    return jsonb_build_object('status','denied','reason','invalid_priority');
  end if;
  -- O5 broadcast path.
  if lower(p_recipient) = 'all' then
    if me_level < 5 then
      return jsonb_build_object('status','denied','reason','o5_only');
    end if;
    if p_priority <> 'o5' then
      -- Auto-promote to o5 priority for clarity in the inbox.
      p_priority := 'o5';
    end if;
    final_subject := '[O5 BROADCAST] ' || coalesce(p_subject, '');
    for rec in
      select u.username as username
      from public.users u
      join auth.users au on au.id = u.id
      where coalesce((au.raw_user_meta_data->>'clearance_level')::int, 1) >= req
        and u.username is not null
    loop
      insert into public.messages (sender_id, recipient, subject, body, priority, classification)
      values (me, rec.username, final_subject, p_body, p_priority, p_classification);
      broadcast_count := broadcast_count + 1;
    end loop;
    return jsonb_build_object('status','ok','broadcast', broadcast_count,
                              'subject', final_subject, 'priority', p_priority,
                              'classification', p_classification);
  end if;
  -- Single-recipient path (unchanged from migration 002).
  select id into rid from public.users where username = lower(p_recipient);
  if rid is null then
    return jsonb_build_object('status','not_found','reason','recipient_does_not_exist',
                              'recipient', lower(p_recipient));
  end if;
  insert into public.messages (sender_id, recipient, subject, body, priority, classification)
  values (me, lower(p_recipient), coalesce(p_subject,''), p_body, p_priority, p_classification)
  returning id into new_id;
  return jsonb_build_object('status','ok','id',new_id,'recipient',lower(p_recipient));
end; $$;

revoke execute on function public.peek_send_message(citext, text, text, text, text) from public;
grant execute on function public.peek_send_message(citext, text, text, text, text) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 6) peek_all_archives(p_limit) — O5 only. Bypasses the clearance filter so
--    the council sees EVERY archive ever created, including ones their own
--    clearance wouldn't normally grant.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.peek_all_archives(p_limit int default 100)
returns table (
  id uuid, archive_number text, title text, classification text,
  department text, created_at timestamptz, updated_at timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  if public.user_clearance() < 5 then
    -- Non-O5 callers fall back to the normal RLS-filtered view.
    return query
      select a.id, a.archive_number, a.title, a.classification,
             a.department, a.created_at, a.updated_at
      from public.archives a
      order by a.archive_number
      limit p_limit;
    return;
  end if;
  return query
    select a.id, a.archive_number, a.title, a.classification,
           a.department, a.created_at, a.updated_at
    from public.archives a
    order by a.archive_number
    limit p_limit;
end; $$;

revoke execute on function public.peek_all_archives(int) from public;
grant execute on function public.peek_all_archives(int) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 7) PEEK INBOX / peek_sent should expose the o5 priority so the client
--    can render the freeze-popup. The existing function signature already
--    returns `priority text` so no signature change is needed.
-- ──────────────────────────────────────────────────────────────────────────

-- ──────────────────────────────────────────────────────────────────────────
-- 8) ONE-TIME FOUNDER PROMOTION
--    Promote the O5 Council founder to clearance level 5. This is the
--    documented path to grant O5: SQL update of raw_user_meta_data on
--    auth.users. After this migration runs, the founder's `whoami` will
--    show `clearance level: 5 (O5 COUNCIL)`.
--    Idempotent: only updates if clearance is currently less than 5.
-- ──────────────────────────────────────────────────────────────────────────
do $$
declare
  v_user_id uuid;
begin
  select id into v_user_id
  from auth.users
  where lower(email) = 'suuupercharge900watts@hotmail.com'
  limit 1;

  if v_user_id is not null then
    update auth.users
       set raw_user_meta_data =
             coalesce(raw_user_meta_data, '{}'::jsonb)
             || jsonb_build_object('clearance_level', 5)
     where id = v_user_id
       and coalesce((raw_user_meta_data->>'clearance_level')::int, 0) < 5;

    -- Seed the activity log so the founder's first O5 audit row exists.
    insert into public.activity_log (user_id, username, action, target, detail)
    values (
      v_user_id,
      'founder',
      'promote',
      'suuupercharge900watts@hotmail.com',
      jsonb_build_object('from', 1, 'to', 5, 'reason', 'founder_charter')
    );
  end if;
end; $$;
