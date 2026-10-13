-- Old-client compatibility (TestFlight builds 5/6 = commit c694931) against the
-- schema after 0013 + 0014. Replays the exact reads/writes the OLD dashboard.html
-- and dispatcher.html make, as simulated sessions, then rolls everything back by
-- raising the report. Run: node supabase_mgmt.js sql test/old_client_compat.sql
-- haul_tickets is deliberately not exercised: its ticket_no sequence does not
-- roll back, and neither migration touches that table.
do $$
declare
  A  constant uuid := '7abb1d58-a160-4d0e-9a24-5f97853ac087';   -- unit 22 test driver
  S  constant uuid := '595ccf2c-50d9-43e8-9c35-4cb73083eca3';   -- Matt (dispatcher)
  j1 uuid := gen_random_uuid(); j2 uuid := gen_random_uuid(); m uuid; e uuid;
  res jsonb := '[]'; n int; r record; ok boolean; msg text;
  procedure_ok boolean;
begin
  -- ===== OLD DISPATCHER: send two jobs (single + pickup) =====
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', S, 'role', 'authenticated')::text, true);
  insert into dispatches (id, driver_id, site_address, lat, lng, notes, created_by)
    values (j1, A, 'ZZOLD single', 51.0, -114.0, 'ZZTEST', S);
  insert into dispatches (id, driver_id, site_address, lat, lng, notes, created_by, pickup_name, pickup_address, pickup_lat, pickup_lng)
    values (j2, A, 'ZZOLD drop', 51.0, -114.0, 'ZZTEST', S, 'ZZ Pit', 'ZZ pit addr', 51.1, -114.1);
  res := res || jsonb_build_object('t', 'old dispatcher: send single + pickup dispatch', 'ok', true);

  -- ===== OLD DRIVER =====
  execute 'reset role'; execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', A, 'role', 'authenticated')::text, true);
  select count(*) into n from dispatches where driver_id = A and status = 'active' and id in (j1, j2);
  res := res || jsonb_build_object('t', 'old driver: active dispatches select *', 'ok', n = 2);
  select count(*) into n from (select id, dispatch_id, kind, event_at, note from dispatch_load_events where dispatch_id in (j1, j2)) x;
  res := res || jsonb_build_object('t', 'old driver: "logged by dispatch" chips query', 'ok', n = 0);
  update dispatches set accepted_at = now() - interval '1 hour' where id = j1;
  select accepted_at into r from dispatches where id = j1;
  res := res || jsonb_build_object('t', 'old driver: Accept (server-stamped)', 'ok', abs(extract(epoch from r.accepted_at - now())) < 2);
  update dispatches set accepted_at = now(), picked_up_at = now() where id = j2;
  select picked_up_at, pickup_source into r from dispatches where id = j2;
  res := res || jsonb_build_object('t', 'old driver: one-shot Loaded button', 'ok', r.picked_up_at is not null and r.pickup_source = 'tap');
  update dispatches set picked_up_at = null where id = j2;
  select picked_up_at, pickup_source into r from dispatches where id = j2;
  res := res || jsonb_build_object('t', 'old driver: Undo loaded', 'ok', r.picked_up_at is null and r.pickup_source = 'undone');
  insert into dispatch_messages (dispatch_id, sender_id, body) values (j1, A, 'ZZOLD msg') returning id, kind into m, msg;
  res := res || jsonb_build_object('t', 'old driver: send message (no kind column in payload)', 'ok', m is not null and msg = 'message');
  select count(*) into n from dispatch_messages where dispatch_id = j1;
  res := res || jsonb_build_object('t', 'old driver: read thread select *', 'ok', n = 1);
  insert into location_updates (user_id, lat, lng, accuracy, speed, heading, source) values (A, 51.0, -114.0, 5, 0, 0, 'heartbeat');
  res := res || jsonb_build_object('t', 'old driver: GPS ping insert', 'ok', true);
  update profiles set push_token = push_token where id = A;
  get diagnostics n = row_count;
  res := res || jsonb_build_object('t', 'old driver: push token write', 'ok', n = 1);
  update dispatches set status = 'completed', completed_at = now() where id = j1;
  select status into msg from dispatches where id = j1;
  res := res || jsonb_build_object('t', 'old driver: Mark Job Complete', 'ok', msg = 'completed');
  select count(*) into n from dispatches where driver_id = A and status in ('completed', 'cancelled');
  res := res || jsonb_build_object('t', 'old driver: history select', 'ok', n >= 1);
  -- old driver never calls the new things; the gate RPC answers false for them
  res := res || jsonb_build_object('t', 'old/non-pilot driver: gate says false', 'ok', public.driver_ui_pilot() = false);

  -- ===== OLD DISPATCHER: loads panel, mark loaded, messages, cancel =====
  execute 'reset role'; execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', S, 'role', 'authenticated')::text, true);
  insert into dispatch_load_events (dispatch_id, kind, event_at, note) values (j2, 'loaded', now() - interval '2 minutes', 'ZZ') returning id into e;
  select source, entered_by into r from dispatch_load_events where id = e;
  res := res || jsonb_build_object('t', 'old dispatcher: + Loaded (called in) still stamped dispatcher', 'ok', r.source = 'dispatcher' and r.entered_by = S);
  update dispatch_load_events set event_at = now() - interval '3 minutes', note = 'edited' where id = e;
  get diagnostics n = row_count;
  res := res || jsonb_build_object('t', 'old dispatcher: edit logged load', 'ok', n = 1);
  update dispatches set picked_up_at = now(), pickup_source = 'dispatch' where id = j2 and picked_up_at is null;
  select pickup_source into msg from dispatches where id = j2;
  res := res || jsonb_build_object('t', 'old dispatcher: Mark loaded for the driver', 'ok', msg = 'dispatch');
  delete from dispatch_load_events where id = e;
  get diagnostics n = row_count;
  res := res || jsonb_build_object('t', 'old dispatcher: delete logged load', 'ok', n = 1);
  insert into dispatch_messages (dispatch_id, sender_id, body) values (j2, S, 'ZZOLD staff') returning kind into msg;
  res := res || jsonb_build_object('t', 'old dispatcher: send message', 'ok', msg = 'message');
  select count(*) into n from dispatch_messages where dispatch_id in (j1, j2);
  res := res || jsonb_build_object('t', 'old dispatcher: read all threads', 'ok', n = 2);
  select count(*) into n from (select * from location_updates where created_at > now() - interval '24 hours' limit 5) x;
  res := res || jsonb_build_object('t', 'old dispatcher: live map query', 'ok', true);
  update dispatches set status = 'cancelled' where id = j2;
  get diagnostics n = row_count;
  res := res || jsonb_build_object('t', 'old dispatcher: cancel dispatch', 'ok', n = 1);
  select count(*) into n from profiles where role = 'driver';
  res := res || jsonb_build_object('t', 'old dispatcher: roster', 'ok', n >= 1);

  execute 'reset role';
  select count(*) into n from jsonb_array_elements(res) x where (x->>'ok')::boolean is not true;
  raise exception 'RESULTS fail=% %', n, res::text;
end $$;
