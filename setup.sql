-- ============================================================
-- Cooney's Trucking — Truck Tracker Database Setup
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- 1. PROFILES TABLE (drivers + admins)
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  full_name text not null,
  unit_number text,
  role text not null default 'driver' check (role in ('driver', 'dispatcher', 'admin')),
  employment_type text not null default 'staff' check (employment_type in ('staff', 'contractor')),
  active boolean not null default true,
  push_token text                    -- APNs device token, written by the app after registration (0004)
);

-- 2. AUTO-CREATE PROFILE ON SIGNUP
--    SECURITY: role is HARDCODED to 'driver' and is NEVER read from signup
--    metadata (raw_user_meta_data is attacker-controlled on anon self sign-up,
--    so trusting role there would allow self-promotion to admin). New users are
--    always drivers; admins are promoted via the trusted UPDATE at the bottom of
--    this file. employment_type is a non-privileged reporting field.
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 3. SECURITY DEFINER ROLE HELPER (avoids RLS recursion)
create or replace function public.get_my_role()
returns text as $$
  select role from public.profiles where id = auth.uid();
$$ language sql security definer stable;

-- 3b. SECURITY: lock privileged columns against self-escalation.
--     The "Users update own profile" policy (below) lets a driver update their
--     own row (name / unit). Without this guard they could also flip
--     role='admin' on that row and pass the edge-function admin gate. This
--     BEFORE UPDATE trigger forces role / employment_type / active back to their
--     prior values for any authenticated NON-admin caller. auth.uid() IS NOT
--     NULL lets the trusted paths through (the SQL editor and service-role calls
--     have a null auth.uid()), so the admin-bootstrap UPDATE at the bottom of
--     this file still works.
create or replace function public.protect_profile_privileged_columns()
returns trigger as $$
begin
  if auth.uid() is not null
     and public.get_my_role() is distinct from 'admin'
     and public.get_my_role() is distinct from 'dispatcher' then
    new.role := old.role;
    new.employment_type := old.employment_type;
    new.active := old.active;
  end if;
  return new;
end;
$$ language plpgsql security definer;

create trigger protect_profile_privileged_columns_trg
  before update on public.profiles
  for each row execute procedure public.protect_profile_privileged_columns();

-- 4. LOCATION UPDATES (GPS pings)
create table public.location_updates (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  lat numeric not null,
  lng numeric not null,
  accuracy numeric,
  speed numeric,
  heading numeric,
  created_at timestamptz default now()
);

create index location_updates_user_time_idx on public.location_updates (user_id, created_at desc);

-- 5. DISPATCHES (an address sent to a driver)
create table public.dispatches (
  id uuid default gen_random_uuid() primary key,
  driver_id uuid references auth.users on delete cascade not null,
  site_address text not null,
  lat numeric,
  lng numeric,
  notes text,
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  created_by uuid references auth.users not null,
  created_at timestamptz default now(),
  completed_at timestamptz,
  accepted_at timestamptz            -- set by the driver tapping Accept (0004)
);

-- Realtime: the driver and dispatcher UIs subscribe to postgres_changes on this
-- table so accept/complete/cancel show up instantly instead of on the next poll.
-- RLS still applies per subscriber. Guarded exactly as 0004 does — a bare ALTER
-- PUBLICATION errors if the table is already a member, which would abort the
-- rest of this script. (0004)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'dispatches'
  ) then
    alter publication supabase_realtime add table public.dispatches;
  end if;
end $$;

create index dispatches_driver_status_idx on public.dispatches (driver_id, status);
-- driver_id LEADS the index above, so status-only predicates cannot use it.
-- The dispatcher history/active lists and the live map all filter on status
-- alone and sort by created_at. (0005)
create index dispatches_status_created_idx on public.dispatches (status, created_at desc);

-- 6. ROW LEVEL SECURITY
alter table public.profiles enable row level security;
alter table public.location_updates enable row level security;
alter table public.dispatches enable row level security;

-- Profiles: everyone can see their own; admins see all
create policy "Users view own profile" on public.profiles
  for select using (auth.uid() = id);

create policy "Admins view all profiles" on public.profiles
  for select using (public.get_my_role() in ('admin', 'dispatcher'));

create policy "Users update own profile" on public.profiles
  for update using (auth.uid() = id);

create policy "Admins update all profiles" on public.profiles
  for update using (public.get_my_role() in ('admin', 'dispatcher'));

-- Location updates: drivers insert/view their own; admins view all
create policy "Drivers insert own location" on public.location_updates
  for insert with check (auth.uid() = user_id);

create policy "Drivers view own location" on public.location_updates
  for select using (auth.uid() = user_id);

create policy "Admins view all locations" on public.location_updates
  for select using (public.get_my_role() in ('admin', 'dispatcher'));

-- Dispatches: drivers view/update (status) their own; admins manage all
create policy "Drivers view own dispatches" on public.dispatches
  for select using (auth.uid() = driver_id);

create policy "Drivers update own dispatch status" on public.dispatches
  for update using (auth.uid() = driver_id);

create policy "Admins view all dispatches" on public.dispatches
  for select using (public.get_my_role() in ('admin', 'dispatcher'));

create policy "Admins insert dispatches" on public.dispatches
  for insert with check (public.get_my_role() in ('admin', 'dispatcher'));

create policy "Admins update all dispatches" on public.dispatches
  for update using (public.get_my_role() in ('admin', 'dispatcher'));

-- SECURITY: lock dispatch columns for non-admins. The "Drivers update own
-- dispatch status" policy authorises the row but RLS cannot restrict columns,
-- so without this a driver could rewrite site_address / created_by / notes on
-- their own jobs. This BEFORE UPDATE trigger forces every column except status
-- and completed_at back to its prior value for any authenticated non-admin, so
-- a driver can only mark a job complete. Admins and the null-uid SQL/service
-- path pass through unchanged.
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
  end if;
  return new;
end;
$$ language plpgsql security definer;

create trigger protect_dispatch_columns_trg
  before update on public.dispatches
  for each row execute procedure public.protect_dispatch_columns();

-- ============================================================
-- AFTER RUNNING THE ABOVE:
--
-- 1. Go to Authentication → Users → Add User for each driver.
--    Set their email + a password, and under "User Metadata" add:
--      { "full_name": "Ranjeet Sandhu", "unit_number": "55" }
--
--    For this test roster:
--      RJ (Ranjeet Sandhu) — RanjeetGrewal32@gmail.com — unit 55
--      Antoine Filiatrault — AntoineFiliatraultc@gmail.com — unit 36
--
-- 2. To make someone an admin (e.g. Kale or Dario), run:
--    UPDATE public.profiles SET role = 'admin' WHERE full_name = 'Kale';
--
-- 3. Put your Project URL and anon key into config.js
-- ============================================================
