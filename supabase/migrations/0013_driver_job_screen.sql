-- ============================================================
-- 0013 — Driver job screen (2026-10-12, VANCE)
--
-- Matt (after talking with Dario): once a driver accepts a job they land IN the
-- job, where they can tell dispatch when they are loaded and unloaded, write
-- notes, and talk to dispatch. "Get Directions" goes; the driver hands the
-- destination to their OWN maps app, behind a route-responsibility notice
-- (SADIE draft, Option A, approved by Matt 2026-10-12) whose acknowledgement is
-- logged.
--
-- Nothing here adds a column to public.dispatches, so protect_dispatch_columns()
-- (a DENY-list) is untouched. All four parts are additive and backward
-- compatible with TestFlight builds 5/6 and the current web app.
--
--   1. dispatch_load_events: DRIVERS may now insert their own Loaded/Unloaded
--      taps (source 'driver'). This reverses the August "no driver round-trip
--      button" rule on Matt's 2026-10-12 instruction. Staff path unchanged.
--   2. dispatch_messages.kind: 'message' (pushes the other side, as before) or
--      'note' (a job note for the record; no push).
--   3. nav_handoffs: append-only evidence log of every "Open in Maps" handoff,
--      with the notice text shown and whether it was acknowledged.
--   4. app_settings: server-side copy of the notice text, so swapping the
--      wording (or the acknowledgement line) is a SQL update, not a rebuild.
--      The app bundles the same text as a fallback for a cold start offline.
--
-- Idempotent: safe to re-run. Must ALSO be applied to the dormant CA clone
-- (ydxwitelfwjbgurrgmnj) at cutover — see migration plan section 6.3a.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Driver-logged load events
-- ------------------------------------------------------------
create or replace function public.dispatch_load_events_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  d record;
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
    select x.id, x.driver_id, x.status, x.created_at, x.pickup_address, x.picked_up_at
      into d from public.dispatches x where x.id = new.dispatch_id;
    if d.id is null then
      raise exception 'dispatch % not found', new.dispatch_id;
    end if;
    new.driver_id := d.driver_id;
    if auth.uid() is not null then
      new.entered_by := auth.uid();
      if public.get_my_role() in ('admin', 'dispatcher') then
        new.source := 'dispatcher';      -- staff log (0012), never forgeable
      else
        -- A driver's own tap (0013). The source is forced; RLS then requires
        -- the job to be theirs. A tap queued in a dead zone arrives late but
        -- carries the moment it was tapped, so the time is the driver's,
        -- bounded: never more than 24 h old, never before the job was sent,
        -- never in the future (below).
        new.source := 'driver';
        if new.event_at is null then new.event_at := now(); end if;
        if new.event_at < now() - interval '24 hours' then
          raise exception 'event time is more than 24 hours old';
        end if;
        if new.event_at < d.created_at - interval '10 minutes' then
          raise exception 'event time is before the job was sent';
        end if;
        -- The first Loaded on a two-stop job also moves the job to "to
        -- drop-off", exactly like the old one-shot Loaded button. The update
        -- runs in this session, so protect_dispatch_columns() stamps it with
        -- server time and source 'tap' (and a rejected insert rolls it back).
        if new.kind = 'loaded' and d.driver_id = auth.uid() and d.status = 'active'
           and d.pickup_address is not null and d.picked_up_at is null then
          update public.dispatches set picked_up_at = now() where id = d.id;
        end if;
      end if;
    end if;
    new.created_at := now();
  end if;
  if new.event_at > now() + interval '5 minutes' then
    raise exception 'event time is in the future';
  end if;
  return new;
end $$;

revoke execute on function public.dispatch_load_events_stamp() from public, anon, authenticated;

do $$
begin
  -- Own job, open (or closed within the last 24 h, so a tap queued offline
  -- still lands after the driver closed the job). Never on a cancelled job.
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'dispatch_load_events' and policyname = 'Drivers log own load events') then
    create policy "Drivers log own load events" on public.dispatch_load_events
      for insert to authenticated
      with check (
        source = 'driver'
        and driver_id = auth.uid()
        and exists (
          select 1 from public.dispatches d
           where d.id = dispatch_load_events.dispatch_id
             and d.driver_id = auth.uid()
             and (d.status = 'active'
                  or (d.status = 'completed' and d.completed_at > now() - interval '24 hours'))
        )
      );
  end if;
  -- Deliberately no driver UPDATE or DELETE: a mis-tap is undone on the phone
  -- inside a short window BEFORE it is sent; after that, dispatch corrects it.
end $$;

-- ------------------------------------------------------------
-- 2. Job notes ride the message thread
-- ------------------------------------------------------------
alter table public.dispatch_messages add column if not exists kind text not null default 'message';
alter table public.dispatch_messages drop constraint if exists dispatch_messages_kind_check;
alter table public.dispatch_messages add constraint dispatch_messages_kind_check check (kind in ('message', 'note'));

-- The demo DRIVER could not send messages at all (Part 11), because
-- send-message-push fanned a driver's message out to every real dispatcher's
-- phone as service role. That function now refuses any demo sender or demo job
-- (deployed 2026-10-12 before this migration), so the insert block can go and
-- the demo account can show a real reply. RLS still keeps every demo message
-- invisible to real accounts and vice versa.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'demo_user_ids' and pronamespace = 'public'::regnamespace) then
    execute 'drop policy if exists demo_isolation on public.dispatch_messages';
    execute $p$create policy demo_isolation on public.dispatch_messages as restrictive for all to public
      using (coalesce((select auth.uid()) = any(public.demo_user_ids()), false) = coalesce(sender_id = any(public.demo_user_ids()), false))
      with check (coalesce((select auth.uid()) = any(public.demo_user_ids()), false) = coalesce(sender_id = any(public.demo_user_ids()), false))$p$;
  end if;
end $$;

-- ------------------------------------------------------------
-- 3. "Open in Maps" handoff log (route-responsibility evidence trail)
-- ------------------------------------------------------------
-- user_id is deliberately NOT a foreign key: this is an evidence trail and must
-- outlive the account. The name and unit are snapshotted for the same reason.
create table if not exists public.nav_handoffs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,
  full_name       text,
  unit_number     text,
  dispatch_id     uuid references public.dispatches on delete set null,
  stop_kind       text check (stop_kind is null or stop_kind in ('pickup', 'dropoff')),
  nav_app         text not null check (nav_app in ('apple', 'google', 'waze', 'copy')),
  dest_text       text check (dest_text is null or char_length(dest_text) <= 500),
  dest_lat        double precision,
  dest_lng        double precision,
  launch_url      text check (launch_url is null or char_length(launch_url) <= 1000),
  notice_version  text not null check (char_length(notice_version) between 1 and 40),
  notice_text     text not null check (char_length(notice_text) between 1 and 2000),
  ack_text        text check (ack_text is null or char_length(ack_text) <= 500),
  ack_state       text not null check (ack_state in ('ticked', 'on_file', 'not_required')),
  app_version     text check (app_version is null or char_length(app_version) <= 60),
  web_build       text check (web_build is null or char_length(web_build) <= 60),
  platform        text check (platform is null or char_length(platform) <= 20),
  client_at       timestamptz,
  created_at      timestamptz not null default now()
);

comment on table public.nav_handoffs is
  'Every Open-in-Maps handoff from the driver app: destination passed (never a route), the route-responsibility notice shown, and whether the driver ticked the acknowledgement (ticked), had already ticked this notice version on this app build (on_file), or none was required. Append-only. created_at is server time; client_at is the phone''s claim.';

create index if not exists nav_handoffs_user_idx on public.nav_handoffs (user_id, created_at);

create or replace function public.nav_handoffs_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
  end if;
  select p.full_name, p.unit_number into new.full_name, new.unit_number
    from public.profiles p where p.id = new.user_id;
  new.created_at := now();
  return new;
end $$;

revoke execute on function public.nav_handoffs_stamp() from public, anon, authenticated;

drop trigger if exists nav_handoffs_stamp on public.nav_handoffs;
create trigger nav_handoffs_stamp
  before insert on public.nav_handoffs
  for each row execute function public.nav_handoffs_stamp();

alter table public.nav_handoffs enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'nav_handoffs' and policyname = 'Users log own nav handoffs') then
    create policy "Users log own nav handoffs" on public.nav_handoffs
      for insert to authenticated
      with check (
        user_id = auth.uid()
        and (dispatch_id is null or exists (
          select 1 from public.dispatches d where d.id = nav_handoffs.dispatch_id and d.driver_id = auth.uid()))
      );
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'nav_handoffs' and policyname = 'Users view own nav handoffs') then
    create policy "Users view own nav handoffs" on public.nav_handoffs
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'nav_handoffs' and policyname = 'Staff view nav handoffs') then
    create policy "Staff view nav handoffs" on public.nav_handoffs
      for select to authenticated using (public.get_my_role() in ('admin', 'dispatcher'));
  end if;
  -- No UPDATE or DELETE policy for anyone: it is a record of what was shown.
end $$;

do $$
begin
  if exists (select 1 from pg_proc where proname = 'demo_user_ids' and pronamespace = 'public'::regnamespace) then
    execute 'drop policy if exists demo_isolation on public.nav_handoffs';
    execute $p$create policy demo_isolation on public.nav_handoffs as restrictive for all to public
      using (coalesce((select auth.uid()) = any(public.demo_user_ids()), false) = coalesce(user_id = any(public.demo_user_ids()), false))
      with check (coalesce((select auth.uid()) = any(public.demo_user_ids()), false) = coalesce(user_id = any(public.demo_user_ids()), false))$p$;
  end if;
end $$;

-- ------------------------------------------------------------
-- 4. Server-side app settings (the notice text lives here)
-- ------------------------------------------------------------
create table if not exists public.app_settings (
  key         text primary key check (key ~ '^[a-z0-9_]{1,40}$'),
  value       jsonb not null,
  note        text,
  updated_at  timestamptz not null default now()
);

alter table public.app_settings enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'app_settings' and policyname = 'Signed-in users read app settings') then
    create policy "Signed-in users read app settings" on public.app_settings
      for select to authenticated using (true);
  end if;
  -- No write policy: changed only through the SQL editor / Management API,
  -- never from the app.
end $$;

-- Seeded once. Re-running the migration never overwrites a later wording change.
insert into public.app_settings (key, value, note) values (
  'nav_notice',
  jsonb_build_object(
    'version', '2026-10-12-A',
    'text', 'Maps opens with the destination address only. The route is your choice and your responsibility. Check your truck''s height and weight against the signs on the road. Set it up while parked.',
    'ack_required', true,
    'ack_text', 'I understand my map app does not know my truck''s size, and I choose my own route.',
    'start_directions', false
  ),
  'Route-responsibility notice, SADIE draft Option A. Approved by Matt Kelly 2026-10-12 (relayed by GORDON). Gate category 3. Bump "version" whenever "text" or "ack_text" changes so every driver re-acknowledges.'
) on conflict (key) do nothing;
