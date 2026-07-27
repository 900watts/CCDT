-- ============================================================================
--  CCDT migration 001 — created_by column + delete RPCs
--  Adds creator tracking so `delete <num>` can authorize by "you made it"
--  OR "your clearance >= the record's required clearance".
--  Idempotent; safe to re-run.
-- ============================================================================

-- 1) created_by column + index
alter table public.archives add column if not exists created_by uuid references auth.users(id);
create index if not exists archives_created_by_idx on public.archives (created_by);

-- 2) BEFORE INSERT trigger stamps created_by = auth.uid() (client can't spoof)
create or replace function public.set_created_by()
returns trigger language plpgsql as $$
begin
  new.created_by = auth.uid();
  return new;
end; $$;

drop trigger if exists archives_set_created_by on public.archives;
create trigger archives_set_created_by
  before insert on public.archives
  for each row execute function public.set_created_by();

-- 3) Replace write policy: INSERT open to authenticated (with check true);
--    UPDATE/DELETE gated by "you created it OR your clearance >= required".
drop policy if exists "archives_write_authenticated" on public.archives;
drop policy if exists "archives_write_clearance" on public.archives;
create policy "archives_write_clearance"
  on public.archives for all
  to authenticated
  using ( created_by = auth.uid() or public.required_clearance(classification) <= public.user_clearance() )
  with check (true);

-- 4) peek_delete(p_num): eligibility check for the terminal prompt.
--    Returns ok / not_found / denied with the record's title + classification
--    so the client can render the "type I'm sure" prompt.
create or replace function public.peek_delete(p_num text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rec public.archives%rowtype;
  usr int;
  req int;
  mine boolean;
begin
  if auth.uid() is null then
    return jsonb_build_object('status','denied','required',99,'have',0);
  end if;
  select * into rec from public.archives where archive_number = p_num;
  if rec.id is null then
    return jsonb_build_object('status','not_found');
  end if;
  usr := public.user_clearance();
  req := public.required_clearance(rec.classification);
  mine := (rec.created_by = auth.uid());
  if mine or usr >= req then
    return jsonb_build_object(
      'status','ok','archive_number',rec.archive_number,'title',rec.title,
      'classification',rec.classification,'created_by_me',mine,
      'required',req,'have',usr);
  end if;
  return jsonb_build_object(
    'status','denied','archive_number',rec.archive_number,'title',rec.title,
    'classification',rec.classification,'required',req,'have',usr);
end; $$;

revoke execute on function public.peek_delete(text) from public;
grant execute on function public.peek_delete(text) to authenticated;

-- 5) delete_archive(p_num): re-checks eligibility server-side and deletes.
--    Called only after the client collected the "I'm sure" confirmation.
create or replace function public.delete_archive(p_num text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rec public.archives%rowtype;
  usr int;
  req int;
begin
  if auth.uid() is null then
    return jsonb_build_object('status','denied');
  end if;
  select * into rec from public.archives where archive_number = p_num;
  if rec.id is null then
    return jsonb_build_object('status','not_found');
  end if;
  usr := public.user_clearance();
  req := public.required_clearance(rec.classification);
  if rec.created_by = auth.uid() or usr >= req then
    delete from public.archives where id = rec.id;
    return jsonb_build_object('status','ok','archive_number',rec.archive_number,'title',rec.title);
  end if;
  return jsonb_build_object('status','denied','classification',rec.classification,'required',req,'have',usr);
end; $$;

revoke execute on function public.delete_archive(text) from public;
grant execute on function public.delete_archive(text) to authenticated;