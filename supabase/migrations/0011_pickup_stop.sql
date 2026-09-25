-- ============================================================
-- 0011 — Optional pickup stop on a dispatch (pickup -> drop-off)
--
-- Matt: "Say they had to pick up material at Burnco, but then they had to go
-- to a job site to drop it off. I want to be able to send both so I don't have
-- to watch them to find out when they're at Burnco to make them have a new
-- dispatch."
--
-- Shape: the existing site_address / lat / lng stay the DROP-OFF, untouched, so
-- every existing single-stop dispatch (and every installed build that only
-- knows about site_address) behaves exactly as before. The pickup is four
-- nullable columns; pickup_address IS NULL means "single-stop job", full stop.
-- Stage is derived, never stored as its own enum:
--     pickup_address null                -> single stop (as today)
--     picked_up_at null                  -> To pickup
--     picked_up_at set                   -> Loaded, to drop-off
--     status completed / cancelled       -> Completed / Cancelled
--
-- Deliberately NOT a round-trip counter (Matt rejected that in August). A
-- Burnco <-> site shuttle marks Loaded once; the legs breakdown already names
-- the repeat runs from the GPS trail.
--
-- Idempotent: safe to re-run. Must ALSO be applied to the dormant CA clone
-- (ydxwitelfwjbgurrgmnj) at cutover — see the migration plan.
-- ============================================================

-- 1. Columns ------------------------------------------------------------------
alter table public.dispatches add column if not exists pickup_name    text;
alter table public.dispatches add column if not exists pickup_address text;
alter table public.dispatches add column if not exists pickup_lat     numeric;
alter table public.dispatches add column if not exists pickup_lng     numeric;
alter table public.dispatches add column if not exists picked_up_at   timestamptz;
alter table public.dispatches add column if not exists pickup_source  text;

alter table public.dispatches drop constraint if exists dispatches_pickup_source_check;
alter table public.dispatches add constraint dispatches_pickup_source_check
  check (pickup_source is null or pickup_source in ('tap', 'geofence', 'undone', 'dispatch'));

comment on column public.dispatches.pickup_address is
  'Optional first stop (e.g. Burnco pit). NULL = single-stop dispatch; site_address/lat/lng are always the drop-off.';
comment on column public.dispatches.picked_up_at is
  'When the load was picked up. Server time: stamped by the protect trigger on a driver tap, or by advance_pickups_by_geofence() when the truck leaves the pickup.';
comment on column public.dispatches.pickup_source is
  'How picked_up_at was set: tap (driver), geofence (auto), dispatch (office). undone = driver reverted it; also switches the geofence off for this job so it cannot re-fire.';

-- 2. The protect trigger -------------------------------------------------------
-- NOTE on how this trigger actually works (the memory file had it backwards):
-- it is a DENY-list. It resets the columns named below and lets everything
-- else through. So:
--   * the four pickup_* location columns MUST be added here, or a driver could
--     rewrite where the pickup is;
--   * picked_up_at / pickup_source are handled explicitly so the timestamp is
--     always server time and the source cannot be forged as 'geofence'.
-- Admin/dispatcher (and the service/cron path, where auth.uid() is null) skip
-- this branch entirely.
create or replace function public.protect_dispatch_columns()
returns trigger as $$
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
$$ language plpgsql security definer;

-- 3. Auto-advance when the truck leaves the pickup -----------------------------
-- Server-side on purpose, not in the phone:
--   * it works whether or not iOS has the app's JS running in the background;
--   * it needs no new build to change the thresholds;
--   * a tap is never required for anything — tracking does not depend on it,
--     and neither does the stage (this is the fallback when nobody taps).
--
-- Rule: a "visit" is a run of pings that never goes further than OUT_M from the
-- pickup and contains at least one ping within IN_M. The visit counts as a
-- load when the first-to-last in-radius pings span >= DWELL and a later ping
-- lands beyond OUT_M (the truck has actually left). picked_up_at = the last
-- in-radius ping of that visit, i.e. when it drove away loaded.
--   * A drive-past (seconds inside) never qualifies — dwell guard.
--   * A truck still sitting at the pit never qualifies — exit guard.
--   * Low-accuracy fixes (> 100 m) are ignored so one GPS jump cannot fake an exit.
--   * A job with no pickup coordinates (dispatcher skipped "Find") is simply
--     never auto-advanced; the tap still works.
--   * pickup_source = 'undone' (driver reverted it) switches this off for the job.
-- Thresholds are arguments so they can be tuned with a one-line cron change.
create or replace function public.advance_pickups_by_geofence(
  in_m      numeric  default 250,
  out_m     numeric  default 500,
  dwell     interval default interval '3 minutes',
  lookback  interval default interval '24 hours'
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  r        record;
  hit      timestamptz;
  advanced integer := 0;
begin
  for r in
    select d.id, d.driver_id, d.pickup_lat::float8 as plat, d.pickup_lng::float8 as plng,
           greatest(d.created_at, now() - lookback) as since
      from public.dispatches d
     where d.status = 'active'
       and d.picked_up_at is null
       and d.pickup_address is not null
       and d.pickup_lat is not null and d.pickup_lng is not null
       and d.pickup_source is distinct from 'undone'
  loop
    with p as (
      select l.created_at,
             -- equirectangular distance: exact enough at these ranges (< 0.1%
             -- error inside a few km) and needs no PostGIS.
             6371000 * sqrt(
               power(radians(l.lat::float8 - r.plat), 2) +
               power(radians(l.lng::float8 - r.plng) * cos(radians(r.plat)), 2)
             ) as dist
        from public.location_updates l
       where l.user_id = r.driver_id
         and l.created_at >= r.since
         and (l.accuracy is null or l.accuracy <= 100)
    ), z as (
      select created_at, dist,
             -- visit number = how many "out" pings came before this one
             count(*) filter (where dist > out_m) over (order by created_at) as outs_so_far
        from p
    ), visits as (
      select outs_so_far as v,
             min(created_at) filter (where dist <= in_m) as first_in,
             max(created_at) filter (where dist <= in_m) as last_in
        from z
       where dist <= out_m
       group by outs_so_far
    ), exits as (
      -- the (v+1)-th out ping ends visit v
      select outs_so_far - 1 as v, min(created_at) as exit_at
        from z
       where dist > out_m
       group by outs_so_far
    )
    select vi.last_in into hit
      from visits vi
      join exits e on e.v = vi.v
     where vi.first_in is not null
       and vi.last_in - vi.first_in >= dwell
     order by vi.v
     limit 1;

    if hit is not null then
      update public.dispatches
         set picked_up_at = hit, pickup_source = 'geofence'
       where id = r.id and picked_up_at is null and status = 'active';
      advanced := advanced + 1;
    end if;
  end loop;
  return advanced;
end;
$$;

revoke all on function public.advance_pickups_by_geofence(numeric, numeric, interval, interval) from public, anon, authenticated;

-- 4. Schedule it -----------------------------------------------------------------
-- Every 2 minutes. Pure SQL, no Edge Function, no secret, no push. The update
-- rides the existing supabase_realtime publication on dispatches, so the
-- driver's card and the dispatch board flip on their own.
-- AT CUTOVER: on the CA clone create this job and it can be left active — it
-- only reads pings and stamps picked_up_at, it sends nothing to a phone.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'advance-pickups') then
    perform cron.unschedule('advance-pickups');
  end if;
  perform cron.schedule('advance-pickups', '*/2 * * * *', 'select public.advance_pickups_by_geofence()');
end $$;
