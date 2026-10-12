-- Simulated-session test matrix for migration 0013. Run with
--   node supabase_mgmt.js sql test/0013_rls_matrix.sql
-- Everything runs inside ONE transaction that ends by RAISING its results, so
-- every fixture and every probe row is rolled back. The "error" printed is the
-- report: look for "fail":0.
-- Fixture accounts: unit 22 Mike Kellstr (test driver A), unit 10 Luis (driver
-- B, only read), Matt (staff), demo driver Jordan Reyes (demo).
do $$
declare
  A    constant uuid := '7abb1d58-a160-4d0e-9a24-5f97853ac087';
  B    constant uuid := '59089700-2919-43fa-ac07-35e3dd215cbc';
  S    constant uuid := '595ccf2c-50d9-43e8-9c35-4cb73083eca3';
  DEMO constant uuid := 'd3b357fc-a8e1-43cd-9b83-a9b9bd5bb0aa';
  DEMO_JOB constant uuid := 'bc17fc1e-0632-4895-a4ac-1cac1e68333b';
  jA uuid := gen_random_uuid();   -- A, active, single stop
  jA2 uuid := gen_random_uuid();  -- A, active, two stop, not loaded
  jA3 uuid := gen_random_uuid();  -- A, active, two stop, not loaded (dumped first)
  jAc uuid := gen_random_uuid();  -- A, completed 2 h ago
  jAo uuid := gen_random_uuid();  -- A, completed 30 h ago
  jAx uuid := gen_random_uuid();  -- A, cancelled
  jB uuid := gen_random_uuid();   -- B, active
  ev uuid := gen_random_uuid();
  nav uuid := gen_random_uuid();
  res jsonb := '[]'::jsonb;
  n int; ok boolean; msg text; r record; t timestamptz;
  procedure_name text;
begin
  -- fixtures (as postgres)
  insert into dispatches (id, driver_id, site_address, notes, status, created_by, created_at)
  values (jA,  A, 'ZZTEST single', 'ZZTEST', 'active', S, now() - interval '3 hours'),
         (jA2, A, 'ZZTEST drop', 'ZZTEST', 'active', S, now() - interval '3 hours'),
         (jA3, A, 'ZZTEST drop', 'ZZTEST', 'active', S, now() - interval '3 hours'),
         (jAc, A, 'ZZTEST done', 'ZZTEST', 'completed', S, now() - interval '5 hours'),
         (jAo, A, 'ZZTEST old', 'ZZTEST', 'completed', S, now() - interval '40 hours'),
         (jAx, A, 'ZZTEST cxl', 'ZZTEST', 'cancelled', S, now() - interval '3 hours'),
         (jB,  B, 'ZZTEST other', 'ZZTEST', 'active', S, now() - interval '3 hours');
  update dispatches set pickup_address = 'ZZTEST pit', pickup_name = 'ZZ Pit' where id in (jA2, jA3);
  update dispatches set completed_at = now() - interval '2 hours' where id = jAc;
  update dispatches set completed_at = now() - interval '30 hours' where id = jAo;

  -- ===== as DRIVER A =====
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', A, 'role', 'authenticated')::text, true);

  -- T1 own active job, forged source/entered_by
  insert into dispatch_load_events (id, dispatch_id, kind, event_at, source, entered_by)
  values (ev, jA, 'loaded', now() - interval '1 minute', 'dispatcher', S);
  select source, entered_by, driver_id into r from dispatch_load_events where id = ev;
  res := res || jsonb_build_object('t', 'T1 own active insert; source forced driver, entered_by forced self',
    'ok', r.source = 'driver' and r.entered_by = A and r.driver_id = A);

  -- T2 other driver's job
  begin insert into dispatch_load_events (dispatch_id, kind, event_at) values (jB, 'loaded', now()); ok := false;
  exception when others then ok := true; msg := sqlerrm; end;
  res := res || jsonb_build_object('t', 'T2 insert on another driver''s job denied', 'ok', ok, 'msg', msg);

  -- T3 cancelled
  begin insert into dispatch_load_events (dispatch_id, kind, event_at) values (jAx, 'dumped', now()); ok := false;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'T3 insert on own cancelled job denied', 'ok', ok);

  -- T4 completed 2 h ago allowed, 30 h ago denied
  begin insert into dispatch_load_events (dispatch_id, kind, event_at) values (jAc, 'dumped', now() - interval '2 hours 10 minutes'); ok := true;
  exception when others then ok := false; msg := sqlerrm; end;
  res := res || jsonb_build_object('t', 'T4a late-synced tap on job closed 2 h ago allowed', 'ok', ok, 'msg', msg);
  begin insert into dispatch_load_events (dispatch_id, kind, event_at) values (jAo, 'dumped', now() - interval '31 hours'); ok := false;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'T4b tap on job closed 30 h ago denied', 'ok', ok);

  -- T5 time bounds
  begin insert into dispatch_load_events (dispatch_id, kind, event_at) values (jA, 'loaded', now() - interval '25 hours'); ok := false;
  exception when others then ok := true; msg := sqlerrm; end;
  res := res || jsonb_build_object('t', 'T5a event_at 25 h old rejected', 'ok', ok, 'msg', msg);
  begin insert into dispatch_load_events (dispatch_id, kind, event_at) values (jA, 'loaded', now() - interval '4 hours'); ok := false;
  exception when others then ok := true; msg := sqlerrm; end;
  res := res || jsonb_build_object('t', 'T5b event_at before job was sent rejected', 'ok', ok, 'msg', msg);
  begin insert into dispatch_load_events (dispatch_id, kind, event_at) values (jA, 'loaded', now() + interval '10 minutes'); ok := false;
  exception when others then ok := true; msg := sqlerrm; end;
  res := res || jsonb_build_object('t', 'T5c event_at in the future rejected', 'ok', ok, 'msg', msg);
  insert into dispatch_load_events (dispatch_id, kind, event_at) values (jA, 'dumped', null) returning event_at into t;
  res := res || jsonb_build_object('t', 'T5d null event_at defaults to server now', 'ok', abs(extract(epoch from t - now())) < 2);

  -- T6 two-stop first Loaded advances the stage
  insert into dispatch_load_events (dispatch_id, kind, event_at) values (jA2, 'loaded', now() - interval '20 minutes');
  select picked_up_at, pickup_source into r from dispatches where id = jA2;
  res := res || jsonb_build_object('t', 'T6a first Loaded on two-stop job sets picked_up_at (server now, source tap)',
    'ok', r.picked_up_at is not null and abs(extract(epoch from r.picked_up_at - now())) < 2 and r.pickup_source = 'tap');
  t := r.picked_up_at;
  insert into dispatch_load_events (dispatch_id, kind, event_at) values (jA2, 'loaded', now());
  select picked_up_at into r from dispatches where id = jA2;
  res := res || jsonb_build_object('t', 'T6b second Loaded leaves picked_up_at alone', 'ok', r.picked_up_at = t);
  insert into dispatch_load_events (dispatch_id, kind, event_at) values (jA3, 'dumped', now());
  select picked_up_at into r from dispatches where id = jA3;
  res := res || jsonb_build_object('t', 'T6c an Unloaded first does not mark the job loaded', 'ok', r.picked_up_at is null);

  -- T7 no driver update/delete
  update dispatch_load_events set kind = 'dumped' where id = ev;
  get diagnostics n = row_count;
  res := res || jsonb_build_object('t', 'T7a driver cannot edit a logged event', 'ok', n = 0);
  delete from dispatch_load_events where id = ev;
  get diagnostics n = row_count;
  res := res || jsonb_build_object('t', 'T7b driver cannot delete a logged event', 'ok', n = 0);

  -- T13 idempotent retry of the same client id
  begin insert into dispatch_load_events (id, dispatch_id, kind, event_at) values (ev, jA, 'loaded', now()); ok := false;
  exception when unique_violation then ok := true; end;
  res := res || jsonb_build_object('t', 'T13 retried tap with same id -> unique_violation (client treats as delivered)', 'ok', ok);

  -- T9 messages / notes
  insert into dispatch_messages (dispatch_id, sender_id, body, kind) values (jA, A, 'ZZTEST note', 'note');
  select count(*) into n from dispatch_messages where dispatch_id = jA and kind = 'note';
  res := res || jsonb_build_object('t', 'T9a driver posts a job note', 'ok', n = 1);
  begin insert into dispatch_messages (dispatch_id, sender_id, body, kind) values (jA, A, 'x', 'bogus'); ok := false;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'T9b unknown message kind rejected', 'ok', ok);
  begin insert into dispatch_messages (dispatch_id, sender_id, body) values (jB, A, 'x'); ok := false;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'T9c message on another driver''s job denied', 'ok', ok);
  insert into dispatch_messages (dispatch_id, sender_id, body) values (jA, A, 'ZZTEST msg') returning kind into msg;
  res := res || jsonb_build_object('t', 'T9d message without kind defaults to message (old builds)', 'ok', msg = 'message');

  -- T10 nav handoff log
  insert into nav_handoffs (id, user_id, dispatch_id, stop_kind, nav_app, dest_text, notice_version, notice_text, ack_state, app_version)
  values (nav, B, jA, 'dropoff', 'google', 'ZZTEST', 'v', 'notice', 'ticked', '1.0 (7)');
  select user_id, unit_number into r from nav_handoffs where id = nav;
  res := res || jsonb_build_object('t', 'T10a handoff logged; forged user_id forced to self; unit snapshotted', 'ok', r.user_id = A and r.unit_number = '22');
  begin insert into nav_handoffs (dispatch_id, nav_app, notice_version, notice_text, ack_state) values (jB, 'apple', 'v', 'n', 'ticked'); ok := false;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'T10b handoff against another driver''s job denied', 'ok', ok);
  update nav_handoffs set ack_state = 'not_required' where id = nav; get diagnostics n = row_count;
  res := res || jsonb_build_object('t', 'T10c driver cannot edit a logged acknowledgement', 'ok', n = 0);
  delete from nav_handoffs where id = nav; get diagnostics n = row_count;
  res := res || jsonb_build_object('t', 'T10d driver cannot delete a logged acknowledgement', 'ok', n = 0);
  begin insert into nav_handoffs (nav_app, notice_version, notice_text, ack_state) values ('apple', 'v', 'n', 'maybe'); ok := false;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'T10e invalid ack_state rejected', 'ok', ok);

  -- T11 app settings
  select count(*) into n from app_settings where key = 'nav_notice' and value->>'ack_required' = 'true';
  res := res || jsonb_build_object('t', 'T11a driver reads the notice settings', 'ok', n = 1);
  update app_settings set value = '{}'::jsonb where key = 'nav_notice'; get diagnostics n = row_count;
  res := res || jsonb_build_object('t', 'T11b driver cannot change the notice', 'ok', n = 0);
  begin insert into app_settings (key, value) values ('zz', '{}'); ok := false;
  exception when others then ok := true; end;
  res := res || jsonb_build_object('t', 'T11c driver cannot add a setting', 'ok', ok);

  -- ===== as STAFF (Matt) =====
  execute 'reset role';
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', S, 'role', 'authenticated')::text, true);
  insert into dispatch_load_events (dispatch_id, kind, event_at) values (jA, 'dumped', now()) returning source into msg;
  res := res || jsonb_build_object('t', 'T8 staff log still stamped dispatcher', 'ok', msg = 'dispatcher');
  select count(*) into n from nav_handoffs where id = nav;
  res := res || jsonb_build_object('t', 'T10f staff can read the handoff log', 'ok', n = 1);
  select count(*) into n from nav_handoffs where user_id = DEMO;
  res := res || jsonb_build_object('t', 'T12a (pre) real staff see 0 demo handoffs', 'ok', n = 0);

  -- ===== as DEMO driver =====
  execute 'reset role';
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', DEMO, 'role', 'authenticated')::text, true);
  begin insert into dispatch_messages (dispatch_id, sender_id, body) values (DEMO_JOB, DEMO, 'ZZTEST demo reply'); ok := true;
  exception when others then ok := false; msg := sqlerrm; end;
  res := res || jsonb_build_object('t', 'T12b demo driver can now reply on the demo job', 'ok', ok, 'msg', msg);
  insert into nav_handoffs (dispatch_id, nav_app, notice_version, notice_text, ack_state) values (DEMO_JOB, 'apple', 'v', 'n', 'ticked');
  insert into dispatch_load_events (dispatch_id, kind, event_at) values (DEMO_JOB, 'dumped', now());
  select count(*) into n from nav_handoffs where user_id <> DEMO;
  res := res || jsonb_build_object('t', 'T12c demo driver sees 0 real handoffs', 'ok', n = 0);
  select count(*) into n from dispatch_load_events where driver_id <> DEMO;
  res := res || jsonb_build_object('t', 'T12d demo driver sees 0 real load events', 'ok', n = 0);

  -- ===== back to STAFF: demo rows invisible =====
  execute 'reset role';
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', S, 'role', 'authenticated')::text, true);
  select count(*) into n from nav_handoffs where user_id = DEMO;
  res := res || jsonb_build_object('t', 'T12e real staff see 0 demo handoffs after a demo insert', 'ok', n = 0);
  select count(*) into n from dispatch_messages where sender_id = DEMO;
  res := res || jsonb_build_object('t', 'T12f real staff see 0 demo messages', 'ok', n = 0);
  select count(*) into n from dispatch_load_events where driver_id = DEMO;
  res := res || jsonb_build_object('t', 'T12g real staff see 0 demo load events', 'ok', n = 0);

  execute 'reset role';
  select count(*) into n from jsonb_array_elements(res) e where (e->>'ok')::boolean is not true;
  raise exception 'RESULTS fail=% %', n, jsonb_pretty(res);
end $$;
