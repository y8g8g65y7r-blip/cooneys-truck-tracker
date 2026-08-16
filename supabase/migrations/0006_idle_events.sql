-- ============================================================
-- 0006 — Idle detection: heartbeat provenance + open/closed idle events
--
-- Context: the native app only wrote a GPS row when the truck moved 40m
-- (distanceFilter), so a parked truck produced ZERO rows and the system went
-- completely silent exactly when dispatch most wants to know what is going on.
-- dashboard.html now also writes a "heartbeat" row every ~90s while stationary.
-- `source` records which of the two wrote the row, so a query can prove the
-- heartbeat actually reached a given device — which matters here, because the
-- native app is fully bundled and never picks up a www/ change without a
-- rebuild and reinstall.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- 1. Ping provenance ---------------------------------------------------------
alter table public.location_updates
  add column if not exists source text;

comment on column public.location_updates.source is
  'Who wrote this ping: ''move'' (distanceFilter fired), ''heartbeat'' (parked keep-alive), null (build predating 0006).';

-- 2. Idle events -------------------------------------------------------------
-- One row per continuous stationary period that crossed the alert threshold.
-- Written ONLY by the check-idle-drivers Edge Function under the service role,
-- which bypasses RLS — that is why there is deliberately no insert/update
-- policy below. A driver must never be able to close their own idle event.
create table if not exists public.idle_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  started_at   timestamptz not null,          -- first ping of the stationary run
  last_ping_at timestamptz not null,          -- newest ping still at the same spot
  ended_at     timestamptz,                   -- null = still parked right now
  lat          numeric,
  lng          numeric,
  dispatch_id  uuid references public.dispatches on delete set null,
  notified_at  timestamptz,                   -- push sent; guards against re-notifying
  created_at   timestamptz not null default now()
);

-- At most one OPEN event per driver. A partial unique index, not application
-- logic: the cron can overlap itself if a run is slow, and two open events for
-- one truck would double-notify and double-flag the map.
create unique index if not exists idle_events_one_open_per_user
  on public.idle_events (user_id) where ended_at is null;

create index if not exists idle_events_user_started_idx
  on public.idle_events (user_id, started_at desc);

alter table public.idle_events enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'idle_events' and policyname = 'Drivers view own idle events') then
    create policy "Drivers view own idle events" on public.idle_events
      for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'idle_events' and policyname = 'Admins view all idle events') then
    create policy "Admins view all idle events" on public.idle_events
      for select using (public.get_my_role() in ('admin', 'dispatcher'));
  end if;
end $$;
