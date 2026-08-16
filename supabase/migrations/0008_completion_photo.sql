-- ============================================================
-- 0008 — Optional job-completion photo
--
-- From live testing with Brano: a driver marking a job complete had no way to
-- attach a photo of the load, the site or the ticket. Optional by design —
-- whether a photo is wanted depends entirely on the job, and a mandatory step
-- would just teach drivers to shoot the floor of the cab to get past it.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- 1. Where the photo lives ---------------------------------------------------
alter table public.dispatches
  add column if not exists completion_photo_path text;

comment on column public.dispatches.completion_photo_path is
  'Object path in the private job-photos storage bucket, "<user_id>/<dispatch_id>/<uuid>.jpg". Null = no photo attached (the normal case).';

-- 2. CRITICAL: let the driver actually write it ------------------------------
-- protect_dispatch_columns() forces EVERY column except status/completed_at/
-- accepted_at back to its previous value for a non-admin caller. A new column
-- is not automatically writable — without this the driver's upload would
-- succeed, the update would report success, and the path would be silently
-- discarded by the trigger. Set-once, matching how accepted_at is handled: the
-- driver may attach a photo, but cannot later swap or clear it. Admins and
-- dispatchers bypass this branch entirely and can correct a bad photo.
create or replace function public.protect_dispatch_columns()
returns trigger as $$
begin
  if auth.uid() is not null
     and public.get_my_role() is distinct from 'admin'
     and public.get_my_role() is distinct from 'dispatcher' then
    new.driver_id    := old.driver_id;
    new.site_address := old.site_address;
    new.lat          := old.lat;
    new.lng          := old.lng;
    new.notes        := old.notes;
    new.created_by   := old.created_by;
    new.created_at   := old.created_at;

    -- accepted_at: set once, at SERVER time. Not a blanket now() — that would
    -- stamp an acceptance onto a job only ever marked complete. (0005)
    if old.accepted_at is not null then
      new.accepted_at := old.accepted_at;   -- immutable once set; cannot be cleared
    elsif new.accepted_at is not null then
      new.accepted_at := now();             -- first accept: ignore the device clock
    end if;

    -- completion_photo_path: writable once, never rewritable. (0008)
    if old.completion_photo_path is not null then
      new.completion_photo_path := old.completion_photo_path;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer;

-- 3. Private storage bucket --------------------------------------------------
-- Private, not public: a completion photo can show a client's site, a plate, or
-- a person. Reads go through short-lived signed URLs instead.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('job-photos', 'job-photos', false, 15728640,
        array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 4. Bucket RLS — same shape as the rest of the app --------------------------
-- Driver: their own folder only. Admin/dispatcher: everything.
-- The first path segment is the uploader's user id, which is what ties an
-- object to a driver; nothing here trusts a client-supplied field.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage'
                 and tablename = 'objects' and policyname = 'Drivers upload own job photos') then
    create policy "Drivers upload own job photos" on storage.objects
      for insert to authenticated
      with check (bucket_id = 'job-photos' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage'
                 and tablename = 'objects' and policyname = 'Drivers view own job photos') then
    create policy "Drivers view own job photos" on storage.objects
      for select to authenticated
      using (bucket_id = 'job-photos' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage'
                 and tablename = 'objects' and policyname = 'Staff view all job photos') then
    create policy "Staff view all job photos" on storage.objects
      for select to authenticated
      using (bucket_id = 'job-photos' and public.get_my_role() in ('admin', 'dispatcher'));
  end if;

  -- Nobody can overwrite or delete their own evidence; staff can remove a photo
  -- attached by mistake, which otherwise nothing in the app could undo.
  if not exists (select 1 from pg_policies where schemaname = 'storage'
                 and tablename = 'objects' and policyname = 'Staff delete job photos') then
    create policy "Staff delete job photos" on storage.objects
      for delete to authenticated
      using (bucket_id = 'job-photos' and public.get_my_role() in ('admin', 'dispatcher'));
  end if;
end $$;
