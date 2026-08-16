-- ============================================================
-- 0007 — Schedule check-idle-drivers
--
-- The idle alert has to fire when nobody is looking at the app, so it cannot be
-- a client-side "compute it when the map refreshes" check. pg_cron calls the
-- Edge Function every 3 minutes; the function itself decides what is idle.
--
-- PREREQUISITE (run once, NOT committed — it carries the service role key):
--   select vault.create_secret('<service role key>', 'service_role_key',
--                              'Used by the check-idle-drivers cron job');
-- The key is read out of Vault at call time rather than being written into the
-- job body, so it never lands in cron.job / pg_dump / this repository.
--
-- Idempotent: safe to re-run.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'check-idle-drivers') then
    perform cron.unschedule('check-idle-drivers');
  end if;
end $$;

-- Every 3 minutes. The threshold is 10 minutes, so this detects a stopped truck
-- within ~13 minutes worst case — close enough to be a useful nudge without
-- billing an Edge Function invocation every single minute.
select cron.schedule(
  'check-idle-drivers',
  '*/3 * * * *',
  $job$
  select net.http_post(
    url := 'https://xpntyinplxjvjeotbnnf.supabase.co/functions/v1/check-idle-drivers',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
  $job$
);
