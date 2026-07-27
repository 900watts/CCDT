-- ============================================================================
--  CCDT migration 003 — photos on archives + storage bucket
--  Adds a `photos` jsonb column to archives and a public `archive-photos`
--  storage bucket for image uploads from the document editor.
--  Idempotent; safe to re-run.
-- ============================================================================

-- 1) photos column on archives (jsonb array of {url, name, width, height})
alter table public.archives
  add column if not exists photos jsonb not null default '[]'::jsonb;

-- 2) archive-photos storage bucket (public so the public URL works)
--    The Management API doesn't expose storage admin directly via SQL,
--    so this migration is just the column. The bucket is created via the
--    Storage API in this same file's deploy step.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'archive-photos',
    'archive-photos',
    true,
    10485760,  -- 10 MB per file
    array['image/png','image/jpeg','image/gif','image/webp','image/svg+xml']
  )
  on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- 3) Storage RLS: authenticated users can upload/update/delete in
--    archive-photos. Reads are public (the bucket is public anyway).
drop policy if exists "archive_photos_read" on storage.objects;
create policy "archive_photos_read"
  on storage.objects for select
  using ( bucket_id = 'archive-photos' );

drop policy if exists "archive_photos_write" on storage.objects;
create policy "archive_photos_write"
  on storage.objects for insert
  to authenticated
  with check ( bucket_id = 'archive-photos' );

drop policy if exists "archive_photos_update" on storage.objects;
create policy "archive_photos_update"
  on storage.objects for update
  to authenticated
  using ( bucket_id = 'archive-photos' )
  with check ( bucket_id = 'archive-photos' );

drop policy if exists "archive_photos_delete" on storage.objects;
create policy "archive_photos_delete"
  on storage.objects for delete
  to authenticated
  using ( bucket_id = 'archive-photos' );