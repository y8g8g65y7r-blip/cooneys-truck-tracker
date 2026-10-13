-- ============================================================
-- 0016 — Put a unit on every existing job (2026-10-13, VANCE)
--
-- Run AFTER 0015 and supabase/seed/units_seed.sql.
--
-- Before 0015 the only unit anywhere was the driver's profile, and that is
-- what every screen showed for every job. So the honest snapshot for an old
-- job is the unit its driver's profile carries today. That is an ASSUMPTION
-- for history (the app never recorded the truck per job), and it is exactly
-- what the old screens displayed. Where the profile unit is not a listed unit
-- (T1, E1) only the text is kept, with no unit_id.
--
-- Idempotent: only touches jobs that still have neither field. Safe after the
-- demo cleanup (demo_user_ids() is looked up, not called directly).
-- ============================================================
do $$
declare demo uuid[] := '{}';
begin
  if exists (select 1 from pg_proc where proname = 'demo_user_ids' and pronamespace = 'public'::regnamespace) then
    execute 'select public.demo_user_ids()' into demo;
  end if;

  update public.dispatches d
     set unit_id = x.id
    from public.profiles p, public.units x
   where d.unit_id is null and d.unit_number is null
     and p.id = d.driver_id
     and x.active
     and lower(x.unit_number) = lower(btrim(p.unit_number))
     and x.is_demo = (d.driver_id = any(demo));

  update public.dispatches d
     set unit_number = btrim(p.unit_number)
    from public.profiles p
   where d.unit_id is null and d.unit_number is null
     and p.id = d.driver_id
     and nullif(btrim(p.unit_number), '') is not null;
end $$;
