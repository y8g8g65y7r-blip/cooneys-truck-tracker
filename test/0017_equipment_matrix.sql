-- Equipment per job (0017 + equipment seed), simulated sessions. Rolls back by raising its report.
-- Run: node test/run_matrix.js test/0017_equipment_matrix.sql
do $$
declare
  A    constant uuid := '7abb1d58-a160-4d0e-9a24-5f97853ac087';   -- unit 22 test driver
  S    constant uuid := '595ccf2c-50d9-43e8-9c35-4cb73083eca3';   -- Matt (dispatcher)
  DEMO_DRV constant uuid := 'd3b357fc-a8e1-43cd-9b83-a9b9bd5bb0aa';
  DEMO_DSP constant uuid := '01b25bc4-bd99-4703-9e75-0d28fc8e808f';
  tp uuid; tq uuid; tan uuid; slinger uuid; t1101 uuid; t50000 uuid; u10 uuid; p14 uuid;
  j uuid; j2 uuid; res jsonb := '[]'; n int; r record; ok boolean; msg text;
begin
  select id into tp  from equipment_types where seed_key = 'rate:tp';
  select id into tq  from equipment_types where seed_key = 'rate:tq';
  select id into tan from equipment_types where seed_key = 'rate:tandem';
  select id into slinger from equipment_types where seed_key = 'rate:slinger';
  select id into t1101 from units where seed_key = 'axon-t:1101';
  select id into t50000 from units where seed_key = 'axon-t:50000';
  select id into u10 from units where unit_number = '10' and kind = 'power' and active and not is_demo;
  select id into p14 from units where seed_key = 'demo-t:P14';

  -- ----- seed -----
  select count(*) into n from equipment_types where active and confirmed;
  res := res || jsonb_build_object('t', 'seed: 8 active, confirmed rate-sheet types', 'ok', n = 8, 'msg', n);
  select count(*) into n from equipment_types where not active;
  res := res || jsonb_build_object('t', 'seed: Slinger / Water Truck / Low Bed inactive', 'ok', n = 3);
  select count(*) into n from equipment_types where active and seed_key in ('rate:tri-ed','rate:hs-demo-tan','rate:hs-demo-tri','rate:rock-tan','rate:rock-tri') and needs_trailer;
  res := res || jsonb_build_object('t', 'seed: every end-dump type pulls a trailer (Matt)', 'ok', n = 5);
  select count(*) into n from units where kind = 'trailer' and not is_demo;
  res := res || jsonb_build_object('t', 'seed: 27 trailers (26 Axon + Rock Box Tri)', 'ok', n = 27, 'msg', n);
  select count(*) into n from units where kind = 'trailer' and not is_demo and not active;
  res := res || jsonb_build_object('t', 'seed: 50000 (dup) and "not sure" inactive', 'ok', n = 2);
  select trailer_kind into msg from units where seed_key = 'axon-t:rockboxtri';
  res := res || jsonb_build_object('t', 'seed: Rock Box Tri is a demo/rock box trailer', 'ok', msg = 'demo_rock_box');

  -- ----- staff -----
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', S, 'role', 'authenticated')::text, true);
  insert into dispatches (driver_id, site_address, notes, created_by, unit_id, equipment_type_id, trailer_unit_id)
    values (A, 'ZZE tp', 'ZZTEST', S, u10, tp, t1101) returning id into j;
  select * into r from dispatches where id = j;
  res := res || jsonb_build_object('t', 'job with Truck and Pup + trailer 1101: full snapshot',
    'ok', r.equipment_name = 'Truck and Pup (Tri)' and r.equipment_label = 'TANDEM + PUP' and r.needs_trailer and r.trailer_kind = 'pup' and r.trailer_number = '1101' and r.unit_number = '10');
  insert into dispatches (driver_id, site_address, notes, created_by, equipment_type_id, trailer_unit_id)
    values (A, 'ZZE tan', 'ZZTEST', S, tan, t1101) returning id into j2;
  select trailer_unit_id, trailer_number, needs_trailer into r from dispatches where id = j2;
  res := res || jsonb_build_object('t', 'Tandem never carries a trailer (cleared)', 'ok', r.trailer_unit_id is null and r.trailer_number is null and r.needs_trailer = false);
  begin insert into dispatches (driver_id, site_address, notes, created_by, unit_id) values (A, 'ZZE', 'ZZTEST', S, t1101); ok := false;
  exception when others then ok := true; msg := sqlerrm; end;
  res := res || jsonb_build_object('t', 'a trailer cannot be put in the truck slot', 'ok', ok, 'msg', msg);
  begin insert into dispatches (driver_id, site_address, notes, created_by, equipment_type_id, trailer_unit_id) values (A, 'ZZE', 'ZZTEST', S, tp, u10); ok := false;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'a truck cannot be put in the trailer slot', 'ok', ok);
  begin insert into dispatches (driver_id, site_address, notes, created_by, equipment_type_id) values (A, 'ZZE', 'ZZTEST', S, slinger); ok := false;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'an inactive type (Slinger) cannot be used', 'ok', ok);
  begin insert into dispatches (driver_id, site_address, notes, created_by, equipment_type_id, trailer_unit_id) values (A, 'ZZE', 'ZZTEST', S, tp, t50000); ok := false;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'a retired trailer (50000) cannot be used', 'ok', ok);
  insert into dispatches (driver_id, site_address, notes, created_by) values (A, 'ZZE old', 'ZZTEST', S) returning equipment_type_id, equipment_name, trailer_number into r;
  res := res || jsonb_build_object('t', 'old-build send: no equipment (shows "Equipment not set")', 'ok', r.equipment_type_id is null and r.equipment_name is null and r.trailer_number is null);
  update dispatches set equipment_type_id = tq where id = j;
  select equipment_name, trailer_kind, trailer_number into r from dispatches where id = j;
  res := res || jsonb_build_object('t', 'dispatcher changes T&P -> T&Q on an open job (snapshot follows)', 'ok', r.equipment_name = 'Truck and Quad' and r.trailer_kind = 'quad');
  update dispatches set equipment_type_id = tan where id = j;
  select trailer_number, needs_trailer into r from dispatches where id = j;
  res := res || jsonb_build_object('t', '... then to Tandem: trailer comes off', 'ok', r.trailer_number is null and r.needs_trailer = false);
  update dispatches set equipment_type_id = tp, trailer_unit_id = t1101 where id = j;
  update equipment_types set name = 'Truck and Pup RENAMED', driver_label = 'X' where id = tp;
  select equipment_name, equipment_label into r from dispatches where id = j;
  res := res || jsonb_build_object('t', 'history keeps the configuration as it was (type renamed later)', 'ok', r.equipment_name = 'Truck and Pup (Tri)' and r.equipment_label = 'TANDEM + PUP');
  update equipment_types set name = 'Truck and Pup (Tri)', driver_label = 'TANDEM + PUP' where id = tp;
  update equipment_types set confirmed = false where id = tan;
  update equipment_types set confirmed = true where id = tan;
  select updated_by into r from equipment_types where id = tan;
  res := res || jsonb_build_object('t', 'office can flip a trailer flag/confirmation in one update', 'ok', r.updated_by = S);
  select count(*) into n from units where is_demo and kind = 'trailer';
  res := res || jsonb_build_object('t', 'real staff see 0 demo trailers', 'ok', n = 0);
  begin update equipment_types set needs_trailer = true, trailer_kind = 'none' where id = tan; ok := false;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'inconsistent trailer flags refused (needs_trailer without a kind)', 'ok', ok);

  -- ----- driver -----
  execute 'reset role'; execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', A, 'role', 'authenticated')::text, true);
  update dispatches set equipment_type_id = tan, equipment_name = 'X', equipment_label = 'X', needs_trailer = false,
         trailer_kind = 'none', trailer_unit_id = null, trailer_number = 'X' where id = j;
  select * into r from dispatches where id = j;
  res := res || jsonb_build_object('t', 'driver cannot change any equipment field on their job (all 7 clamped)',
    'ok', r.equipment_type_id = tp and r.equipment_name = 'Truck and Pup (Tri)' and r.equipment_label = 'TANDEM + PUP' and r.needs_trailer and r.trailer_kind = 'pup' and r.trailer_unit_id = t1101 and r.trailer_number = '1101');
  update dispatches set accepted_at = now() where id = j;
  select accepted_at into r from dispatches where id = j;
  res := res || jsonb_build_object('t', 'driver Accept still works on an equipment job', 'ok', r.accepted_at is not null);
  select count(*) into n from equipment_types;
  res := res || jsonb_build_object('t', 'driver can read the types (haul ticket list)', 'ok', n = 11);
  update equipment_types set name = 'hacked' where id = tan; get diagnostics n = row_count;
  res := res || jsonb_build_object('t', 'driver cannot edit a type', 'ok', n = 0);

  -- ----- demo -----
  execute 'reset role'; execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', DEMO_DSP, 'role', 'authenticated')::text, true);
  select count(*) into n from equipment_types;
  res := res || jsonb_build_object('t', 'demo dispatcher reads the shared types', 'ok', n = 11);
  begin update equipment_types set name = 'demo hack' where id = tan; get diagnostics n = row_count; ok := n = 0;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'demo dispatcher cannot change the real types', 'ok', ok);
  begin insert into equipment_types (name, driver_label) values ('demo type', 'X'); ok := false;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'demo dispatcher cannot add a type', 'ok', ok);
  begin insert into dispatches (driver_id, site_address, notes, created_by, equipment_type_id, trailer_unit_id) values (DEMO_DRV, 'ZZE', 'ZZTEST', DEMO_DSP, tp, t1101); ok := false;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'demo dispatcher cannot put a real trailer on the demo driver', 'ok', ok);
  select count(*) into n from dispatches where driver_id = DEMO_DRV and status = 'active' and equipment_name = 'Truck and Pup (Tri)' and trailer_number = 'P14';
  res := res || jsonb_build_object('t', 'demo job shows Truck and Pup + demo pup P14', 'ok', n = 1);
  select count(*) into n from dispatches where equipment_type_id is null;
  res := res || jsonb_build_object('t', 'every demo job has equipment (screenshots)', 'ok', n = 0, 'msg', n);

  execute 'reset role';
  select count(*) into n from jsonb_array_elements(res) x where (x->>'ok')::boolean is not true;
  raise exception 'RESULTS fail=% %', n, res::text;
end $$;
