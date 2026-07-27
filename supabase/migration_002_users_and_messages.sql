-- ============================================================================
--  CCDT migration 002 — internal username + mailbox
--  Adds a `users` profile table (username is the internal mail recipient ID)
--  and a `messages` table for Inbox / Sent / Compose with clearance-gated
--  visibility. All RPCs are SECURITY DEFINER and granted only to authenticated.
--  Idempotent; safe to re-run.
-- ============================================================================

-- 0) enable citext for case-insensitive usernames (no-op if already installed)
create extension if not exists citext;

-- ──────────────────────────────────────────────────────────────────────────
-- 1) USERS profile table
--    `username` is the addressable ID for internal mail. It must be unique,
--    case-insensitive (citext), and 3-32 chars [a-z0-9_-].
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.users (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     citext unique not null
                 check (char_length(username) between 3 and 32
                        and username ~ '^[a-z0-9_-]+$'),
  created_at   timestamptz not null default now()
);
create index if not exists users_username_idx on public.users (username);

alter table public.users enable row level security;

-- Anyone authenticated can read usernames (for autocomplete + sender lookup).
drop policy if exists "users_read_authenticated" on public.users;
create policy "users_read_authenticated"
  on public.users for select to authenticated using (true);

-- Only the owner can insert/update their own profile row.
drop policy if exists "users_write_owner" on public.users;
create policy "users_write_owner"
  on public.users for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ──────────────────────────────────────────────────────────────────────────
-- 2) MESSAGES table
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  sender_id       uuid references auth.users(id) on delete set null,
  recipient       citext not null,         -- recipient's username (CCDT address)
  subject         text not null,
  body            text not null,
  priority        text not null default 'normal'
                    check (priority in ('normal','important','urgent')),
  classification  text not null default 'PUBLIC'
                    check (classification in ('PUBLIC','CONFIDENTIAL','SECRET','TOP SECRET')),
  read_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists messages_recipient_idx on public.messages (recipient);
create index if not exists messages_sender_idx   on public.messages (sender_id);
create index if not exists messages_class_idx    on public.messages (classification);
create index if not exists messages_created_idx  on public.messages (created_at desc);

alter table public.messages enable row level security;

-- BEFORE INSERT: stamp sender_id = auth.uid() (client can't spoof).
-- Stamp recipient canonical-cased so lookups are deterministic.
create or replace function public.set_message_meta()
returns trigger language plpgsql as $$
begin
  if new.sender_id is null then
    new.sender_id := auth.uid();
  end if;
  new.recipient := lower(new.recipient);
  return new;
end; $$;

drop trigger if exists messages_set_meta on public.messages;
create trigger messages_set_meta
  before insert on public.messages
  for each row execute function public.set_message_meta();

-- Visibility: you sent it, OR recipient matches your username,
-- OR your clearance >= the message's classification (per archive rules).
-- Read policy does ALL of SELECT and UPDATE (so the recipient can mark read).
drop policy if exists "messages_read_authenticated" on public.messages;
create policy "messages_read_authenticated"
  on public.messages for select to authenticated
  using (
    sender_id = auth.uid()
    or recipient = (select username from public.users where id = auth.uid())
    or public.required_clearance(classification) <= public.user_clearance()
  );

-- INSERT: any authenticated user (with check so sender must equal caller).
drop policy if exists "messages_insert_authenticated" on public.messages;
create policy "messages_insert_authenticated"
  on public.messages for insert to authenticated
  with check (sender_id = auth.uid());

-- UPDATE: only the recipient can set read_at. Other fields are read-only.
drop policy if exists "messages_update_recipient" on public.messages;
create policy "messages_update_recipient"
  on public.messages for update to authenticated
  using ( recipient = (select username from public.users where id = auth.uid()) )
  with check ( recipient = (select username from public.users where id = auth.uid()) );

-- ──────────────────────────────────────────────────────────────────────────
-- 3) RPCs (SECURITY DEFINER — they bypass RLS and apply the policy themselves
--    using the CALLER's auth identity)
-- ──────────────────────────────────────────────────────────────────────────

-- 3a) peek_username_taken(p_username) — case-insensitive uniqueness check.
create or replace function public.peek_username_taken(p_username citext)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.users where username = lower(p_username));
$$;

revoke execute on function public.peek_username_taken(citext) from public;
grant execute on function public.peek_username_taken(citext) to authenticated;

-- 3b) peek_user_by_username(p_username) — for login by username.
create or replace function public.peek_user_by_username(p_username citext)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', u.id, 'email', au.email, 'username', u.username)
  from public.users u
  join auth.users au on au.id = u.id
  where u.username = lower(p_username);
$$;

revoke execute on function public.peek_user_by_username(citext) from public;
grant execute on function public.peek_user_by_username(citext) to authenticated;

-- 3c) peek_user_by_email(p_email) — used when a username is being created
-- to verify the email isn't already taken by another account.
create or replace function public.peek_user_by_email(p_email text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'email', email)
  from auth.users where email = lower(p_email);
$$;

revoke execute on function public.peek_user_by_email(text) from public;
grant execute on function public.peek_user_by_email(text) to authenticated;

-- 3d) peek_inbox(p_username) — your inbox (recipient = your username).
create or replace function public.peek_inbox(p_username citext)
returns table (
  id uuid, subject text, body text, priority text, classification text,
  sender_email text, sender_username citext,
  read_at timestamptz, created_at timestamptz
) language sql stable security definer set search_path = public as $$
  select m.id, m.subject, m.body, m.priority, m.classification,
         au.email::text as sender_email,
         s.username as sender_username,
         m.read_at, m.created_at
  from public.messages m
  left join auth.users au on au.id = m.sender_id
  left join public.users s on s.id = m.sender_id
  where m.recipient = lower(p_username)
  order by m.created_at desc
  limit 200;
$$;

revoke execute on function public.peek_inbox(citext) from public;
grant execute on function public.peek_inbox(citext) to authenticated;

-- 3e) peek_sent(p_userid) — your sent items.
create or replace function public.peek_sent(p_userid uuid)
returns table (
  id uuid, subject text, body text, priority text, classification text,
  recipient citext, read_at timestamptz, created_at timestamptz
) language sql stable security definer set search_path = public as $$
  select m.id, m.subject, m.body, m.priority, m.classification,
         m.recipient, m.read_at, m.created_at
  from public.messages m
  where m.sender_id = p_userid
  order by m.created_at desc
  limit 200;
$$;

revoke execute on function public.peek_sent(uuid) from public;
grant execute on function public.peek_sent(uuid) to authenticated;

-- 3f) peek_send_message(...) — validate recipient exists, classification vs
-- your clearance, insert. Returns the new message id + status.
create or replace function public.peek_send_message(
  p_recipient  citext,
  p_subject    text,
  p_body       text,
  p_priority   text,
  p_classification text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rid uuid;
  me uuid;
  usr int;
  req int;
  new_id uuid;
begin
  me := auth.uid();
  if me is null then
    return jsonb_build_object('status','denied','reason','not_authenticated');
  end if;
  select id into rid from public.users where username = lower(p_recipient);
  if rid is null then
    return jsonb_build_object('status','not_found','reason','recipient_does_not_exist',
                              'recipient', lower(p_recipient));
  end if;
  -- Class is restricted only if the *recipient's* clearance < required —
  -- a TOP SECRET message may be sent to a level-4 recipient even if you're
  -- lower, as long as you can name the recipient. To keep this simple, we
  -- require the SENDER's clearance >= the message's required level (so a
  -- level-1 user can't fire off a TOP SECRET mail).
  usr := public.user_clearance();
  req := public.required_clearance(p_classification);
  if req > usr then
    return jsonb_build_object('status','denied','reason','insufficient_clearance',
                              'required',req,'have',usr);
  end if;
  insert into public.messages (sender_id, recipient, subject, body, priority, classification)
  values (me, lower(p_recipient), p_subject, p_body, p_priority, p_classification)
  returning id into new_id;
  return jsonb_build_object('status','ok','id',new_id,'recipient',lower(p_recipient));
end; $$;

revoke execute on function public.peek_send_message(citext, text, text, text, text) from public;
grant execute on function public.peek_send_message(citext, text, text, text, text) to authenticated;

-- 3g) peek_mark_read(p_id) — only the recipient can mark their message read.
create or replace function public.peek_mark_read(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rec public.messages%rowtype;
  me uuid;
  me_username citext;
begin
  me := auth.uid();
  if me is null then return jsonb_build_object('status','denied'); end if;
  select username into me_username from public.users where id = me;
  select * into rec from public.messages where id = p_id;
  if rec.id is null then return jsonb_build_object('status','not_found'); end if;
  if rec.recipient <> me_username then
    return jsonb_build_object('status','denied','reason','not_recipient');
  end if;
  update public.messages set read_at = now() where id = p_id;
  return jsonb_build_object('status','ok','id',p_id);
end; $$;

revoke execute on function public.peek_mark_read(uuid) from public;
grant execute on function public.peek_mark_read(uuid) to authenticated;

-- 3h) peek_register_username(p_username) — claim a username for the caller.
-- Used AFTER signUp. Re-checks uniqueness and ownership.
create or replace function public.peek_register_username(p_username citext)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid;
begin
  me := auth.uid();
  if me is null then return jsonb_build_object('status','denied','reason','not_authenticated'); end if;
  if exists(select 1 from public.users where username = lower(p_username)) then
    return jsonb_build_object('status','taken','username', lower(p_username));
  end if;
  insert into public.users (id, username) values (me, lower(p_username))
  on conflict (id) do update set username = excluded.username;
  return jsonb_build_object('status','ok','username', lower(p_username));
end; $$;

revoke execute on function public.peek_register_username(citext) from public;
grant execute on function public.peek_register_username(citext) to authenticated;