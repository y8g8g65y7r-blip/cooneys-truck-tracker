-- ============================================================
-- Cooney's Trucking — Migration 0004: dispatch acceptance + push tokens
--
-- Adds:
--   * dispatches.accepted_at  — set by the driver tapping "Accept" in the app.
--     Not clamped by protect_dispatch_columns() (new column, not in its reset
--     list), so the existing "Drivers update own dispatch status" RLS policy
--     already lets a driver set this on their own row — no policy/trigger
--     change needed.
--   * profiles.push_token — the device's APNs push token, saved by the app
--     after Capacitor Push Notifications registration. Already writable by the
--     owning driver under the existing "Users update own profile" policy
--     (push_token isn't a privileged column, so protect_profile_privileged_
--     columns() doesn't touch it) — no policy/trigger change needed either.
--   * Enables Supabase Realtime on public.dispatches so the dispatcher and
--     driver UIs update instantly on insert/accept/complete instead of
--     waiting on the poll interval.
--
-- Run once in: Supabase Dashboard -> SQL Editor -> New Query. Safe to re-run.
-- ============================================================

alter table public.dispatches
  add column if not exists accepted_at timestamptz;

alter table public.profiles
  add column if not exists push_token text;

-- Realtime: add dispatches to the publication if not already a member.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'dispatches'
  ) then
    alter publication supabase_realtime add table public.dispatches;
  end if;
end $$;
