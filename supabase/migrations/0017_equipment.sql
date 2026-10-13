-- ============================================================
-- 0017 — Equipment configuration on every job (2026-10-13, VANCE)
--
-- Matt: "the driver doesn't know if he's doing just the tandem or if he's taking
-- a trailer, like a truck and pup... a first step would be telling the driver
-- what he's driving. ... Those are all priced differently too."
--
--   * public.equipment_types: the priced configurations, named EXACTLY as on the
--     May 1 2026 hourly rate sheet (billing ties to that sheet later; the app
--     stores no prices). Each type says whether a trailer is hooked up and what
--     kind, plus a plain driver_label for the banner. Office-editable on the
--     Units & Equipment page. Seeded by supabase/seed/equipment_seed.sql.
--   * units gain kind 'trailer' and units.trailer_kind (Axon trailers seeded).
--   * dispatches gain the equipment on THAT job: equipment_type_id + snapshot
--     (name, driver label, needs_trailer, trailer_kind) and trailer_unit_id +
--     trailer_number snapshot. History keeps the configuration as it was.
--   * Older dispatcher builds send no equipment: those jobs show "Equipment not
--     set" and work exactly as before.
--   * protect_dispatch_columns() clamps all seven new dispatcher-owned columns.
--   * The power unit must be a power unit and the trailer must be a trailer.
--
-- Idempotent. Apply to the CA clone at cutover (migration plan 6.3a).
-- ============================================================

-- ------------------------------------------------------------
-- Equipment types
-- ------------------------------------------------------------
create table if not exists public.equipment_types (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  driver_label  text not null check (char_length(btrim(driver_label)) between 1 and 60),
  needs_trailer boolean not null default false,
  trailer_kind  text not null default 'none'
                check (trailer_kind in ('none', 'pup', 'quad', 'end_dump', 'demo_rock_box', 'low_bed', 'other')),
  confirmed     boolean not null default false,
  active        boolean not null default true,
  sort_order    int not null default 100,
  note          text check (note is null or char_length(note) <= 300),
  seed_key      text unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  updated_by    uuid,
  constraint equipment_trailer_consistent check ((needs_trailer and trailer_kind <> 'none') or (not needs_trailer and trailer_kind = 'none'))
);
comment on table public.equipment_types is
  'Priced equipment configurations (names = the hourly rate sheet). needs_trailer/trailer_kind tell the driver what to hook up. No prices are stored in the app.';
create unique index if not exists equipment_types_active_name_uniq on public.equipment_types (lower(btrim(name))) where active;

create or replace function public.equipment_types_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.name := btrim(new.name);
  new.driver_label := btrim(new.driver_label);
  if auth.uid() is not null then
    if tg_op = 'INSERT' then new.seed_key := null; new.created_at := now();
    else new.seed_key := old.seed_key; new.created_at := old.created_at; end if;
    new.updated_at := now();
    new.updated_by := auth.uid();
  end if;
  return new;
end $$;
revoke execute on function public.equipment_types_stamp() from public, anon, authenticated;
drop trigger if exists equipment_types_stamp on public.equipment_types;
create trigger equipment_types_stamp before insert or update on public.equipment_types
  for each row execute function public.equipment_types_stamp();

alter table public.equipment_types enable row level security;
do $$
begin
  -- Everyone signed in may READ the types (the driver's haul ticket lists them).
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'equipment_types' and policyname = 'Signed-in users read equipment types') then
    create policy "Signed-in users read equipment types" on public.equipment_types for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'equipment_types' and policyname = 'Staff add equipment types') then
    create policy "Staff add equipment types" on public.equipment_types for insert to authenticated
      with check (public.get_my_role() in ('admin', 'dispatcher'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'equipment_types' and policyname = 'Staff edit equipment types') then
    create policy "Staff edit equipment types" on public.equipment_types for update to authenticated
      using (public.get_my_role() in ('admin', 'dispatcher')) with check (public.get_my_role() in ('admin', 'dispatcher'));
  end if;
  -- No DELETE: retire a type (active=false); old jobs keep their snapshot.
end $$;

-- The types are SHARED by real and demo accounts (they are the rate sheet, not
-- anybody's data), so the App Store demo dispatcher may read them but must
-- never change them.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'demo_user_ids' and pronamespace = 'public'::regnamespace) then
    execute 'drop policy if exists demo_no_write on public.equipment_types';
    execute $p$create policy demo_no_write on public.equipment_types as restrictive for all to public
      using (true)
      with check (not coalesce((select auth.uid()) = any(public.demo_user_ids()), false))$p$;
  end if;
end $$;

-- ------------------------------------------------------------
-- Trailers live in units
-- ------------------------------------------------------------
alter table public.units drop constraint if exists units_kind_check;
alter table public.units add constraint units_kind_check check (kind in ('power', 'trailer'));
alter table public.units add column if not exists trailer_kind text;
alter table public.units drop constraint if exists units_trailer_kind_check;
alter table public.units add constraint units_trailer_kind_check check (
  trailer_kind is null or (kind = 'trailer' and trailer_kind in ('pup', 'quad', 'end_dump', 'demo_rock_box', 'low_bed', 'other')));
-- A truck and a trailer may share a number; two active units of one kind may not.
drop index if exists public.units_active_number_uniq;
create unique index if not exists units_active_kind_number_uniq
  on public.units (is_demo, kind, lower(btrim(unit_number))) where active;

-- ------------------------------------------------------------
-- The equipment on each job
-- ------------------------------------------------------------
alter table public.dispatches add column if not exists equipment_type_id uuid references public.equipment_types(id) on delete set null;
alter table public.dispatches add column if not exists equipment_name text;
alter table public.dispatches add column if not exists equipment_label text;
alter table public.dispatches add column if not exists needs_trailer boolean;
alter table public.dispatches add column if not exists trailer_kind text;
alter table public.dispatches add column if not exists trailer_unit_id uuid references public.units(id) on delete set null;
alter table public.dispatches add column if not exists trailer_number text;

create or replace function public.dispatch_equipment_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  t record; u record; drv_demo boolean := false;
begin
  -- A driver's UPDATE: protect_dispatch_columns() puts every equipment column
  -- back (it fires after this one, by trigger name order).
  if tg_op = 'UPDATE' and auth.uid() is not null
     and public.get_my_role() is distinct from 'admin' and public.get_my_role() is distinct from 'dispatcher' then
    return new;
  end if;
  if exists (select 1 from pg_proc where proname = 'demo_user_ids' and pronamespace = 'public'::regnamespace) then
    execute 'select $1 = any(public.demo_user_ids())' into drv_demo using new.driver_id;
  end if;
  drv_demo := coalesce(drv_demo, false);

  -- Type -> snapshot.
  if new.equipment_type_id is not null and (tg_op = 'INSERT' or new.equipment_type_id is distinct from old.equipment_type_id) then
    select * into t from public.equipment_types where id = new.equipment_type_id;
    if t.id is null then raise exception 'equipment type not found'; end if;
    if not t.active then raise exception 'equipment type % is retired', t.name; end if;
    new.equipment_name  := t.name;
    new.equipment_label := t.driver_label;
    new.needs_trailer   := t.needs_trailer;
    new.trailer_kind    := t.trailer_kind;
  elsif new.equipment_type_id is null and (tg_op = 'INSERT' or old.equipment_type_id is not null) then
    new.equipment_name := null; new.equipment_label := null; new.needs_trailer := null; new.trailer_kind := null;
  elsif tg_op = 'UPDATE' then
    new.equipment_name := old.equipment_name; new.equipment_label := old.equipment_label;
    new.needs_trailer := old.needs_trailer; new.trailer_kind := old.trailer_kind;
  end if;

  -- No trailer on this configuration -> no trailer on the job.
  if coalesce(new.needs_trailer, false) = false then
    new.trailer_unit_id := null;
    new.trailer_number  := null;
  elsif new.trailer_unit_id is not null and (tg_op = 'INSERT' or new.trailer_unit_id is distinct from old.trailer_unit_id) then
    select * into u from public.units where id = new.trailer_unit_id;
    if u.id is null then raise exception 'trailer not found'; end if;
    if u.kind <> 'trailer' then raise exception 'unit % is not a trailer', u.unit_number; end if;
    if not u.active then raise exception 'trailer % is retired', u.unit_number; end if;
    if u.is_demo <> drv_demo then raise exception 'trailer % is not available for this driver', u.unit_number; end if;
    new.trailer_number := u.unit_number;
  elsif new.trailer_unit_id is null then
    new.trailer_number := null;
  elsif tg_op = 'UPDATE' then
    new.trailer_number := old.trailer_number;
  end if;
  return new;
end $$;
revoke execute on function public.dispatch_equipment_stamp() from public, anon, authenticated;
drop trigger if exists dispatch_equipment_stamp_trg on public.dispatches;
create trigger dispatch_equipment_stamp_trg before insert or update on public.dispatches
  for each row execute function public.dispatch_equipment_stamp();

-- 0015's unit stamp, now also refusing a trailer in the truck slot (and the
-- default only ever picks a power unit). Otherwise unchanged.
create or replace function public.dispatch_unit_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  u record;
  drv_demo boolean := false;
begin
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
      new.unit_number := null;
      return new;
    end if;
    if new.unit_number is null then
      select d.unit_id into new.unit_id
        from public.dispatches d join public.units x on x.id = d.unit_id and x.active and x.kind = 'power' and x.is_demo = drv_demo
       where d.driver_id = new.driver_id
       order by d.created_at desc limit 1;
      if new.unit_id is null then
        select x.id into new.unit_id
          from public.profiles p join public.units x
            on x.active and x.kind = 'power' and x.is_demo = drv_demo and lower(x.unit_number) = lower(btrim(p.unit_number))
         where p.id = new.driver_id limit 1;
      end if;
    end if;
  end if;

  if new.unit_id is not null and (tg_op = 'INSERT' or new.unit_id is distinct from old.unit_id) then
    select * into u from public.units where id = new.unit_id;
    if u.id is null then raise exception 'unit not found'; end if;
    if u.kind <> 'power' then raise exception 'unit % is a trailer, not a truck', u.unit_number; end if;
    if not u.active then raise exception 'unit % is retired', u.unit_number; end if;
    if u.is_demo <> drv_demo then raise exception 'unit % is not available for this driver', u.unit_number; end if;
    new.unit_number := u.unit_number;
  elsif tg_op = 'UPDATE' and new.unit_id is null and old.unit_id is not null then
    new.unit_number := null;
  elsif tg_op = 'UPDATE' and new.unit_id is not distinct from old.unit_id and new.unit_id is not null then
    new.unit_number := old.unit_number;
  end if;
  return new;
end $$;
revoke execute on function public.dispatch_unit_stamp() from public, anon, authenticated;

-- ------------------------------------------------------------
-- protect_dispatch_columns(): + the seven equipment columns. Everything else is
-- the 0015 definition, unchanged.
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
    -- (0017) the equipment on the job is dispatcher-owned
    new.equipment_type_id := old.equipment_type_id;
    new.equipment_name    := old.equipment_name;
    new.equipment_label   := old.equipment_label;
    new.needs_trailer     := old.needs_trailer;
    new.trailer_kind      := old.trailer_kind;
    new.trailer_unit_id   := old.trailer_unit_id;
    new.trailer_number    := old.trailer_number;

    -- (0015) status: a driver may only close their own OPEN job.
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

    -- picked_up_at (0011)
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
