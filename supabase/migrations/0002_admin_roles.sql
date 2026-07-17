-- ============================================================
-- Cooney's Trucking — Migration 0002: Admin roles
-- Transforms the LIVE database from the original setup.sql state to:
--   * role check ('driver','admin')   (was ('driver','dispatcher'))
--   * new column employment_type text  ('staff','contractor'), default 'staff'
--   * new column active boolean         default true
--   * handle_new_user() reads role + employment_type from user metadata
--   * every "Dispatchers ..." RLS policy re-created as "Admins ..." vs 'admin'
--
-- Run once in: Supabase Dashboard -> SQL Editor -> New Query
-- Safe to run once on the existing DB. Order matters (constraint swap after
-- the data UPDATE) so no row ever violates the new CHECK.
-- ============================================================

-- 1. ROLE: swap the CHECK from ('driver','dispatcher') to ('driver','admin')
--    a. Drop the old check (named or auto-generated) BEFORE touching data.
alter table public.profiles drop constraint if exists profiles_role_check;

-- Robust fallback: drop ANY check constraint on public.profiles that still
-- references the string 'dispatcher' (covers an auto-generated constraint name).
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'profiles'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%dispatcher%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;

--    b. Migrate existing data BEFORE re-adding the constraint.
update public.profiles set role = 'admin' where role = 'dispatcher';

--    c. Re-add the CHECK with the new allowed values.
alter table public.profiles
  add constraint profiles_role_check check (role in ('driver', 'admin'));

-- 2. NEW COLUMNS on profiles
alter table public.profiles
  add column if not exists employment_type text not null default 'staff';

alter table public.profiles
  drop constraint if exists profiles_employment_type_check;

alter table public.profiles
  add constraint profiles_employment_type_check
  check (employment_type in ('staff', 'contractor'));

alter table public.profiles
  add column if not exists active boolean not null default true;

-- 3. TRIGGER: recreate handle_new_user().
--    SECURITY: role is HARDCODED to 'driver' and is NEVER read from signup
--    metadata. raw_user_meta_data is fully attacker-controlled during self
--    sign-up (anon key), so trusting role there would let anyone create an
--    admin for themselves. New users are always drivers; admins are promoted
--    via a trusted UPDATE (see the bottom of setup.sql). employment_type is a
--    non-privileged reporting field, so a default-from-metadata is acceptable.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, unit_number, role, employment_type)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    new.raw_user_meta_data->>'unit_number',
    'driver',
    coalesce(new.raw_user_meta_data->>'employment_type', 'staff')
  );
  return new;
end;
$$ language plpgsql security definer;

-- get_my_role() is unchanged; left as-is.

-- 3b. SECURITY: lock privileged columns against self-escalation.
--     The "Users update own profile" policy lets a driver update their own row
--     (name / unit). Without this guard a driver could also set role='admin' on
--     that same row and then pass the edge-function admin gate. This BEFORE
--     UPDATE trigger forces role / employment_type / active back to their prior
--     values for any authenticated NON-admin caller. The auth.uid() IS NOT NULL
--     check lets the trusted paths through: the SQL editor and service-role
--     calls run with a null auth.uid(), so the documented admin-bootstrap
--     UPDATE still works.
create or replace function public.protect_profile_privileged_columns()
returns trigger as $$
begin
  if auth.uid() is not null and public.get_my_role() is distinct from 'admin' then
    new.role := old.role;
    new.employment_type := old.employment_type;
    new.active := old.active;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists protect_profile_privileged_columns_trg on public.profiles;
create trigger protect_profile_privileged_columns_trg
  before update on public.profiles
  for each row execute procedure public.protect_profile_privileged_columns();

-- 4. RLS POLICIES: drop each "Dispatchers ..." policy and recreate as
--    "Admins ..." comparing get_my_role() = 'admin'. Each new policy is also
--    dropped-if-exists first so this migration is safe to re-run.

-- profiles
drop policy if exists "Dispatchers view all profiles" on public.profiles;
drop policy if exists "Admins view all profiles" on public.profiles;
create policy "Admins view all profiles" on public.profiles
  for select using (public.get_my_role() = 'admin');

drop policy if exists "Dispatchers update all profiles" on public.profiles;
drop policy if exists "Admins update all profiles" on public.profiles;
create policy "Admins update all profiles" on public.profiles
  for update using (public.get_my_role() = 'admin');

-- location_updates
drop policy if exists "Dispatchers view all locations" on public.location_updates;
drop policy if exists "Admins view all locations" on public.location_updates;
create policy "Admins view all locations" on public.location_updates
  for select using (public.get_my_role() = 'admin');

-- dispatches
drop policy if exists "Dispatchers view all dispatches" on public.dispatches;
drop policy if exists "Admins view all dispatches" on public.dispatches;
create policy "Admins view all dispatches" on public.dispatches
  for select using (public.get_my_role() = 'admin');

drop policy if exists "Dispatchers insert dispatches" on public.dispatches;
drop policy if exists "Admins insert dispatches" on public.dispatches;
create policy "Admins insert dispatches" on public.dispatches
  for insert with check (public.get_my_role() = 'admin');

drop policy if exists "Dispatchers update all dispatches" on public.dispatches;
drop policy if exists "Admins update all dispatches" on public.dispatches;
create policy "Admins update all dispatches" on public.dispatches
  for update using (public.get_my_role() = 'admin');

-- 5. SECURITY: lock dispatch columns for non-admins.
--    The "Drivers update own dispatch status" policy authorises a driver to
--    update their own dispatch row, but RLS cannot restrict WHICH columns, so a
--    driver could rewrite site_address / created_by / notes etc. on their own
--    jobs. This BEFORE UPDATE trigger forces every column except status and
--    completed_at back to its prior value for any authenticated non-admin, so a
--    driver can only ever mark a job complete. Admins (and the null-uid SQL /
--    service path) pass through unchanged.
create or replace function public.protect_dispatch_columns()
returns trigger as $$
begin
  if auth.uid() is not null and public.get_my_role() is distinct from 'admin' then
    new.driver_id    := old.driver_id;
    new.site_address := old.site_address;
    new.lat          := old.lat;
    new.lng          := old.lng;
    new.notes        := old.notes;
    new.created_by   := old.created_by;
    new.created_at   := old.created_at;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists protect_dispatch_columns_trg on public.dispatches;
create trigger protect_dispatch_columns_trg
  before update on public.dispatches
  for each row execute procedure public.protect_dispatch_columns();
