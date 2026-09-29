-- ============================================================
-- 0012 — Called-in load events (dispatcher logs "loaded" / "dumped")
--
-- Matt (2026-09-29): "he told me he unloaded and loaded again but I don't see
-- anywhere to input that info when he tells me." dispatches.picked_up_at is a
-- single stage flag (to pickup -> to drop-off); a shuttle job loads and dumps
-- many times. This is the office's log of each one as the driver phones it in.
--
-- Deliberately:
--   * its own table, NOT columns on dispatches (the haul_tickets precedent),
--     so it never touches protect_dispatch_columns();
--   * written by STAFF only. Matt rejected a driver round-trip button in
--     August; this needs no driver tap at all. `source` allows 'driver' and
--     'geofence' so either can be added later without a migration, but no
--     policy lets a driver write today;
--   * NOT haul_tickets.load_detail. That jsonb is a snapshot inside a
--     driver-submitted ticket at job completion (and still unused). This is the
--     live record during the job; a ticket's per-load table should be pre-filled
--     FROM these rows when that form is built, not the other way round.
--
-- driver_id is copied from the dispatch by the trigger (never trusted from the
-- client) so RLS and the demo isolation policy need no join.
--
-- Idempotent: safe to re-run. Must ALSO be applied to the dormant CA clone
-- (ydxwitelfwjbgurrgmnj) at cutover — see migration plan section 6.3a.
-- ============================================================

create table if not exists public.dispatch_load_events (
  id           uuid primary key default gen_random_uuid(),
  dispatch_id  uuid not null references public.dispatches on delete cascade,
  driver_id    uuid not null references auth.users on delete cascade,
  kind         text not null check (kind in ('loaded', 'dumped')),
  event_at     timestamptz not null,
  note         text check (note is null or char_length(note) <= 300),
  source       text not null default 'dispatcher' check (source in ('dispatcher', 'driver', 'geofence')),
  entered_by   uuid references auth.users on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz,
  updated_by   uuid references auth.users on delete set null
);

create index if not exists dispatch_load_events_dispatch_idx
  on public.dispatch_load_events (dispatch_id, event_at);

comment on table public.dispatch_load_events is
  'Loads/dumps the driver called in, logged by dispatch. Authoritative over GPS-inferred boundaries in the round-trip table (www/legs.js roundTrips).';

-- Server-owned fields: driver_id from the dispatch, who entered/edited it, and
-- a sanity bound on the time (a phone-in can be late, never from the future).
create or replace function public.dispatch_load_events_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    new.dispatch_id := old.dispatch_id;
    new.driver_id   := old.driver_id;
    new.entered_by  := old.entered_by;
    new.created_at  := old.created_at;
    new.source      := old.source;
    new.updated_at  := now();
    new.updated_by  := auth.uid();
  else
    select d.driver_id into new.driver_id from public.dispatches d where d.id = new.dispatch_id;
    if new.driver_id is null then
      raise exception 'dispatch % not found', new.dispatch_id;
    end if;
    if auth.uid() is not null then
      new.entered_by := auth.uid();
      new.source     := 'dispatcher';   -- only staff can insert (RLS); never forgeable
    end if;
    new.created_at := now();
  end if;
  if new.event_at > now() + interval '5 minutes' then
    raise exception 'event time is in the future';
  end if;
  return new;
end $$;

drop trigger if exists dispatch_load_events_stamp on public.dispatch_load_events;
create trigger dispatch_load_events_stamp
  before insert or update on public.dispatch_load_events
  for each row execute function public.dispatch_load_events_stamp();

revoke execute on function public.dispatch_load_events_stamp() from public, anon, authenticated;

alter table public.dispatch_load_events enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'dispatch_load_events' and policyname = 'Drivers view own load events') then
    create policy "Drivers view own load events" on public.dispatch_load_events
      for select to authenticated using (driver_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'dispatch_load_events' and policyname = 'Staff view load events') then
    create policy "Staff view load events" on public.dispatch_load_events
      for select to authenticated using (public.get_my_role() in ('admin', 'dispatcher'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'dispatch_load_events' and policyname = 'Staff log load events') then
    create policy "Staff log load events" on public.dispatch_load_events
      for insert to authenticated with check (public.get_my_role() in ('admin', 'dispatcher'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'dispatch_load_events' and policyname = 'Staff correct load events') then
    create policy "Staff correct load events" on public.dispatch_load_events
      for update to authenticated
      using (public.get_my_role() in ('admin', 'dispatcher'))
      with check (public.get_my_role() in ('admin', 'dispatcher'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'dispatch_load_events' and policyname = 'Staff delete load events') then
    create policy "Staff delete load events" on public.dispatch_load_events
      for delete to authenticated using (public.get_my_role() in ('admin', 'dispatcher'));
  end if;
end $$;

-- App Store demo isolation (Part 11). Only while the demo exists: the demo
-- cleanup block drops this policy before it drops demo_user_ids().
do $$
begin
  if exists (select 1 from pg_proc where proname = 'demo_user_ids' and pronamespace = 'public'::regnamespace) then
    execute 'drop policy if exists demo_isolation on public.dispatch_load_events';
    execute $p$create policy demo_isolation on public.dispatch_load_events as restrictive for all to public
      using (coalesce((select auth.uid()) = any(public.demo_user_ids()), false) = coalesce(driver_id = any(public.demo_user_ids()), false))
      with check (coalesce((select auth.uid()) = any(public.demo_user_ids()), false) = coalesce(driver_id = any(public.demo_user_ids()), false))$p$;
  end if;
end $$;

-- Live updates on the dispatcher detail and the driver's job card.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                 and schemaname = 'public' and tablename = 'dispatch_load_events') then
    alter publication supabase_realtime add table public.dispatch_load_events;
  end if;
end $$;
