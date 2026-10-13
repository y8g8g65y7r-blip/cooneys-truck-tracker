-- ============================================================
-- 0015 — Units assigned per dispatch (2026-10-13, VANCE)
--
-- Matt 2026-10-13: "sometimes it'll have a different unit number, or we'll
-- throw them in a different truck. So I should be able to assign Dario 98 or
-- any other number that we have listed. He shouldn't automatically get unit 98
-- to his name."
--
--   * public.units: Cooney's power units (trailers out of scope). Seeded from
--     the Axon equipment list per SADIE's A-38 classification plus the units on
--     today's driver profiles (supabase/seed/units_seed.sql). Office staff add,
--     retire and reactivate units in the app (www/units.html), no code.
--   * dispatches.unit_id + dispatches.unit_number: the unit ON THAT JOB. The
--     number is a snapshot, so history keeps the unit that was on the job even
--     after the unit is renumbered or retired.
--   * A job sent without a unit (older dispatcher builds never send one) gets
--     the unit this driver was last dispatched in, else the unit on their
--     profile: exactly what those builds showed before. A new dispatcher can
--     say "no unit" explicitly with unit_number = '' (see the trigger).
--   * profiles.unit_number is DEPRECATED, not dropped: TestFlight builds 5/6
--     still read it. Nothing new relies on it except that last-resort default.
--   * protect_dispatch_columns() (a DENY-list) now also clamps unit_id and
--     unit_number for drivers, and clamps status: a driver may only move their
--     own open job to 'completed' (server-stamped completed_at). That closes the
--     "driver can set any status" gap found on 2026-10-12.
--
-- Idempotent. Apply to the CA clone at cutover (migration plan 6.3a).
-- ============================================================

create table if not exists public.units (
  id           uuid primary key default gen_random_uuid(),
  unit_number  text not null check (char_length(btrim(unit_number)) between 1 and 20),
  kind         text not null default 'power' check (kind in ('power')),
  year         int,
  make         text check (make is null or char_length(make) <= 80),
  plate        text check (plate is null or char_length(plate) <= 20),
  vin          text check (vin is null or char_length(vin) <= 40),
  active       boolean not null default true,
  confirmed    boolean not null default true,
  source       text not null default 'admin' check (source in ('axon', 'app', 'admin', 'demo')),
  is_demo      boolean not null default false,
  note         text check (note is null or char_length(note) <= 300),
  seed_key     text unique,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz,
  updated_by   uuid
);

comment on table public.units is
  'Cooney''s power units that dispatch can put a driver in. active=false = sold / retired / do not use (kept for history). confirmed=false = taken from an app driver profile, not yet confirmed as a real truck by Matt.';

-- One ACTIVE unit per number (a retired row may share a number: Axon has an
-- active 87 and an inactive "#87 Do not use").
create unique index if not exists units_active_number_uniq
  on public.units (is_demo, lower(btrim(unit_number))) where active;

create or replace function public.units_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare demo boolean := false;
begin
  new.unit_number := btrim(new.unit_number);
  if auth.uid() is not null then
    if exists (select 1 from pg_proc where proname = 'demo_user_ids' and pronamespace = 'public'::regnamespace) then
      execute 'select $1 = any(public.demo_user_ids())' into demo using auth.uid();
    end if;
    if tg_op = 'INSERT' then
      new.source   := case when demo then 'demo' else 'admin' end;
      new.is_demo  := coalesce(demo, false);
      new.seed_key := null;
      new.created_at := now();
    else
      new.source   := old.source;
      new.is_demo  := old.is_demo;
      new.seed_key := old.seed_key;
      new.created_at := old.created_at;
    end if;
    new.updated_at := now();
    new.updated_by := auth.uid();
  end if;
  return new;
end $$;
revoke execute on function public.units_stamp() from public, anon, authenticated;
drop trigger if exists units_stamp on public.units;
create trigger units_stamp before insert or update on public.units
  for each row execute function public.units_stamp();

alter table public.units enable row level security;

do $$
begin
  -- Office staff only. Drivers never read this table: their unit comes on the
  -- dispatch itself (unit_number snapshot).
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'units' and policyname = 'Staff read units') then
    create policy "Staff read units" on public.units for select to authenticated
      using (public.get_my_role() in ('admin', 'dispatcher'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'units' and policyname = 'Staff add units') then
    create policy "Staff add units" on public.units for insert to authenticated
      with check (public.get_my_role() in ('admin', 'dispatcher'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'units' and policyname = 'Staff edit units') then
    create policy "Staff edit units" on public.units for update to authenticated
      using (public.get_my_role() in ('admin', 'dispatcher'))
      with check (public.get_my_role() in ('admin', 'dispatcher'));
  end if;
  -- No DELETE: retire a unit (active=false). Old jobs keep pointing at it.
end $$;

do $$
begin
  if exists (select 1 from pg_proc where proname = 'demo_user_ids' and pronamespace = 'public'::regnamespace) then
    execute 'drop policy if exists demo_isolation on public.units';
    execute $p$create policy demo_isolation on public.units as restrictive for all to public
      using (coalesce((select auth.uid()) = any(public.demo_user_ids()), false) = is_demo)
      with check (coalesce((select auth.uid()) = any(public.demo_user_ids()), false) = is_demo)$p$;
  end if;
end $$;

-- ------------------------------------------------------------
-- The unit on each job
-- ------------------------------------------------------------
alter table public.dispatches add column if not exists unit_id uuid references public.units(id) on delete set null;
alter table public.dispatches add column if not exists unit_number text;
create index if not exists dispatches_driver_unit_idx on public.dispatches (driver_id, created_at desc) where unit_id is not null;

create or replace function public.dispatch_unit_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  u record;
  drv_demo boolean := false;
begin
  -- A driver's UPDATE: protect_dispatch_columns() (which fires after this, by
  -- trigger name order) puts unit_id/unit_number back. Nothing to do here.
  if tg_op = 'UPDATE' and auth.uid() is not null
     and public.get_my_role() is distinct from 'admin' and public.get_my_role() is distinct from 'dispatcher' then
    return new;
  end if;
  if exists (select 1 from pg_proc where proname = 'demo_user_ids' and pronamespace = 'public'::regnamespace) then
    execute 'select $1 = any(public.demo_user_ids())' into drv_demo using new.driver_id;
  end if;
  drv_demo := coalesce(drv_demo, false);

  if tg_op = 'INSERT' and new.unit_id is null then
    if new.unit_number = '' then
      -- The dispatcher chose "No unit" on purpose.
      new.unit_number := null;
      return new;
    end if;
    if new.unit_number is null then
      -- Sent without a unit (an older dispatcher build): the unit this driver
      -- was last dispatched in, else the one on their (deprecated) profile.
      select d.unit_id into new.unit_id
        from public.dispatches d join public.units x on x.id = d.unit_id and x.active and x.is_demo = drv_demo
       where d.driver_id = new.driver_id
       order by d.created_at desc limit 1;
      if new.unit_id is null then
        select x.id into new.unit_id
          from public.profiles p join public.units x
            on x.active and x.is_demo = drv_demo and lower(x.unit_number) = lower(btrim(p.unit_number))
         where p.id = new.driver_id limit 1;
      end if;
    end if;
  end if;

  if new.unit_id is not null and (tg_op = 'INSERT' or new.unit_id is distinct from old.unit_id) then
    select * into u from public.units where id = new.unit_id;
    if u.id is null then raise exception 'unit not found'; end if;
    if not u.active then raise exception 'unit % is retired', u.unit_number; end if;
    if u.is_demo <> drv_demo then raise exception 'unit % is not available for this driver', u.unit_number; end if;
    new.unit_number := u.unit_number;
  elsif tg_op = 'UPDATE' and new.unit_id is null and old.unit_id is not null then
    new.unit_number := null;            -- unit taken off the job
  elsif tg_op = 'UPDATE' and new.unit_id is not distinct from old.unit_id and new.unit_id is not null then
    new.unit_number := old.unit_number; -- the snapshot only changes with the unit
  end if;
  return new;
end $$;
revoke execute on function public.dispatch_unit_stamp() from public, anon, authenticated;
drop trigger if exists dispatch_unit_stamp_trg on public.dispatches;
create trigger dispatch_unit_stamp_trg before insert or update on public.dispatches
  for each row execute function public.dispatch_unit_stamp();

-- ------------------------------------------------------------
-- protect_dispatch_columns(): + unit clamp, + status clamp.
-- Everything above the two new blocks is the live 0011 definition, unchanged.
-- ------------------------------------------------------------
create or replace function public.protect_dispatch_columns()
returns trigger
language plpgsql
security definer
as $function$
begin
  if auth.uid() is not null
     and public.get_my_role() is distinct from 'admin'
     and public.get_my_role() is distinct from 'dispatcher' then
    new.driver_id      := old.driver_id;
    new.site_address   := old.site_address;
    new.lat            := old.lat;
    new.lng            := old.lng;
    new.notes          := old.notes;
    new.created_by     := old.created_by;
    new.created_at     := old.created_at;
    -- (0011) the pickup stop itself is dispatcher-owned
    new.pickup_name    := old.pickup_name;
    new.pickup_address := old.pickup_address;
    new.pickup_lat     := old.pickup_lat;
    new.pickup_lng     := old.pickup_lng;
    -- (0015) the unit on the job is dispatcher-owned
    new.unit_id        := old.unit_id;
    new.unit_number    := old.unit_number;

    -- (0015) status: a driver may only close their own OPEN job. Anything else
    -- (reopen, cancel, un-cancel, invented values) is put back. completed_at is
    -- server time on that one transition and frozen otherwise.
    if new.status is distinct from old.status then
      if old.status = 'active' and new.status = 'completed' then
        new.completed_at := now();
      else
        new.status       := old.status;
        new.completed_at := old.completed_at;
      end if;
    else
      new.completed_at := old.completed_at;
    end if;

    -- accepted_at: set once, at SERVER time. (0005)
    if old.accepted_at is not null then
      new.accepted_at := old.accepted_at;
    elsif new.accepted_at is not null then
      new.accepted_at := now();
    end if;

    -- completion_photo_path: writable once, never rewritable. (0008)
    if old.completion_photo_path is not null then
      new.completion_photo_path := old.completion_photo_path;
    end if;

    -- picked_up_at (0011): the driver may mark Loaded (server-stamped), or undo
    -- a mis-tap / wrong auto-advance while the job is still open. Never
    -- back-dated, never rewritten to a different time, frozen once the job is
    -- closed, and meaningless on a job with no pickup stop.
    if old.status is distinct from 'active' or old.pickup_address is null then
      new.picked_up_at  := old.picked_up_at;
      new.pickup_source := old.pickup_source;
    elsif old.picked_up_at is null and new.picked_up_at is not null then
      new.picked_up_at  := now();
      new.pickup_source := 'tap';
    elsif old.picked_up_at is not null and new.picked_up_at is null then
      new.pickup_source := 'undone';
    else
      new.picked_up_at  := old.picked_up_at;
      new.pickup_source := old.pickup_source;
    end if;
  end if;
  return new;
end;
$function$;
