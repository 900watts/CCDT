-- ============================================================================
--  CCDT migration 006 — Vaults, dual-clearance, owner transfer, visit grants
-- ============================================================================
--  Adds the full multi-tenant authorization model:
--    1. vaults / vault_members / vault_invites / vault_transfers /
--       vault_visit_grants / vault_join_requests tables
--    2. vault_id column on archives / messages / activity_log
--    3. Helpers: effective_vault_clearance, can_read_vault_archive,
--       is_vault_member, is_vault_owner_or_admin, is_vault_admin,
--       vault_is_public
--    4. RLS rewrite on archives + messages using vault-scoped policies
--    5. ~20 new RPCs for vault operations (create/invite/accept/fire/
--       password-reset/transfer/visit-grant/join-request/etc.)
--    6. Bootstrap: creates `900watts` vault owned by O5 founder,
--       backfills all existing rows into it
--  Idempotent: safe to re-run.
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════════════
-- 1) HELPER: enum-like clearance number for vault-internal classification
--    (kept identical to existing required_clearance() — same scale 1..5)
-- ════════════════════════════════════════════════════════════════════════════
-- already exists from schema.sql — do nothing here.

-- ════════════════════════════════════════════════════════════════════════════
-- 2) VAULTS TABLE
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.vaults (
  id               citext primary key check (id ~ '^[a-z0-9_-]{3,32}$'),
  display_name     text not null check (char_length(display_name) between 1 and 80),
  owner_id         uuid not null references auth.users(id) on delete restrict,
  is_public        boolean not null default false,
  password_hash    text,
  recovery_token   uuid default gen_random_uuid(),
  storage_quota_mb int  not null default 512 check (storage_quota_mb between 16 and 10240),
  created_at       timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════════════════════
-- 3) VAULT MEMBERS TABLE
--    role ∈ {owner, admin, member}. clearance 1..4 (vault-internal).
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.vault_members (
  vault_id   citext not null references public.vaults(id) on delete cascade,
  user_id    uuid   not null references auth.users(id) on delete cascade,
  role       text   not null default 'member' check (role in ('owner','admin','member')),
  clearance  int    not null default 1 check (clearance between 1 and 4),
  joined_at  timestamptz not null default now(),
  primary key (vault_id, user_id)
);
create index if not exists vault_members_user_idx on public.vault_members (user_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 4) VAULT INVITES TABLE
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.vault_invites (
  token          uuid primary key default gen_random_uuid(),
  vault_id       citext not null references public.vaults(id) on delete cascade,
  invited_by     uuid   not null references auth.users(id) on delete cascade,
  invitee_email  citext not null,
  role           text   not null default 'member' check (role in ('admin','member')),
  clearance      int    not null default 1 check (clearance between 1 and 4),
  expires_at     timestamptz not null default (now() + interval '7 days'),
  accepted_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists vault_invites_email_idx on public.vault_invites (lower(invitee_email));

-- ════════════════════════════════════════════════════════════════════════════
-- 5) VAULT TRANSFERS TABLE (ownership transfer, two-step accept)
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.vault_transfers (
  token          uuid primary key default gen_random_uuid(),
  vault_id       citext not null references public.vaults(id) on delete cascade,
  from_user_id   uuid   not null references auth.users(id) on delete cascade,
  to_username    citext not null,
  status         text   not null default 'pending' check (status in ('pending','accepted','declined','expired')),
  expires_at     timestamptz not null default (now() + interval '7 days'),
  resolved_at    timestamptz,
  created_at     timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════════════════════
-- 6) VAULT VISIT GRANTS TABLE (temporary access for outsiders)
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.vault_visit_grants (
  id          uuid primary key default gen_random_uuid(),
  vault_id    citext not null references public.vaults(id) on delete cascade,
  visitor_id  uuid   not null references auth.users(id) on delete cascade,
  granted_by  uuid   references auth.users(id),
  clearance   int    not null check (clearance between 1 and 4),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  unique (vault_id, visitor_id)
);

-- ════════════════════════════════════════════════════════════════════════════
-- 7) VAULT JOIN REQUESTS TABLE (outsider → permanent member)
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.vault_join_requests (
  id            uuid primary key default gen_random_uuid(),
  vault_id      citext not null references public.vaults(id) on delete cascade,
  requester_id  uuid   not null references auth.users(id) on delete cascade,
  message       text,
  status        text   not null default 'pending' check (status in ('pending','approved','declined','expired')),
  resolved_by   uuid   references auth.users(id),
  resolved_at   timestamptz,
  created_at    timestamptz not null default now()
);
-- A user can only have ONE pending request per vault (unique partial via index)
create unique index if not exists vault_join_requests_pending_unique
  on public.vault_join_requests (vault_id, requester_id)
  where status = 'pending';

-- ════════════════════════════════════════════════════════════════════════════
-- 8) ADD vault_id TO EXISTING TABLES
-- ════════════════════════════════════════════════════════════════════════════
alter table public.archives     add column if not exists vault_id citext references public.vaults(id) on delete restrict;
alter table public.messages     add column if not exists vault_id citext references public.vaults(id) on delete restrict;
alter table public.activity_log add column if not exists vault_id citext references public.vaults(id) on delete restrict;

create index if not exists archives_vault_idx    on public.archives (vault_id);
create index if not exists messages_vault_idx    on public.messages (vault_id);
create index if not exists activity_log_vault_idx on public.activity_log (vault_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 9) BOOTSTRAP — create founder's vault, backfill existing rows
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_owner uuid;
  v_id    citext := '900watts';
  v_count int;
begin
  select id into v_owner from auth.users
   where lower(email) = 'suuupercharge900watts@hotmail.com'
   limit 1;

  if v_owner is null then
    raise notice 'No founder account — skipping bootstrap';
    return;
  end if;

  -- Create the vault + owner membership if missing
  insert into public.vaults (id, display_name, owner_id, is_public)
  values (v_id, '900watts HQ', v_owner, false)
  on conflict (id) do nothing;

  insert into public.vault_members (vault_id, user_id, role, clearance)
  values (v_id, v_owner, 'owner', 4)  -- owner auto TOP SECRET (clearance ignored for owner)
  on conflict (vault_id, user_id) do update set role = 'owner';

  -- Backfill existing rows that have no vault_id
  update public.archives     set vault_id = v_id where vault_id is null;
  get diagnostics v_count = row_count;
  raise notice 'backfilled % archives rows', v_count;

  update public.messages     set vault_id = v_id where vault_id is null;
  get diagnostics v_count = row_count;
  raise notice 'backfilled % messages rows', v_count;

  update public.activity_log set vault_id = v_id where vault_id is null;
  get diagnostics v_count = row_count;
  raise notice 'backfilled % activity_log rows', v_count;
end; $$;

-- Make vault_id NOT NULL after backfill (safe — we already confirmed zero nulls in plan)
do $$
begin
  if not exists (select 1 from public.archives     where vault_id is null) then
    alter table public.archives alter column vault_id set not null;
  end if;
  if not exists (select 1 from public.messages     where vault_id is null) then
    alter table public.messages alter column vault_id set not null;
  end if;
  if not exists (select 1 from public.activity_log where vault_id is null) then
    alter table public.activity_log alter column vault_id set not null;
  end if;
end; $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 10) HELPER FUNCTIONS (SECURITY DEFINER to avoid RLS recursion)
-- ════════════════════════════════════════════════════════════════════════════

-- Effective vault-internal clearance for the current user in vault X.
-- Returns 0 (PUBLIC disabled) if outsider with no grant,
-- 1..4 if member/grant-holder, TOP SECRET (4) if owner.
create or replace function public.effective_vault_clearance(p_vault_id citext)
returns int language sql stable security definer set search_path = public as $$
  select
    case
      -- Owner of the vault → always treated as TOP SECRET
      when exists (select 1 from public.vaults where id = p_vault_id and owner_id = auth.uid())
        then 4
      -- Member → their stored vault-internal clearance
      when exists (select 1 from public.vault_members where vault_id = p_vault_id and user_id = auth.uid())
        then coalesce((select clearance from public.vault_members where vault_id = p_vault_id and user_id = auth.uid()), 1)
      -- Visit-grant holder → max active grant
      else coalesce((
        select max(clearance) from public.vault_visit_grants
        where vault_id = p_vault_id
          and visitor_id = auth.uid()
          and expires_at > now()
          and revoked_at is null
      ), 0)
    end
$$;

-- Can the current user READ archive (vault, classification)?
create or replace function public.can_read_vault_archive(p_vault_id citext, p_classification text)
returns boolean language sql stable security definer set search_path = public as $$
  select
    -- Global admins (2-3) and O5 (4-5) can read any vault's archives
    public.user_clearance() >= 2
    or
    -- Member or grant-holder with sufficient vault-internal clearance
    public.effective_vault_clearance(p_vault_id) >= public.required_clearance(p_classification)
    or
    -- Public vault + PUBLIC classification: open to anyone
    (p_classification = 'PUBLIC'
     and exists (select 1 from public.vaults where id = p_vault_id and is_public = true))
$$;

-- Membership checks
create or replace function public.is_vault_member(p_vault_id citext)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.vault_members where vault_id = p_vault_id and user_id = auth.uid())
$$;

create or replace function public.is_vault_owner_or_admin(p_vault_id citext)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.vault_members
    where vault_id = p_vault_id and user_id = auth.uid() and role in ('owner','admin')
  )
$$;

create or replace function public.is_vault_admin(p_vault_id citext)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.vault_members
    where vault_id = p_vault_id and user_id = auth.uid() and role = 'admin'
  )
$$;

create or replace function public.vault_is_public(p_vault_id citext)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.vaults where id = p_vault_id and is_public = true)
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 11) RLS on the new tables
-- ════════════════════════════════════════════════════════════════════════════
alter table public.vaults              enable row level security;
alter table public.vault_members        enable row level security;
alter table public.vault_invites        enable row level security;
alter table public.vault_transfers      enable row level security;
alter table public.vault_visit_grants   enable row level security;
alter table public.vault_join_requests  enable row level security;

drop policy if exists vaults_read             on public.vaults;
drop policy if exists vaults_update_owner     on public.vaults;
drop policy if exists members_read            on public.vault_members;
drop policy if exists members_modify          on public.vault_members;
drop policy if exists invites_read            on public.vault_invites;
drop policy if exists invites_write           on public.vault_invites;
drop policy if exists transfers_read          on public.vault_transfers;
drop policy if exists transfers_initiate      on public.vault_transfers;
drop policy if exists transfers_resolve       on public.vault_transfers;
drop policy if exists visit_grants_read       on public.vault_visit_grants;
drop policy if exists visit_grants_write      on public.vault_visit_grants;
drop policy if exists join_requests_read      on public.vault_join_requests;
drop policy if exists join_requests_create    on public.vault_join_requests;
drop policy if exists join_requests_resolve   on public.vault_join_requests;

create policy vaults_read on public.vaults
  for select to authenticated using (
    public.user_clearance() >= 2  -- admins + O5 audit
    or public.is_vault_member(id)
    or (is_public = true)         -- outsiders can see public vault metadata
  );
create policy vaults_update_owner on public.vaults
  for update to authenticated using (owner_id = auth.uid());
-- delete: not exposed via UI; only possible via the rpc peek_delete_vault (SECURITY DEFINER)

create policy members_read on public.vault_members
  for select to authenticated using (
    user_id = auth.uid()
    or public.is_vault_member(vault_id)
    or public.user_clearance() >= 2
  );
create policy members_modify on public.vault_members
  for all to authenticated using (
    public.is_vault_owner_or_admin(vault_id)
  ) with check (
    public.is_vault_owner_or_admin(vault_id)
  );

create policy invites_read on public.vault_invites
  for select to authenticated using (
    invited_by = auth.uid()
    or public.is_vault_owner_or_admin(vault_id)
    or lower(invitee_email) = lower(coalesce(auth.jwt()->>'email',''))
    or public.user_clearance() >= 2
  );
create policy invites_write on public.vault_invites
  for all to authenticated using (
    public.is_vault_owner_or_admin(vault_id)
  ) with check (
    public.is_vault_owner_or_admin(vault_id)
  );

create policy transfers_read on public.vault_transfers
  for select to authenticated using (
    from_user_id = auth.uid()
    or to_username = lower(coalesce((select username from public.users where id = auth.uid()),''))
    or public.user_clearance() >= 2
  );

create policy visit_grants_read on public.vault_visit_grants
  for select to authenticated using (
    visitor_id = auth.uid()
    or granted_by = auth.uid()
    or public.is_vault_owner_or_admin(vault_id)
    or public.user_clearance() >= 2
  );
create policy visit_grants_write on public.vault_visit_grants
  for all to authenticated using (
    public.is_vault_owner_or_admin(vault_id)
  ) with check (
    public.is_vault_owner_or_admin(vault_id)
  );

create policy join_requests_read on public.vault_join_requests
  for select to authenticated using (
    requester_id = auth.uid()
    or public.is_vault_owner_or_admin(vault_id)
    or public.user_clearance() >= 2
  );
create policy join_requests_create on public.vault_join_requests
  for insert to authenticated with check (
    requester_id = auth.uid()
  );
create policy join_requests_resolve on public.vault_join_requests
  for update to authenticated using (
    public.is_vault_owner_or_admin(vault_id)
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 12) RLS REWRITE on archives
-- ════════════════════════════════════════════════════════════════════════════
drop policy if exists archives_read_authenticated        on public.archives;
drop policy if exists archives_insert_authenticated      on public.archives;
drop policy if exists archives_update_authenticated      on public.archives;
drop policy if exists archives_delete_authenticated      on public.archives;
drop policy if exists archives_read                      on public.archives;
drop policy if exists archives_insert                    on public.archives;
drop policy if exists archives_update                    on public.archives;
drop policy if exists archives_delete                    on public.archives;

create policy archives_read on public.archives
  for select to authenticated using (
    public.can_read_vault_archive(vault_id, classification)
  );

create policy archives_insert on public.archives
  for insert to authenticated with check (
    public.is_vault_member(vault_id)
    and public.effective_vault_clearance(vault_id) >= public.required_clearance(classification)
  );

create policy archives_update on public.archives
  for update to authenticated using (
    public.is_vault_member(vault_id)
    and public.effective_vault_clearance(vault_id) >= public.required_clearance(classification)
  );

create policy archives_delete on public.archives
  for delete to authenticated using (
    public.is_vault_owner_or_admin(vault_id)
    or created_by = auth.uid()
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 13) RLS REWRITE on messages
-- ════════════════════════════════════════════════════════════════════════════
drop policy if exists messages_read_authenticated         on public.messages;
drop policy if exists messages_insert_authenticated       on public.messages;
drop policy if exists messages_update_recipient          on public.messages;
drop policy if exists messages_read                       on public.messages;
drop policy if exists messages_insert                     on public.messages;
drop policy if exists messages_update                     on public.messages;

create policy messages_read on public.messages
  for select to authenticated using (
    public.user_clearance() >= 2  -- admins + O5 audit
    or (
      public.is_vault_member(vault_id)
      and public.effective_vault_clearance(vault_id) >= public.required_clearance(classification)
    )
    or (
      sender_id = auth.uid()  -- sender always sees their own messages
    )
    or recipient = lower(coalesce((select username from public.users where id = auth.uid()),''))
  );

create policy messages_insert on public.messages
  for insert to authenticated with check (
    public.is_vault_member(vault_id)
    and public.effective_vault_clearance(vault_id) >= public.required_clearance(classification)
    and sender_id = auth.uid()
  );

create policy messages_update on public.messages
  for update to authenticated using (
    sender_id = auth.uid()
    or recipient = lower(coalesce((select username from public.users where id = auth.uid()),''))
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 14) RPC: peek_create_vault(name, password)
--     Caller must be global admin (2-3) or O5 (4-5).
--     Creates the vault, adds caller as owner.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_create_vault(
  p_name     citext,
  p_password text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  me_level int;
  new_id citext;
  pw_hash text;
begin
  if me is null then
    return jsonb_build_object('status','denied','reason','not_authenticated');
  end if;
  me_level := public.user_clearance();
  -- Under dual-clearance: vault creation requires admin (2) or O5 (4-5).
  if me_level < 2 then
    return jsonb_build_object('status','denied','reason','insufficient_clearance',
                              'hint','global tier 2 (admin) or higher required');
  end if;
  if p_name !~ '^[a-z0-9_-]{3,32}$' then
    return jsonb_build_object('status','denied','reason','invalid_vault_name',
                              'hint','3-32 chars, lowercase a-z, 0-9, dash, underscore');
  end if;
  if p_password is not null and char_length(p_password) < 8 then
    return jsonb_build_object('status','denied','reason','weak_password',
                              'hint','min 8 chars, or omit for no password');
  end if;
  if exists (select 1 from public.vaults where owner_id = me) then
    return jsonb_build_object('status','denied','reason','already_owns_vault');
  end if;
  new_id := p_name;
  if p_password is not null then
    pw_hash := crypt(p_password, gen_salt('bf', 10));
  else
    pw_hash := null;
  end if;
  begin
    insert into public.vaults (id, display_name, owner_id, password_hash)
      values (new_id, p_name, me, pw_hash);
    insert into public.vault_members (vault_id, user_id, role, clearance)
      values (new_id, me, 'owner', 4);
  exception when unique_violation then
    return jsonb_build_object('status','denied','reason','vault_name_taken');
  end;
  perform public.write_activity(
    'create_vault', new_id,
    jsonb_build_object('display_name', p_name, 'has_password', pw_hash is not null,
                       '_forced_vault_id', new_id::text));
  return jsonb_build_object('status','ok','vault_id',new_id,'recovery_token', gen_random_uuid());
end; $$;

revoke execute on function public.peek_create_vault(citext, text) from public;
grant  execute on function public.peek_create_vault(citext, text) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 15) RPC: peek_list_my_vaults()
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_list_my_vaults()
returns table (
  vault_id citext, display_name text, role text, clearance int,
  is_public boolean, member_count bigint, joined_at timestamptz
) language sql stable security definer set search_path = public as $$
  select vm.vault_id, v.display_name, vm.role, vm.clearance,
         v.is_public,
         (select count(*) from public.vault_members m where m.vault_id = vm.vault_id),
         vm.joined_at
  from public.vault_members vm
  join public.vaults v on v.id = vm.vault_id
  where vm.user_id = auth.uid()
  order by vm.joined_at asc;
$$;

revoke execute on function public.peek_list_my_vaults() from public;
grant  execute on function public.peek_list_my_vaults() to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 16) RPC: peek_send_vault_invite(vault_id, username, role, clearance)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_send_vault_invite(
  p_vault_id citext,
  p_invitee_username citext,
  p_role text default 'member',
  p_clearance int default 1
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  invitee_id uuid;
  invitee_email text;
  inv_token uuid;
begin
  if me is null then
    return jsonb_build_object('status','denied','reason','not_authenticated');
  end if;
  if not public.is_vault_owner_or_admin(p_vault_id) then
    return jsonb_build_object('status','denied','reason','not_vault_admin');
  end if;
  if p_role not in ('admin','member') then
    return jsonb_build_object('status','denied','reason','invalid_role');
  end if;
  if p_clearance < 1 or p_clearance > 4 then
    return jsonb_build_object('status','denied','reason','invalid_clearance');
  end if;
  select u.id, au.email::text into invitee_id, invitee_email
  from public.users u
  join auth.users au on au.id = u.id
  where u.username = lower(p_invitee_username);
  if invitee_id is null then
    return jsonb_build_object('status','not_found','reason','username_does_not_exist');
  end if;
  if exists (select 1 from public.vault_members
             where vault_id = p_vault_id and user_id = invitee_id) then
    return jsonb_build_object('status','denied','reason','already_member');
  end if;
  insert into public.vault_invites (vault_id, invited_by, invitee_email, role, clearance)
  values (p_vault_id, me, invitee_email, p_role, p_clearance)
  returning token into inv_token;
  -- Send the invite as an internal mail (priority: important, classification: CONFIDENTIAL).
  -- Use the founder's vault as the message's vault if the sender has one; we pick the
  -- sender's first vault (this function is owner/admin-scoped, so they must be in the
  -- vault they're inviting TO).
  insert into public.messages (sender_id, vault_id, recipient, subject, body, priority, classification)
  values (
    me, p_vault_id, lower(p_invitee_username),
    '[VAULT INVITE] join ' || p_vault_id::text,
    'You have been invited to join vault "' || p_vault_id::text || '" as ' || p_role ||
      ' (vault-internal clearance ' || p_clearance || ').' || E'\n\n' ||
      'INVITE TOKEN: ' || inv_token::text || E'\n\n' ||
      'Use "acceptinvite <token>" to join, or click ACCEPT in the mail view.',
    'important', 'CONFIDENTIAL'
  );
  perform public.write_activity(
    'invite', p_vault_id,
    jsonb_build_object('invitee', p_invitee_username, 'role', p_role,
                       'clearance', p_clearance, 'token', inv_token));
  return jsonb_build_object('status','ok','token',inv_token,'invitee',lower(p_invitee_username));
end; $$;

revoke execute on function public.peek_send_vault_invite(citext, citext, text, int) from public;
grant  execute on function public.peek_send_vault_invite(citext, citext, text, int) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 17) RPC: peek_accept_vault_invite(token)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_accept_vault_invite(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  me_email text;
  inv public.vault_invites%rowtype;
begin
  if me is null then
    return jsonb_build_object('status','denied','reason','not_authenticated');
  end if;
  select email::text into me_email from auth.users where id = me;
  select * into inv from public.vault_invites where token = p_token;
  if inv is null then
    return jsonb_build_object('status','not_found','reason','invite_not_found');
  end if;
  if inv.accepted_at is not null then
    return jsonb_build_object('status','denied','reason','already_accepted');
  end if;
  if inv.expires_at < now() then
    return jsonb_build_object('status','denied','reason','expired');
  end if;
  if lower(inv.invitee_email) <> lower(me_email) then
    return jsonb_build_object('status','denied','reason','not_addressed_to_you');
  end if;
  update public.vault_invites set accepted_at = now() where token = p_token;
  insert into public.vault_members (vault_id, user_id, role, clearance)
  values (inv.vault_id, me, inv.role, inv.clearance)
  on conflict (vault_id, user_id) do update
    set role = excluded.role, clearance = excluded.clearance;
  perform public.write_activity(
    'join_vault', inv.vault_id::text,
    jsonb_build_object('role', inv.role, 'clearance', inv.clearance));
  return jsonb_build_object('status','ok','vault_id',inv.vault_id,'role',inv.role);
end; $$;

revoke execute on function public.peek_accept_vault_invite(uuid) from public;
grant  execute on function public.peek_accept_vault_invite(uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 18) RPC: peek_list_vault_invites(vault_id)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_list_vault_invites(p_vault_id citext)
returns table (
  token uuid, invitee_email citext, role text, clearance int,
  created_at timestamptz, expires_at timestamptz, accepted_at timestamptz
) language sql stable security definer set search_path = public as $$
  select token, invitee_email, role, clearance, created_at, expires_at, accepted_at
  from public.vault_invites
  where vault_id = p_vault_id
  order by created_at desc;
$$;

revoke execute on function public.peek_list_vault_invites(citext) from public;
grant  execute on function public.peek_list_vault_invites(citext) to authenticated;

-- ═══════════════════════════════════════════════════════════════���════════════
-- 19) RPC: peek_set_vault_member(vault_id, target, role, clearance)
--     Owner unrestricted. Admin capped by own clearance.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_set_vault_member(
  p_vault_id citext,
  p_target_user_id uuid,
  p_role text,
  p_clearance int
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me_role text;
  my_clearance int;
  target_role text;
begin
  select role, clearance into me_role, my_clearance
    from public.vault_members
   where vault_id = p_vault_id and user_id = auth.uid();
  if me_role is null then
    return jsonb_build_object('status','denied','reason','not_a_member');
  end if;
  if me_role = 'member' then
    return jsonb_build_object('status','denied','reason','insufficient_role','hint','admin or owner required');
  end if;
  if p_role not in ('owner','admin','member') then
    return jsonb_build_object('status','denied','reason','invalid_role');
  end if;
  if p_clearance < 1 or p_clearance > 4 then
    return jsonb_build_object('status','denied','reason','invalid_clearance');
  end if;
  -- Admin cap: cannot grant clearance higher than their own clearance
  if me_role = 'admin' and p_clearance > my_clearance then
    return jsonb_build_object('status','denied','reason','clearance_exceeds_admin',
                              'your_clearance', my_clearance, 'requested', p_clearance);
  end if;
  -- Refuse to demote the owner
  select role into target_role from public.vault_members
   where vault_id = p_vault_id and user_id = p_target_user_id;
  if target_role = 'owner' and p_role <> 'owner' then
    return jsonb_build_object('status','denied','reason','cannot_demote_owner');
  end if;
  update public.vault_members
    set role = p_role, clearance = p_clearance
  where vault_id = p_vault_id and user_id = p_target_user_id;
  if not found then
    return jsonb_build_object('status','not_found','reason','not_a_member');
  end if;
  perform public.write_activity(
    'set_member', p_vault_id::text,
    jsonb_build_object('target_user', p_target_user_id,
                       'role', p_role, 'clearance', p_clearance));
  return jsonb_build_object('status','ok');
end; $$;

revoke execute on function public.peek_set_vault_member(citext, uuid, text, int) from public;
grant  execute on function public.peek_set_vault_member(citext, uuid, text, int) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 20) RPC: peek_remove_vault_member(vault_id, target) — "fire"
--     Admin/owner. Cannot fire the owner. Admin cannot fire other admins.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_remove_vault_member(
  p_vault_id citext,
  p_target_user_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me_role text;
  target_role text;
begin
  select role into me_role from public.vault_members
   where vault_id = p_vault_id and user_id = auth.uid();
  if me_role is null or me_role = 'member' then
    return jsonb_build_object('status','denied','reason','insufficient_role');
  end if;
  select role into target_role from public.vault_members
   where vault_id = p_vault_id and user_id = p_target_user_id;
  if target_role is null then
    return jsonb_build_object('status','not_found','reason','not_a_member');
  end if;
  if target_role = 'owner' then
    return jsonb_build_object('status','denied','reason','cannot_fire_owner');
  end if;
  if me_role = 'admin' and target_role = 'admin' and p_target_user_id <> auth.uid() then
    return jsonb_build_object('status','denied','reason','admin_cannot_fire_admin');
  end if;
  delete from public.vault_members
   where vault_id = p_vault_id and user_id = p_target_user_id;
  perform public.write_activity(
    'fire', p_vault_id::text,
    jsonb_build_object('target_user', p_target_user_id, 'former_role', target_role));
  return jsonb_build_object('status','ok');
end; $$;

revoke execute on function public.peek_remove_vault_member(citext, uuid) from public;
grant  execute on function public.peek_remove_vault_member(citext, uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 21) RPC: peek_delete_vault(vault_id)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_delete_vault(p_vault_id citext)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  is_owner boolean;
  has_data boolean;
begin
  select (owner_id = me) into is_owner from public.vaults where id = p_vault_id;
  if not is_owner then
    return jsonb_build_object('status','denied','reason','not_owner');
  end if;
  select (exists (select 1 from public.archives where vault_id = p_vault_id)
       or exists (select 1 from public.messages where vault_id = p_vault_id))
    into has_data;
  if has_data then
    return jsonb_build_object('status','denied','reason','vault_not_empty',
                              'hint','delete all archives and messages first');
  end if;
  delete from public.vaults where id = p_vault_id;
  perform public.write_activity('delete_vault', p_vault_id::text, '{}'::jsonb);
  return jsonb_build_object('status','ok');
end; $$;

revoke execute on function public.peek_delete_vault(citext) from public;
grant  execute on function public.peek_delete_vault(citext) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 22) RPC: peek_reset_vault_password(vault_id, old_pw, new_pw)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_reset_vault_password(
  p_vault_id citext,
  p_old_password text,
  p_new_password text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  is_owner boolean;
  stored_hash text;
begin
  select (owner_id = me) into is_owner from public.vaults where id = p_vault_id;
  if not is_owner then
    return jsonb_build_object('status','denied','reason','not_owner');
  end if;
  if p_new_password is null or char_length(p_new_password) < 8 then
    return jsonb_build_object('status','denied','reason','weak_password');
  end if;
  select password_hash into stored_hash from public.vaults where id = p_vault_id;
  if stored_hash is not null then
    -- Verify old password if a password is currently set
    if crypt(p_old_password, stored_hash) <> stored_hash then
      return jsonb_build_object('status','denied','reason','wrong_old_password');
    end if;
  end if;
  update public.vaults
    set password_hash = crypt(p_new_password, gen_salt('bf', 10))
  where id = p_vault_id;
  perform public.write_activity('reset_vault_password', p_vault_id::text, '{}'::jsonb);
  return jsonb_build_object('status','ok');
end; $$;

revoke execute on function public.peek_reset_vault_password(citext, text, text) from public;
grant  execute on function public.peek_reset_vault_password(citext, text, text) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 23) RPC: peek_create_transfer(vault_id, target_username)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_create_transfer(
  p_vault_id citext,
  p_target_username citext
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  target_id uuid;
  target_email text;
  tok uuid;
begin
  -- Check ownership
  if not exists (select 1 from public.vaults where id = p_vault_id and owner_id = me) then
    return jsonb_build_object('status','denied','reason','not_owner');
  end if;
  select u.id, au.email::text into target_id, target_email
  from public.users u join auth.users au on au.id = u.id
  where u.username = lower(p_target_username);
  if target_id is null then
    return jsonb_build_object('status','not_found','reason','username_does_not_exist');
  end if;
  if target_id = me then
    return jsonb_build_object('status','denied','reason','cannot_transfer_to_self');
  end if;
  -- Target must not already own another vault (per plan §3 transfer rules)
  if exists (select 1 from public.vaults where owner_id = target_id) then
    return jsonb_build_object('status','denied','reason','target_already_owns_vault',
                              'hint','a vault owner can only own one vault at a time');
  end if;
  insert into public.vault_transfers (vault_id, from_user_id, to_username)
  values (p_vault_id, me, lower(p_target_username))
  returning token into tok;
  -- Send mail to target
  insert into public.messages (sender_id, vault_id, recipient, subject, body, priority, classification)
  values (
    me, p_vault_id, lower(p_target_username),
    '[VAULT TRANSFER] ownership of ' || p_vault_id::text,
    'You have been offered ownership of vault "' || p_vault_id::text || '".' || E'\n\n' ||
      'TRANSFER TOKEN: ' || tok::text || E'\n\n' ||
      'Use "accepttransfer" to become the owner (the previous owner will lose access), ' ||
      'or "declinetransfer" to refuse.',
    'urgent', 'CONFIDENTIAL'
  );
  perform public.write_activity('transfer_init', p_vault_id::text,
    jsonb_build_object('to', p_target_username, 'token', tok));
  return jsonb_build_object('status','ok','token',tok);
end; $$;

revoke execute on function public.peek_create_transfer(citext, citext) from public;
grant  execute on function public.peek_create_transfer(citext, citext) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 24) RPC: peek_accept_transfer(token)
--     Target only. On accept: original owner is REMOVED from vault_members,
--     vault.owner_id is set to target, target is inserted as owner.
-- ═════════════════════════════════════════════════════��══════════════════════
create or replace function public.peek_accept_transfer(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_username citext;
  tr public.vault_transfers%rowtype;
begin
  if me is null then
    return jsonb_build_object('status','denied','reason','not_authenticated');
  end if;
  select username into my_username from public.users where id = me;
  select * into tr from public.vault_transfers where token = p_token;
  if tr is null then
    return jsonb_build_object('status','not_found','reason','transfer_not_found');
  end if;
  if tr.status <> 'pending' then
    return jsonb_build_object('status','denied','reason', tr.status);
  end if;
  if tr.expires_at < now() then
    update public.vault_transfers set status='expired', resolved_at=now() where token = p_token;
    return jsonb_build_object('status','denied','reason','expired');
  end if;
  if tr.to_username <> lower(my_username) then
    return jsonb_build_object('status','denied','reason','not_addressed_to_you');
  end if;
  -- Lock the vault row to prevent races
  perform 1 from public.vaults where id = tr.vault_id for update;
  -- Check target doesn't already own a vault (race protection)
  if exists (select 1 from public.vaults where owner_id = me) then
    return jsonb_build_object('status','denied','reason','target_already_owns_vault');
  end if;
  -- Atomic transfer: remove old owner membership, change vault owner, add new owner membership
  delete from public.vault_members where vault_id = tr.vault_id and user_id = tr.from_user_id;
  update public.vaults set owner_id = me where id = tr.vault_id;
  insert into public.vault_members (vault_id, user_id, role, clearance)
  values (tr.vault_id, me, 'owner', 4)
  on conflict (vault_id, user_id) do update set role='owner';
  update public.vault_transfers set status='accepted', resolved_at=now() where token = p_token;
  perform public.write_activity('transfer_accept', tr.vault_id::text,
    jsonb_build_object('from_user', tr.from_user_id, 'to_user', me));
  return jsonb_build_object('status','ok','vault_id',tr.vault_id);
end; $$;

revoke execute on function public.peek_accept_transfer(uuid) from public;
grant  execute on function public.peek_accept_transfer(uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 25) RPC: peek_decline_transfer(token)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_decline_transfer(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_username citext;
  tr public.vault_transfers%rowtype;
begin
  select username into my_username from public.users where id = me;
  select * into tr from public.vault_transfers where token = p_token;
  if tr is null then
    return jsonb_build_object('status','not_found','reason','transfer_not_found');
  end if;
  if tr.to_username <> lower(my_username) then
    return jsonb_build_object('status','denied','reason','not_addressed_to_you');
  end if;
  update public.vault_transfers set status='declined', resolved_at=now() where token = p_token;
  perform public.write_activity('transfer_decline', tr.vault_id::text,
    jsonb_build_object('by', me));
  return jsonb_build_object('status','ok');
end; $$;

revoke execute on function public.peek_decline_transfer(uuid) from public;
grant  execute on function public.peek_decline_transfer(uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 26) RPC: peek_set_vault_public(vault_id, is_public)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_set_vault_public(p_vault_id citext, p_is_public boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  is_owner boolean;
begin
  select (owner_id = me) into is_owner from public.vaults where id = p_vault_id;
  if not is_owner then
    return jsonb_build_object('status','denied','reason','not_owner');
  end if;
  update public.vaults set is_public = p_is_public where id = p_vault_id;
  perform public.write_activity('set_vault_public', p_vault_id::text,
    jsonb_build_object('is_public', p_is_public));
  return jsonb_build_object('status','ok');
end; $$;

revoke execute on function public.peek_set_vault_public(citext, boolean) from public;
grant  execute on function public.peek_set_vault_public(citext, boolean) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 27) RPC: peek_grant_visit(vault_id, username, clearance, hours)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_grant_visit(
  p_vault_id citext,
  p_username citext,
  p_clearance int,
  p_hours int
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  visitor uuid;
begin
  if not public.is_vault_owner_or_admin(p_vault_id) then
    return jsonb_build_object('status','denied','reason','not_vault_admin');
  end if;
  if p_clearance < 1 or p_clearance > 4 then
    return jsonb_build_object('status','denied','reason','invalid_clearance');
  end if;
  if p_hours < 1 or p_hours > 720 then
    return jsonb_build_object('status','denied','reason','invalid_hours','hint','1-720');
  end if;
  select id into visitor from public.users where username = lower(p_username);
  if visitor is null then
    return jsonb_build_object('status','not_found','reason','username_does_not_exist');
  end if;
  insert into public.vault_visit_grants (vault_id, visitor_id, granted_by, clearance, expires_at)
  values (p_vault_id, visitor, me, p_clearance, now() + (p_hours || ' hours')::interval)
  on conflict (vault_id, visitor_id) do update
    set granted_by = me, clearance = p_clearance,
        expires_at = now() + (p_hours || ' hours')::interval,
        revoked_at = null;
  -- Notify visitor via mail
  insert into public.messages (sender_id, vault_id, recipient, subject, body, priority, classification)
  values (
    me, p_vault_id, lower(p_username),
    '[VISIT GRANT] access to ' || p_vault_id::text,
    'You have been granted temporary access to vault "' || p_vault_id::text || '".' || E'\n\n' ||
      'CLEARANCE: ' || p_clearance || E'\n' ||
      'EXPIRES IN: ' || p_hours || ' hours',
    'normal', 'CONFIDENTIAL'
  );
  perform public.write_activity('visit_grant', p_vault_id::text,
    jsonb_build_object('visitor', p_username, 'clearance', p_clearance,
                       'hours', p_hours));
  return jsonb_build_object('status','ok');
end; $$;

revoke execute on function public.peek_grant_visit(citext, citext, int, int) from public;
grant  execute on function public.peek_grant_visit(citext, citext, int, int) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 28) RPC: peek_revoke_visit(vault_id, username)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_revoke_visit(
  p_vault_id citext,
  p_username citext
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  visitor uuid;
begin
  if not public.is_vault_owner_or_admin(p_vault_id) then
    return jsonb_build_object('status','denied','reason','not_vault_admin');
  end if;
  select id into visitor from public.users where username = lower(p_username);
  if visitor is null then
    return jsonb_build_object('status','not_found','reason','username_does_not_exist');
  end if;
  update public.vault_visit_grants
    set revoked_at = now()
  where vault_id = p_vault_id and visitor_id = visitor;
  perform public.write_activity('visit_revoke', p_vault_id::text,
    jsonb_build_object('visitor', p_username));
  return jsonb_build_object('status','ok');
end; $$;

revoke execute on function public.peek_revoke_visit(citext, citext) from public;
grant  execute on function public.peek_revoke_visit(citext, citext) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 29) RPC: peek_list_visit_grants(vault_id)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_list_visit_grants(p_vault_id citext)
returns table (
  username citext, clearance int, granted_at timestamptz, expires_at timestamptz, revoked boolean
) language sql stable security definer set search_path = public as $$
  select u.username, g.clearance, g.created_at, g.expires_at, g.revoked_at is not null
  from public.vault_visit_grants g
  join public.users u on u.id = g.visitor_id
  where g.vault_id = p_vault_id
  order by g.created_at desc;
$$;

revoke execute on function public.peek_list_visit_grants(citext) from public;
grant  execute on function public.peek_list_visit_grants(citext) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 30) RPC: peek_create_join_request(vault_id, message)
--     Outsider only — caller must NOT already be a member.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_create_join_request(
  p_vault_id citext,
  p_message text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  req_id uuid;
begin
  if me is null then
    return jsonb_build_object('status','denied','reason','not_authenticated');
  end if;
  if exists (select 1 from public.vault_members where vault_id = p_vault_id and user_id = me) then
    return jsonb_build_object('status','denied','reason','already_a_member');
  end if;
  if exists (select 1 from public.vault_join_requests
             where vault_id = p_vault_id and requester_id = me and status = 'pending') then
    return jsonb_build_object('status','denied','reason','request_already_pending');
  end if;
  begin
    insert into public.vault_join_requests (vault_id, requester_id, message)
    values (p_vault_id, me, p_message)
    returning id into req_id;
  exception when unique_violation then
    return jsonb_build_object('status','denied','reason','request_already_pending');
  end;
  -- Notify all owner/admins via mail
  insert into public.messages (sender_id, vault_id, recipient, subject, body, priority, classification)
  select
    me, p_vault_id, u.username,
    '[JOIN REQUEST] ' || p_vault_id::text,
    'Operator has applied to join your vault.' || E'\n\n' ||
      'REQUEST ID: ' || req_id::text || E'\n\n' ||
      coalesce('MESSAGE: ' || p_message || E'\n\n', '') ||
      'Use "approvejoin <request_id>" or "declinejoin <request_id>" to respond.',
    'important', 'CONFIDENTIAL'
  from public.vault_members m join public.users u on u.id = m.user_id
   where m.vault_id = p_vault_id and m.role in ('owner','admin');
  perform public.write_activity('join_request', p_vault_id::text,
    jsonb_build_object('requester', me, 'request_id', req_id));
  return jsonb_build_object('status','ok','request_id',req_id);
end; $$;

revoke execute on function public.peek_create_join_request(citext, text) from public;
grant  execute on function public.peek_create_join_request(citext, text) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 31) RPC: peek_list_join_requests(vault_id)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_list_join_requests(p_vault_id citext)
returns table (
  request_id uuid, requester_email citext, requester_username citext,
  message text, status text, created_at timestamptz
) language sql stable security definer set search_path = public as $$
  select r.id, lower(au.email)::citext, u.username::citext, r.message, r.status, r.created_at
  from public.vault_join_requests r
  join public.users u on u.id = r.requester_id
  join auth.users au on au.id = r.requester_id
  where r.vault_id = p_vault_id
  order by r.created_at desc;
$$;

revoke execute on function public.peek_list_join_requests(citext) from public;
grant  execute on function public.peek_list_join_requests(citext) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 32) RPC: peek_resolve_join_request(request_id, approve)
--     Approve: insert into vault_members as 'member' (clearance=1), invalidate.
--     Decline: just mark declined.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_resolve_join_request(
  p_request_id uuid,
  p_approve boolean
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  req public.vault_join_requests%rowtype;
  requester_email text;
  requester_username citext;
begin
  select * into req from public.vault_join_requests where id = p_request_id;
  if req is null then
    return jsonb_build_object('status','not_found','reason','request_not_found');
  end if;
  if req.status <> 'pending' then
    return jsonb_build_object('status','denied','reason', 'request_' || req.status);
  end if;
  if not public.is_vault_owner_or_admin(req.vault_id) then
    return jsonb_build_object('status','denied','reason','not_vault_admin');
  end if;
  select u.username, au.email::text into requester_username, requester_email
    from public.users u join auth.users au on au.id = u.id
   where u.id = req.requester_id;
  if p_approve then
    insert into public.vault_members (vault_id, user_id, role, clearance)
    values (req.vault_id, req.requester_id, 'member', 1)
    on conflict (vault_id, user_id) do nothing;
  end if;
  update public.vault_join_requests
    set status = case when p_approve then 'approved' else 'declined' end,
        resolved_by = me,
        resolved_at = now()
  where id = p_request_id;
  -- If approve: invalidate any other pending requests from same requester for same vault
  if p_approve then
    update public.vault_join_requests
      set status = 'expired', resolved_at = now()
    where vault_id = req.vault_id
      and requester_id = req.requester_id
      and status = 'pending'
      and id <> p_request_id;
  end if;
  -- Notify requester
  insert into public.messages (sender_id, vault_id, recipient, subject, body, priority, classification)
  values (
    me, req.vault_id, lower(requester_username),
    '[JOIN REQUEST] ' || case when p_approve then 'APPROVED' else 'DECLINED' end,
    'Your join request for vault "' || req.vault_id::text || '" was ' ||
      case when p_approve then 'approved. You are now a member.' else 'declined.' end,
    'normal', 'CONFIDENTIAL'
  );
  perform public.write_activity(
    case when p_approve then 'join_request_approve' else 'join_request_decline' end,
    req.vault_id::text,
    jsonb_build_object('request_id', p_request_id, 'requester', requester_username));
  return jsonb_build_object('status','ok');
end; $$;

revoke execute on function public.peek_resolve_join_request(uuid, boolean) from public;
grant  execute on function public.peek_resolve_join_request(uuid, boolean) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 33) Extend peek_send_message to take a vault_id (required for vault scope)
--     Falls back to "broadcast" mode if recipient='all' (for O5 only).
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_send_message(
  p_recipient      citext,
  p_subject        text,
  p_body           text,
  p_priority       text,
  p_classification text,
  p_vault_id       citext default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  me_level int;
  req int;
  rid uuid;
  rec record;
  new_id uuid;
  broadcast_count int := 0;
  final_subject text;
  effective_vault citext;
begin
  if me is null then
    return jsonb_build_object('status','denied','reason','not_authenticated');
  end if;
  me_level := public.user_clearance();
  req := public.required_clearance(p_classification);
  if req > me_level then
    return jsonb_build_object('status','denied','reason','insufficient_clearance',
                              'required',req,'have',me_level);
  end if;
  if p_priority not in ('normal','important','urgent','o5') then
    return jsonb_build_object('status','denied','reason','invalid_priority');
  end if;
  -- O5 broadcast path (recipient='all'): one row per vault the caller is in.
  if lower(p_recipient) = 'all' then
    if me_level < 4 then
      return jsonb_build_object('status','denied','reason','o5_only');
    end if;
    p_priority := 'o5';
    final_subject := '[O5 BROADCAST] ' || coalesce(p_subject,'');
    for rec in
      select distinct vm.vault_id as vid
      from public.vault_members vm
      where vm.user_id = me
    loop
      effective_vault := rec.vid;
      insert into public.messages (sender_id, vault_id, recipient, subject, body, priority, classification)
      values (me, effective_vault, '*', final_subject, p_body, p_priority, p_classification);
      broadcast_count := broadcast_count + 1;
    end loop;
    return jsonb_build_object('status','ok','broadcast', broadcast_count,
                              'subject', final_subject, 'priority', p_priority);
  end if;
  -- Single-recipient path: vault is required
  effective_vault := p_vault_id;
  if effective_vault is null then
    select vm.vault_id into effective_vault
    from public.vault_members vm where vm.user_id = me limit 1;
  end if;
  if effective_vault is null then
    return jsonb_build_object('status','denied','reason','no_active_vault');
  end if;
  if not public.is_vault_member(effective_vault) then
    return jsonb_build_object('status','denied','reason','not_in_vault');
  end if;
  if public.effective_vault_clearance(effective_vault) < req then
    return jsonb_build_object('status','denied','reason','insufficient_vault_clearance',
                              'required',req,'have',public.effective_vault_clearance(effective_vault));
  end if;
  select id into rid from public.users where username = lower(p_recipient);
  if rid is null then
    return jsonb_build_object('status','not_found','reason','recipient_does_not_exist');
  end if;
  if not public.is_vault_member(effective_vault) then
    return jsonb_build_object('status','denied','reason','recipient_not_in_vault');
  end if;
  insert into public.messages (sender_id, vault_id, recipient, subject, body, priority, classification)
  values (me, effective_vault, lower(p_recipient), coalesce(p_subject,''), p_body, p_priority, p_classification)
  returning id into new_id;
  return jsonb_build_object('status','ok','id',new_id,'recipient',lower(p_recipient),'vault_id',effective_vault);
end; $$;

revoke execute on function public.peek_send_message(citext, text, text, text, text, citext) from public;
grant  execute on function public.peek_send_message(citext, text, text, text, text, citext) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 34) Vault-scoped archive lookup
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_all_archives_vault(p_vault_id citext, p_limit int default 200)
returns table (
  id uuid, archive_number text, title text, classification text,
  department text, created_at timestamptz, updated_at timestamptz
) language sql stable security definer set search_path = public as $$
  select a.id, a.archive_number, a.title, a.classification,
         a.department, a.created_at, a.updated_at
  from public.archives a
  where a.vault_id = p_vault_id
    and public.can_read_vault_archive(p_vault_id, a.classification)
  order by a.archive_number
  limit p_limit;
$$;

revoke execute on function public.peek_all_archives_vault(citext, int) from public;
grant  execute on function public.peek_all_archives_vault(citext, int) to authenticated;

-- (peek_all_archives remains as the global O5 cross-vault view, unchanged)
-- ════════════════════════════════════════════════════════════════════════════
-- 35) Vault-scope existing peek_inbox / peek_sent
--     Originally defined in migration_002 (single-arg). Replaced with
--     versions that take p_vault_id and filter rows accordingly. NULL
--     p_vault_id falls back to the user's first vault (legacy behaviour).
-- ════════════════════════════════════════════════════════════════════════════
drop function if exists public.peek_inbox(citext);
create function public.peek_inbox(p_username citext, p_vault_id citext default null)
returns table (
  id uuid, subject text, body text, priority text, classification text,
  sender_email text, sender_username citext,
  read_at timestamptz, created_at timestamptz, vault_id citext
) language sql stable security definer set search_path = public as $$
  select m.id, m.subject, m.body, m.priority, m.classification,
         au.email::text as sender_email,
         s.username as sender_username,
         m.read_at, m.created_at, m.vault_id
  from public.messages m
  left join auth.users au on au.id = m.sender_id
  left join public.users s on s.id = m.sender_id
  where m.recipient = lower(p_username)
    and (p_vault_id is null or m.vault_id = p_vault_id)
    and (
      public.user_clearance() >= 2
      or public.is_vault_member(coalesce(p_vault_id, m.vault_id))
      or (
        m.classification = 'PUBLIC'
        and public.vault_is_public(coalesce(p_vault_id, m.vault_id))
      )
    )
  order by m.created_at desc
  limit 200;
$$;

revoke execute on function public.peek_inbox(citext, citext) from public;
grant  execute on function public.peek_inbox(citext, citext) to authenticated;

drop function if exists public.peek_sent(uuid);
create function public.peek_sent(p_userid uuid, p_vault_id citext default null)
returns table (
  id uuid, subject text, body text, priority text, classification text,
  recipient citext, read_at timestamptz, created_at timestamptz, vault_id citext
) language sql stable security definer set search_path = public as $$
  select m.id, m.subject, m.body, m.priority, m.classification,
         m.recipient, m.read_at, m.created_at, m.vault_id
  from public.messages m
  where m.sender_id = p_userid
    and (p_vault_id is null or m.vault_id = p_vault_id)
    and (
      public.user_clearance() >= 2
      or public.is_vault_member(coalesce(p_vault_id, m.vault_id))
    )
  order by m.created_at desc
  limit 200;
$$;

revoke execute on function public.peek_sent(uuid, citext) from public;
grant  execute on function public.peek_sent(uuid, citext) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 36) DROP the old 5-arg peek_send_message overload
--     The 6-arg version above (with p_vault_id) supersedes it. The 5-arg
--     version would now be a security hole (every send is unscoped to
--     a vault). Keeping both also makes PostgREST ambiguous about which
--     to call when a default null is passed for p_vault_id.
-- ════════════════════════════════════════════════════════════════════════════
drop function if exists public.peek_send_message(citext, text, text, text, text);

-- ════════════════════════════════════════════════════════════════════════════
-- 37) Public vault browser RPCs (added after the initial migration_006
--     so the VAULTS tab can show discoverable vaults to outsiders).
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.peek_list_public_vaults()
returns table (
  id citext, display_name text, owner_display text,
  member_count bigint, public_archive_count bigint, created_at timestamptz
) language sql stable security definer set search_path = public as $$
  select v.id, v.display_name,
         coalesce(p.username::text, split_part(au.email::text,'@',1)) as owner_display,
         (select count(*) from public.vault_members m where m.vault_id = v.id) as member_count,
         (select count(*) from public.archives a where a.vault_id = v.id and a.classification = 'PUBLIC') as public_archive_count,
         v.created_at
  from public.vaults v
  left join public.users p on p.id = v.owner_id
  left join auth.users au on au.id = v.owner_id
  where v.is_public = true
  order by v.created_at asc;
$$;

revoke execute on function public.peek_list_public_vaults() from public;
grant  execute on function public.peek_list_public_vaults() to authenticated;

create or replace function public.peek_get_vault_public_info(p_vault_id citext)
returns jsonb language sql stable security definer set search_path = public as $$
  with v as (select id, display_name, owner_id, is_public, created_at from public.vaults where id = p_vault_id),
       is_member as (select exists (select 1 from public.vault_members
                                      where vault_id = p_vault_id and user_id = auth.uid()) as ok)
  select case
    when not exists (select 1 from v) then null
    when not ((select is_public from v) or (select ok from is_member)) then null
    else jsonb_build_object(
      'id', (select id from v),
      'display_name', (select display_name from v),
      'is_public', (select is_public from v),
      'owner_display', coalesce(
        (select p.username::text from public.users p where p.id = (select owner_id from v)),
        (select split_part(au.email::text,'@',1) from auth.users au where au.id = (select owner_id from v))
      ),
      'member_count', (select count(*) from public.vault_members m where m.vault_id = p_vault_id),
      'public_archive_count', (select count(*) from public.archives a where a.vault_id = p_vault_id and a.classification = 'PUBLIC'),
      'my_role', (select role::text from public.vault_members where vault_id = p_vault_id and user_id = auth.uid()),
      'my_clearance', (select clearance from public.vault_members where vault_id = p_vault_id and user_id = auth.uid()),
      'pending_request_id', (select id::text from public.vault_join_requests
                               where vault_id = p_vault_id and requester_id = auth.uid() and status = 'pending'),
      'created_at', (select created_at from v)
    )
  end
$$;

revoke execute on function public.peek_get_vault_public_info(citext) from public;
grant  execute on function public.peek_get_vault_public_info(citext) to authenticated;

create or replace function public.peek_list_public_archives_of_vault(p_vault_id citext, p_limit int default 100)
returns table (id uuid, archive_number text, title text, department text,
              created_at timestamptz, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select a.id, a.archive_number, a.title, a.department, a.created_at, a.updated_at
  from public.archives a
  join public.vaults v on v.id = a.vault_id
  where a.vault_id = p_vault_id
    and a.classification = 'PUBLIC'
    and (v.is_public = true or public.is_vault_member(p_vault_id))
  order by a.archive_number
  limit p_limit;
$$;

revoke execute on function public.peek_list_public_archives_of_vault(citext, int) from public;
grant  execute on function public.peek_list_public_archives_of_vault(citext, int) to authenticated;