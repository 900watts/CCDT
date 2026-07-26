-- ============================================================================
--  CCDT (Corporate Central Data Terminal) — Supabase schema
--  Run this in: Supabase Dashboard -> SQL Editor -> "New query" -> Run
-- ============================================================================

-- 1) The archives table (the "dossiers" you open with:  access <number>)
--    NOTE: column set is a sensible default. If you have an exact field list,
--    adjust the columns below and the dossier renderer in src/App.jsx.
create table if not exists public.archives (
  id              uuid primary key default gen_random_uuid(),
  archive_number  text unique not null,
  title           text not null,
  classification  text not null default 'PUBLIC'
                    check (classification in ('PUBLIC','CONFIDENTIAL','SECRET','TOP SECRET')),
  department      text,
  content         text,
  tags            text[] default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists archives_number_idx on public.archives (archive_number);
create index if not exists archives_title_idx on public.archives using gin (to_tsvector('simple', title));
create index if not exists archives_class_idx on public.archives (classification);

-- 2) Row Level Security + CLEARANCE MODEL
alter table public.archives enable row level security;

-- classification -> minimum clearance level required to READ it (1 PUBLIC … 4 TOP SECRET)
create or replace function public.required_clearance(p_class text)
returns int language sql immutable as $$
  select case coalesce(p_class,'')
    when 'PUBLIC' then 1
    when 'CONFIDENTIAL' then 2
    when 'SECRET' then 3
    when 'TOP SECRET' then 4
    else 1 end;
$$;

-- current operator's clearance level (from auth user_metadata.clearance_level; default 1)
create or replace function public.user_clearance()
returns int language sql stable security definer set search_path = public as $$
  select coalesce((raw_user_meta_data->>'clearance_level')::int, 1)
  from auth.users where id = auth.uid();
$$;

-- Reading: only archives whose required level <= the operator's clearance.
-- This is the REAL enforcement that was missing before: a level-2 operator can
-- no longer open a level-4 / TOP SECRET document.
drop policy if exists "archives_read_authenticated" on public.archives;
create policy "archives_read_clearance"
  on public.archives for select
  to authenticated
  using ( public.required_clearance(classification) <= public.user_clearance() );

-- Writing (insert/update/delete) — open to any authenticated operator for v1.
-- Tighten later (e.g. require clearance >= 2) when you have roles.
drop policy if exists "archives_write_authenticated" on public.archives;
create policy "archives_write_authenticated"
  on public.archives for all
  to authenticated
  using (true)
  with check (true);

-- access_archive(p_num): SECURITY DEFINER RPC returning a precise status
-- (ok / not_found / denied) so the terminal can show the right message.
-- It runs as the table owner (superuser) and bypasses RLS, applying the
-- clearance check itself using the CALLER's auth identity.
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
  return jsonb_build_object('status','ok','data', to_jsonb(rec));
end;
$$;

revoke execute on function public.access_archive(text) from public;
grant execute on function public.access_archive(text) to authenticated;

-- 3) Keep updated_at fresh
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists archives_set_updated_at on public.archives;
create trigger archives_set_updated_at
  before update on public.archives
  for each row execute function public.set_updated_at();

-- 4) Sample data (replace with your real archives)
insert into public.archives (archive_number, title, classification, department, content, tags)
values
  ('001', 'Project Onboarding Dossier', 'PUBLIC', 'Human Resources',
   'Standard onboarding record for new personnel. Covers badge issuance, network access, and mandatory briefings.',
   array['hr','onboarding']),
  ('173', 'Incident Report — Unattended Output Device', 'CONFIDENTIAL', 'Facilities',
   'A floor printer continued producing documents after logout. Investigation inconclusive; recommend power-down policy revision.',
   array['facilities','incident']),
  ('682', 'Legacy System Decommission Plan', 'SECRET', 'Information Technology',
   'Phased shutdown of the 2009 records mainframe. Data migration to the Supabase archive completed 2026-Q2.',
   array['it','migration','infra']),
  ('900', 'Executive Continuity Protocol', 'TOP SECRET', 'Office of the Director',
   'Succession and continuity plan, activated only on director-level trigger. Contains physical vault coordinates and recall codes.',
   array['director','continuity','vault'])
on conflict (archive_number) do nothing;

-- ============================================================================
--  ACCOUNTS / PASSWORDS
--  Supabase Auth handles users & password hashing — do NOT store passwords yourself.
--  Create operators via:
--    Supabase Dashboard -> Authentication -> Users -> "Add user"
--  (Email/Password is enabled by default. Disable "Confirm email" if you want
--   instant login during testing.)
-- ============================================================================
