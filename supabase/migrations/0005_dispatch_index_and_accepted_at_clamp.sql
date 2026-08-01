-- ============================================================
-- Cooney's Trucking — Migration 0005: dispatch index + accepted_at clamp
--
-- Adds:
--   * dispatches_status_created_idx (status, created_at desc). Three query paths
--     added in 1425877 filter on status alone and sort by created_at:
--       - dispatcher.html loadHistory()          status IN ('completed','cancelled')
--       - dispatcher.html loadActiveDispatches() status = 'active'
--       - map.html                               status = 'active', every 15s
--     NOTE, corrected after measuring on the live database: the existing
--     (driver_id, status) index IS usable for a status-only predicate — Postgres
--     picks a Bitmap Index Scan, which does not require the leading column.
--     EXPLAIN on the live History query confirms it does exactly that today.
--     What that plan cannot do is satisfy the ORDER BY, so it always adds a
--     Sort node. This index removes the sort and makes the access pattern
--     index-ordered. At today's volume (9 rows) the difference is noise; the
--     point is that dispatches grows monotonically with every job the company
--     ever runs and has no retention policy, and .limit(N) caps rows RETURNED,
--     not rows scanned. This is precautionary, not a fix for a live problem.
--
--   * protect_dispatch_columns() now clamps accepted_at for non-privileged
--     callers. 0004 deliberately left it unclamped, which is not a privilege
--     hole (RLS still restricts a driver to their own rows) but does mean the
--     timestamp is written from the DEVICE clock and can be set to any value,
--     or cleared entirely. A phone with a wrong timezone silently records the
--     wrong acceptance time, and nothing prevents backdating. Now: set once, at
--     server time, never backdated, never un-accepted.
--     Admins/dispatchers are unaffected and can still correct a value by hand.
--
-- Run once in: Supabase Dashboard -> SQL Editor -> New Query. Safe to re-run.
-- Depends on: setup.sql (get_my_role, protect_dispatch_columns_trg), 0004.
-- ============================================================

-- ------------------------------------------------------------
-- 0. Fail loudly if 0004 has not run. The clamp below references
--    NEW.accepted_at, which plpgsql resolves at RUN time, not CREATE time — so
--    without this guard 0005 would apply cleanly and then break every driver's
--    dispatch update at the first Accept.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'dispatches' and column_name = 'accepted_at'
  ) then
    raise exception 'Migration 0004 must be applied before 0005 (public.dispatches.accepted_at is missing)';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. Index for status-led dispatch queries.
-- ------------------------------------------------------------
create index if not exists dispatches_status_created_idx
  on public.dispatches (status, created_at desc);

-- ------------------------------------------------------------
-- 2. accepted_at: set-once, server-stamped, for non-privileged callers.
--    Replaced in place — the existing BEFORE UPDATE trigger
--    protect_dispatch_columns_trg keeps pointing at this function.
-- ------------------------------------------------------------
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

    -- Deliberately NOT a blanket "always now()": that would stamp an
    -- acceptance time onto a job the driver only ever marked complete.
    if old.accepted_at is not null then
      new.accepted_at := old.accepted_at;   -- immutable once set; cannot be cleared
    elsif new.accepted_at is not null then
      new.accepted_at := now();             -- first accept: ignore the device clock
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer;
