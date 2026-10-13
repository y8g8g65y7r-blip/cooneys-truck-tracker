-- ============================================================
-- 0014 — Pilot gate for the new driver screens (2026-10-13, VANCE)
--
-- Matt 2026-10-13: release the new driver job screen (0013, www/driver.html)
-- to Dario only; every other driver keeps today's screens. The web app and the
-- native app share www/, so the switch has to be per USER, not per deploy:
-- www/dashboard.html (today's screen, unchanged otherwise) asks
-- public.driver_ui_pilot() at sign-in and sends pilot users to driver.html.
-- Any doubt (offline, error, slow) keeps the driver on today's screen.
--
-- Widening the pilot is a SQL update to the 'driver_ui_pilot' row: no app
-- rebuild, no redeploy. Set "all": true to give it to every driver.
--
-- Pilot list at launch:
--   Dario Lazic (98)        the pilot driver
--   Matt (Test Driver) T1   Matt's own driver login, to see it working
--   Jordan Reyes (62)       fictional App Store demo driver (isolated data)
--
-- Idempotent. Apply to the CA clone at cutover (migration plan 6.3a).
-- ============================================================

insert into public.app_settings (key, value, note) values (
  'driver_ui_pilot',
  jsonb_build_object('all', false, 'user_ids', jsonb_build_array(
    '10f9ded6-c900-4028-8bb5-d1a9cf0e2ad1',   -- Dario Lazic, unit 98
    '22497663-bc5b-493d-87e6-418c2afa073b',   -- Matt (Test Driver), T1
    'd3b357fc-a8e1-43cd-9b83-a9b9bd5bb0aa'    -- Jordan Reyes (demo), 62
  )),
  'Who gets the new driver job screen (driver.html). Matt 2026-10-13: Dario only, plus Matt''s T1 test driver and the demo driver. "all": true rolls it out to every driver with no rebuild.'
) on conflict (key) do nothing;

-- Answers only "am I in the pilot?" for the caller; the list itself is not
-- readable by drivers (see the policy change below).
create or replace function public.driver_ui_pilot()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select coalesce((s.value->>'all')::boolean, false)
        or coalesce((s.value->'user_ids') ? (auth.uid())::text, false)
      from public.app_settings s
     where s.key = 'driver_ui_pilot'
  ), false)
$$;

revoke execute on function public.driver_ui_pilot() from public, anon;
grant execute on function public.driver_ui_pilot() to authenticated;

-- app_settings was readable in full by any signed-in user (0013). Make that an
-- explicit allow-list of the settings the app needs to read, so a private one
-- (like the pilot list) never leaks to a driver.
do $$
begin
  execute 'drop policy if exists "Signed-in users read app settings" on public.app_settings';
  execute $p$create policy "Signed-in users read app settings" on public.app_settings
    for select to authenticated using (key in ('nav_notice'))$p$;
end $$;
