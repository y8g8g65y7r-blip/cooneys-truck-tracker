-- node supabase_mgmt.js sql test/0014_pilot_matrix.sql   (rolls back; report is the raised "error")
do $$
declare res jsonb := '[]'; b boolean; n int;
  who constant text[][] := array[
    array['10f9ded6-c900-4028-8bb5-d1a9cf0e2ad1','true','Dario 98'],
    array['22497663-bc5b-493d-87e6-418c2afa073b','true','Matt T1 test driver'],
    array['d3b357fc-a8e1-43cd-9b83-a9b9bd5bb0aa','true','demo driver 62'],
    array['59089700-2919-43fa-ac07-35e3dd215cbc','false','Luis 10'],
    array['43cf5233-1828-4910-b98e-0c66d888c37a','false','Brano 90'],
    array['14c0b6bc-f95c-4505-bb99-f499e4084031','false','Employee One E1'],
    array['7abb1d58-a160-4d0e-9a24-5f97853ac087','false','Mike Kellstr 22']];
  i int;
begin
  for i in 1 .. array_length(who, 1) loop
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', json_build_object('sub', who[i][1], 'role', 'authenticated')::text, true);
    b := public.driver_ui_pilot();
    select count(*) into n from app_settings where key = 'driver_ui_pilot';
    execute 'reset role';
    res := res || jsonb_build_object('t', who[i][3] || ' pilot=' || who[i][2] || ' and cannot read the pilot list', 'ok', b = (who[i][2] = 'true') and n = 0);
  end loop;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', '59089700-2919-43fa-ac07-35e3dd215cbc', 'role', 'authenticated')::text, true);
  select count(*) into n from app_settings where key = 'nav_notice';
  execute 'reset role';
  res := res || jsonb_build_object('t', 'non-pilot driver still reads the notice', 'ok', n = 1);
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin perform public.driver_ui_pilot(); b := true; exception when others then b := false; end;
  execute 'reset role';
  res := res || jsonb_build_object('t', 'anon cannot call the gate', 'ok', not b);
  update app_settings set value = jsonb_set(value, '{all}', 'true') where key = 'driver_ui_pilot';
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', '59089700-2919-43fa-ac07-35e3dd215cbc', 'role', 'authenticated')::text, true);
  b := public.driver_ui_pilot();
  execute 'reset role';
  res := res || jsonb_build_object('t', 'all=true rolls it out to everyone (rolled back)', 'ok', b);
  select count(*) into n from jsonb_array_elements(res) e where (e->>'ok')::boolean is not true;
  raise exception 'RESULTS fail=% %', n, res::text;
end $$;
