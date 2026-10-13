-- Units per dispatch (0015/0016 + seed) + driver status clamp, simulated sessions.
-- Run: node supabase_mgmt.js sql test/0015_units_matrix.sql   (rolls back by raising its report)
do $$
declare
  A    constant uuid := '7abb1d58-a160-4d0e-9a24-5f97853ac087';   -- unit 22 test driver (profile 22)
  S    constant uuid := '595ccf2c-50d9-43e8-9c35-4cb73083eca3';   -- Matt (dispatcher)
  DARIO constant uuid := '10f9ded6-c900-4028-8bb5-d1a9cf0e2ad1';
  DEMO_DRV constant uuid := 'd3b357fc-a8e1-43cd-9b83-a9b9bd5bb0aa';
  DEMO_DSP constant uuid := '01b25bc4-bd99-4703-9e75-0d28fc8e808f';
  j uuid; j2 uuid; j3 uuid; u10 uuid; u11 uuid; u36 uuid; u62 uuid; nu uuid;
  res jsonb := '[]'; n int; r record; ok boolean; msg text; t timestamptz;
begin
  select id into u10 from units where unit_number = '10' and active and not is_demo;
  select id into u11 from units where unit_number = '11' and not is_demo;
  select id into u36 from units where unit_number = '36' and active and not is_demo;
  select id into u62 from units where unit_number = '62' and is_demo;

  -- ----- seed + backfill -----
  select count(*) into n from units where active and not is_demo;
  res := res || jsonb_build_object('t', 'seed: 23 active real units (Axon power units only)', 'ok', n = 23, 'msg', n);
  select count(*) into n from units where not active and not is_demo;
  res := res || jsonb_build_object('t', 'seed: 6 inactive (11, 24 sold; #87 do not use; 98/90/22 test numbers)', 'ok', n = 6, 'msg', n);
  select count(*) into n from units where source = 'app' and not active and unit_number in ('98', '90', '22');
  res := res || jsonb_build_object('t', 'seed: 98/90/22 kept but retired (test numbers, Matt 2026-10-13)', 'ok', n = 3);
  select count(*) into n from dispatches where driver_id = DARIO and status <> 'active' and (unit_number is distinct from '98');
  res := res || jsonb_build_object('t', 'history: Dario''s closed jobs still show 98', 'ok', n = 0, 'msg', n);
  select count(*) into n from dispatches d join units u on u.id = d.unit_id where d.status = 'active' and not u.active;
  res := res || jsonb_build_object('t', 'no open job carries a retired/test unit', 'ok', n = 0, 'msg', n);
  select count(*) into n from dispatches d join profiles p on p.id = d.driver_id where d.unit_number is null and p.unit_number is not null and d.status <> 'active';
  res := res || jsonb_build_object('t', 'backfill: no closed job left without its unit text', 'ok', n = 0, 'msg', n);

  -- ----- staff: sending and editing the unit -----
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', S, 'role', 'authenticated')::text, true);
  insert into dispatches (driver_id, site_address, notes, created_by, created_at) values (A, 'ZZU default', 'ZZTEST', S, now() - interval '10 minutes') returning id, unit_number into j, msg;
  res := res || jsonb_build_object('t', 'old-build send, driver whose only unit is a retired test number (22): No unit, not 22', 'ok', msg is null, 'msg', msg);
  insert into dispatches (driver_id, site_address, notes, created_by) values (DARIO, 'ZZU dario', 'ZZTEST', S) returning unit_id, unit_number into r;
  res := res || jsonb_build_object('t', 'old-build send for Dario: No unit, never 98', 'ok', r.unit_id is null and r.unit_number is null, 'msg', r.unit_number);
  begin insert into dispatches (driver_id, site_address, notes, created_by, unit_id) values (DARIO, 'ZZU 98', 'ZZTEST', S, (select id from units where seed_key = 'app:98')); ok := false;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'test unit 98 cannot be assigned', 'ok', ok);
  insert into dispatches (driver_id, site_address, notes, created_by, unit_id, created_at) values (A, 'ZZU ten', 'ZZTEST', S, u10, now() - interval '5 minutes') returning id, unit_number into j2, msg;
  res := res || jsonb_build_object('t', 'dispatcher puts the driver in unit 10', 'ok', msg = '10');
  insert into dispatches (driver_id, site_address, notes, created_by, created_at) values (A, 'ZZU next', 'ZZTEST', S, now()) returning id, unit_number into j3, msg;
  res := res || jsonb_build_object('t', 'next job with no unit picked: defaults to the LAST unit (10), not the profile', 'ok', msg = '10', 'msg', msg);
  insert into dispatches (driver_id, site_address, notes, created_by, unit_number) values (A, 'ZZU none', 'ZZTEST', S, '') returning unit_id, unit_number into r;
  res := res || jsonb_build_object('t', 'explicit "No unit" stays empty', 'ok', r.unit_id is null and r.unit_number is null);
  update dispatches set unit_id = u36 where id = j3;
  select unit_number into msg from dispatches where id = j3;
  res := res || jsonb_build_object('t', 'dispatcher changes the unit on an open job (snapshot follows)', 'ok', msg = '36');
  begin insert into dispatches (driver_id, site_address, notes, created_by, unit_id) values (A, 'ZZU sold', 'ZZTEST', S, u11); ok := false;
  exception when others then ok := true; msg := sqlerrm; end;
  res := res || jsonb_build_object('t', 'a sold/retired unit cannot be assigned', 'ok', ok, 'msg', msg);
  begin insert into dispatches (driver_id, site_address, notes, created_by, unit_id) values (A, 'ZZU demo', 'ZZTEST', S, u62); ok := false;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'a demo unit cannot be put on a real driver', 'ok', ok);
  select count(*) into n from units where is_demo;
  res := res || jsonb_build_object('t', 'real staff see 0 demo units', 'ok', n = 0);
  insert into units (unit_number, make, source, is_demo, seed_key) values ('ZZ1', 'Test', 'axon', true, 'forged') returning id into nu;
  select source, is_demo, seed_key into r from units where id = nu;
  res := res || jsonb_build_object('t', 'staff add a unit in the app (source/demo/seed forced)', 'ok', r.source = 'admin' and not r.is_demo and r.seed_key is null);
  update units set active = false where id = nu;
  update units set active = true where id = nu;
  select active, updated_by into r from units where id = nu;
  res := res || jsonb_build_object('t', 'staff retire and reactivate a unit', 'ok', r.active and r.updated_by = S);
  delete from units where id = nu; get diagnostics n = row_count;
  res := res || jsonb_build_object('t', 'no one can delete a unit (retire instead)', 'ok', n = 0);
  begin insert into units (unit_number) values (' 10 '); ok := false;
  exception when unique_violation then ok := true; end;
  res := res || jsonb_build_object('t', 'duplicate active unit number refused', 'ok', ok);

  -- ----- driver: unit and status are locked -----
  execute 'reset role'; execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', A, 'role', 'authenticated')::text, true);
  update dispatches set unit_id = u10, unit_number = '99' where id = j3;
  select unit_id, unit_number into r from dispatches where id = j3;
  res := res || jsonb_build_object('t', 'driver cannot change the unit on their job', 'ok', r.unit_id = u36 and r.unit_number = '36');
  select count(*) into n from units;
  res := res || jsonb_build_object('t', 'driver cannot read the units table', 'ok', n = 0);
  update dispatches set status = 'cancelled' where id = j;
  select status into msg from dispatches where id = j;
  res := res || jsonb_build_object('t', 'driver cannot cancel a job', 'ok', msg = 'active');
  update dispatches set completed_at = now() - interval '3 hours' where id = j;
  select completed_at into t from dispatches where id = j;
  res := res || jsonb_build_object('t', 'driver cannot set completed_at without completing', 'ok', t is null);
  update dispatches set status = 'completed', completed_at = now() - interval '3 hours' where id = j;
  select status, completed_at into r from dispatches where id = j;
  res := res || jsonb_build_object('t', 'driver completes own open job (completed_at = server time)', 'ok', r.status = 'completed' and abs(extract(epoch from r.completed_at - now())) < 2);
  update dispatches set status = 'active' where id = j;
  select status into msg from dispatches where id = j;
  res := res || jsonb_build_object('t', 'driver cannot reopen a completed job', 'ok', msg = 'completed');
  begin update dispatches set status = 'bogus' where id = j2; ok := true; exception when others then ok := true; end;
  select status into msg from dispatches where id = j2;
  res := res || jsonb_build_object('t', 'driver cannot invent a status', 'ok', msg = 'active');

  -- ----- staff can still cancel / reopen -----
  execute 'reset role'; execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', S, 'role', 'authenticated')::text, true);
  update dispatches set status = 'cancelled' where id = j2;
  select status into msg from dispatches where id = j2;
  res := res || jsonb_build_object('t', 'dispatcher can still cancel', 'ok', msg = 'cancelled');

  -- ----- demo -----
  execute 'reset role'; execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', DEMO_DSP, 'role', 'authenticated')::text, true);
  select count(*) into n from units;
  select string_agg(unit_number, ',' order by unit_number) into msg from units;
  res := res || jsonb_build_object('t', 'demo dispatcher sees only demo units 62/74/81', 'ok', n = 3 and msg = '62,74,81', 'msg', msg);
  begin insert into dispatches (driver_id, site_address, notes, created_by, unit_id) values (DEMO_DRV, 'ZZU', 'ZZTEST', DEMO_DSP, u10); ok := false;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'demo dispatcher cannot put a real unit on the demo driver', 'ok', ok);
  select count(*) into n from dispatches where driver_id = DEMO_DRV and status = 'active' and unit_number = '62';
  res := res || jsonb_build_object('t', 'demo driver''s job shows demo unit 62', 'ok', n >= 1);

  execute 'reset role';
  select count(*) into n from jsonb_array_elements(res) x where (x->>'ok')::boolean is not true;
  raise exception 'RESULTS fail=% %', n, res::text;
end $$;
