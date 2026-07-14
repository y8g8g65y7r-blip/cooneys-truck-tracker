-- ============================================================
-- Cooney's Trucking — Truck Tracker Database Setup
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- 1. PROFILES TABLE (drivers + dispatchers)
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  full_name text not null,
  unit_number text,
  role text not null default 'driver' check (role in ('driver', 'dispatcher'))
);

-- 2. AUTO-CREATE PROFILE ON SIGNUP
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, unit_number, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    new.raw_user_meta_data->>'unit_number',
    'driver'
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
  completed_at timestamptz
);

create index dispatches_driver_status_idx on public.dispatches (driver_id, status);

-- 6. ROW LEVEL SECURITY
alter table public.profiles enable row level security;
alter table public.location_updates enable row level security;
alter table public.dispatches enable row level security;

-- Profiles: everyone can see their own; dispatchers see all
create policy "Users view own profile" on public.profiles
  for select using (auth.uid() = id);

create policy "Dispatchers view all profiles" on public.profiles
  for select using (public.get_my_role() = 'dispatcher');

create policy "Users update own profile" on public.profiles
  for update using (auth.uid() = id);

create policy "Dispatchers update all profiles" on public.profiles
  for update using (public.get_my_role() = 'dispatcher');

-- Location updates: drivers insert/view their own; dispatchers view all
create policy "Drivers insert own location" on public.location_updates
  for insert with check (auth.uid() = user_id);

create policy "Drivers view own location" on public.location_updates
  for select using (auth.uid() = user_id);

create policy "Dispatchers view all locations" on public.location_updates
  for select using (public.get_my_role() = 'dispatcher');

-- Dispatches: drivers view/update (status) their own; dispatchers manage all
create policy "Drivers view own dispatches" on public.dispatches
  for select using (auth.uid() = driver_id);

create policy "Drivers update own dispatch status" on public.dispatches
  for update using (auth.uid() = driver_id);

create policy "Dispatchers view all dispatches" on public.dispatches
  for select using (public.get_my_role() = 'dispatcher');

create policy "Dispatchers insert dispatches" on public.dispatches
  for insert with check (public.get_my_role() = 'dispatcher');

create policy "Dispatchers update all dispatches" on public.dispatches
  for update using (public.get_my_role() = 'dispatcher');

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
-- 2. To make someone a dispatcher (e.g. Kale or Dario), run:
--    UPDATE public.profiles SET role = 'dispatcher' WHERE full_name = 'Kale';
--
-- 3. Put your Project URL and anon key into config.js
-- ============================================================
