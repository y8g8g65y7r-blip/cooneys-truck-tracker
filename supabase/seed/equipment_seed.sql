-- ============================================================
-- Equipment types + trailers seed (2026-10-13). Re-runnable (seed_key); never
-- overwrites a row the office has edited on the Units & Equipment page.
--
-- Types: named EXACTLY as the May 1 2026 hourly rate sheet (context file), which
-- are the priced classes. No prices are stored. Trailer flags CONFIRMED by Matt
-- 2026-10-13: the power unit is a tandem truck in every configuration; every
-- end-dump type pulls a trailer ("Tri"/"Tandem" in the name = the TRAILER'S
-- axles); the demo box is a rock box ("a box that can get damaged that you hook
-- up to a tandem"). Slinger, Water Truck and Low Bed are on the rate sheet but
-- were not on Matt's list: loaded INACTIVE and unconfirmed (one click to use).
--
-- Trailers: SADIE's A-38 classification of the Axon list (26 trailer rows) plus
-- "Rock Box Tri" (a trailer per Matt). Body type is not in Axon, so trailer_kind
-- is left blank (tag it on the Units & Equipment page) except where Axon's own
-- name says it. Leased per the insurance schedules: 1101, 1103, 1104, 1105
-- (Mitsubishi HC Capital), 1102, 1401 (Geolin Leasing).
-- ============================================================

insert into public.equipment_types (seed_key, name, driver_label, needs_trailer, trailer_kind, confirmed, active, sort_order, note) values
  ('rate:tandem',     'Tandem',                          'TANDEM',                    false, 'none',          true,  true,  10, 'No trailer. Confirmed by Matt 2026-10-13.'),
  ('rate:tp',         'Truck and Pup (Tri)',             'TANDEM + PUP',              true,  'pup',           true,  true,  20, 'Confirmed by Matt 2026-10-13.'),
  ('rate:tq',         'Truck and Quad',                  'TANDEM + QUAD',             true,  'quad',          true,  true,  30, 'Confirmed by Matt 2026-10-13.'),
  ('rate:tri-ed',     'Tri-End Dump',                    'TANDEM + END DUMP TRAILER', true,  'end_dump',      true,  true,  40, 'Tri-axle end-dump trailer. Confirmed by Matt 2026-10-13.'),
  ('rate:hs-demo-tan','High Side Demo Tandem End Dump',  'TANDEM + DEMO/ROCK BOX',    true,  'demo_rock_box', true,  true,  50, 'Tandem-axle demo/rock box. Confirmed by Matt 2026-10-13.'),
  ('rate:hs-demo-tri','High Side Demo Tri End Dump',     'TANDEM + DEMO/ROCK BOX',    true,  'demo_rock_box', true,  true,  60, 'Tri-axle demo/rock box. Confirmed by Matt 2026-10-13.'),
  ('rate:rock-tan',   'Rock / Concrete Tandem End Dump', 'TANDEM + DEMO/ROCK BOX',    true,  'demo_rock_box', true,  true,  70, 'Tandem-axle rock box. Confirmed by Matt 2026-10-13.'),
  ('rate:rock-tri',   'Rock / Concrete Tri End Dump',    'TANDEM + DEMO/ROCK BOX',    true,  'demo_rock_box', true,  true,  80, 'Tri-axle rock box. Confirmed by Matt 2026-10-13.'),
  ('rate:slinger',    'Slinger',                         'SLINGER TRUCK',             false, 'none',          false, false, 90, 'On the rate sheet; not in Matt''s list. Inactive until needed.'),
  ('rate:water',      'Water Truck',                     'WATER TRUCK',               false, 'none',          false, false, 91, 'On the rate sheet; not in Matt''s list. Inactive until needed.'),
  ('rate:lowbed',     'Low Bed',                         'TRACTOR + LOW BED',         true,  'low_bed',       false, false, 92, 'On the rate sheet; not in Matt''s list. Trailer flags are a guess. Inactive until needed.')
on conflict (seed_key) do nothing;

insert into public.units (seed_key, kind, unit_number, year, make, plate, vin, trailer_kind, active, confirmed, source, is_demo, note) values
  ('axon-t:1101',  'trailer', '1101', 2017, 'Renn',       '6CK154', '2S9NE3693H1036125', null, true,  true, 'axon', false, 'Leased (Mitsubishi HC Capital)'),
  ('axon-t:1102',  'trailer', '1102', 2016, 'Renn',       '6LA853', '2S9NE369XG1032460', null, true,  true, 'axon', false, 'Leased (Geolin Leasing)'),
  ('axon-t:1103',  'trailer', '1103', 2015, 'Renn',       null,     '2S9NE3698F1032472', null, true,  true, 'axon', false, 'Leased (Mitsubishi HC Capital). Plate missing in Axon'),
  ('axon-t:1104',  'trailer', '1104', 2013, 'Renn',       '6LA851', '2S9NE3697D1027440', null, true,  true, 'axon', false, 'Leased (Mitsubishi HC Capital)'),
  ('axon-t:1105',  'trailer', '1105', 2008, 'Renn',       '6LA852', '2S9NE369181019792', null, true,  true, 'axon', false, 'Leased (Mitsubishi HC Capital)'),
  ('axon-t:1106',  'trailer', '1106', 2005, 'Cancade',    '6GR361', '2C92317E451086717', null, true,  true, 'axon', false, null),
  ('axon-t:1107',  'trailer', '1107', 2011, 'Gravhaul',   '6VB762', '2M9SP3170B1174446', null, true,  true, 'axon', false, null),
  ('axon-t:1401',  'trailer', '1401', 2015, 'Cancade',    '6LA850', 'SC94425E1F1086819', null, true,  true, 'axon', false, 'Leased (Geolin Leasing)'),
  ('axon-t:1402',  'trailer', '1402', 2014, 'Arnes',      'W36571', '2A9214248EA003578', null, true,  true, 'axon', false, 'Plate W36571 is also listed on 5001 in Axon; verify'),
  ('axon-t:1403',  'trailer', '1403', 2013, 'Arnes',      null,     '2A9214249DA003572', null, true,  true, 'axon', false, 'Plate missing in Axon'),
  ('axon-t:2305',  'trailer', '2305', 2012, 'Loadline',   '4ZY783', '2D9ED3529C1012952', null, true,  true, 'axon', false, null),
  ('axon-t:3200',  'trailer', '3200', 1999, 'Canuck',     'Z29967', '2B9ED3352XLJ0M180', null, true,  true, 'axon', false, null),
  ('axon-t:3201',  'trailer', '3201', 1999, 'Canuck',     null,     '2D9ED292891012194', null, true,  true, 'axon', false, 'Same serial as the Axon row "not sure". Plate missing in Axon'),
  ('axon-t:3202',  'trailer', '3202', 1989, 'Arnes',      '6CD184', '2A9072921KA003932', null, true,  true, 'axon', false, null),
  ('axon-t:3203',  'trailer', '3203', 1995, 'Loadline',   null,     '2DED262151012662',  null, true,  true, 'axon', false, 'Serial looks 16 characters; plate missing in Axon'),
  ('axon-t:3301',  'trailer', '3301', 2012, 'Midland',    '6TF573', '2MFB2R5D8CR006815', null, true,  true, 'axon', false, null),
  ('axon-t:3302',  'trailer', '3302', 2007, 'Midland',    null,     '2MFB2R5D48R005135', 'end_dump', true, true, 'axon', false, 'Axon make "Mid Land End Dump" (kind from that name). Plate missing in Axon'),
  ('axon-t:4201',  'trailer', '4201', 2000, 'Loadline',   '6FV104', '2D9ED3528Y1012433', null, true,  true, 'axon', false, null),
  ('axon-t:4301',  'trailer', '4301', 2009, 'Gravhaul',   'X80380', '2M9FS335091174159', null, true,  true, 'axon', false, null),
  ('axon-t:4302',  'trailer', '4302', 1999, 'Arnes',      '6WW833', '2A907373XXA0003861', null, true, true, 'axon', false, 'Serial looks 18 characters; verify'),
  ('axon-t:4303',  'trailer', '4303', 2009, 'Gravhaul',   '6XF552', '2M9FS335291174163', null, true,  true, 'axon', false, null),
  ('axon-t:5000',  'trailer', '5000', 1982, 'Load King',  '6FJ374', 'AR824253',          null, true,  true, 'axon', false, 'Axon name "5000 Load King"'),
  ('axon-t:50000', 'trailer', '50000', 1980, null,        null,     'AR824253',          null, false, true, 'axon', false, 'Suspected duplicate of 5000 in Axon (same serial). Inactive until confirmed'),
  ('axon-t:5001',  'trailer', '5001', 2005, 'Arnes',      'W36571', '2A920302X5A003788', 'other', true, true, 'axon', false, 'Axon name "5001 Side Dump" (a side dump). Plate W36571 is also on 1402'),
  ('axon-t:southpark', 'trailer', 'South Park MW', 2001, 'South Park', null, '2S9NE4491111028412', null, true, true, 'axon', false, 'No number in Axon beyond the name. Plate missing'),
  ('axon-t:notsure', 'trailer', 'not sure', 2009, 'Loadline', '6FJ373', '2D9ED292891012194', null, false, true, 'axon', false, 'Axon name "not sure". Same serial as 3201, different year. Inactive until the real number is known'),
  ('axon-t:rockboxtri', 'trailer', 'Rock Box Tri', 1996, null, null, null, 'demo_rock_box', true, true, 'axon', false, 'A trailer (rock box) per Matt 2026-10-13. No number, VIN, plate or make in Axon: assign a number'),
  ('demo-t:P14', 'trailer', 'P14', null, null, null, null, 'pup',  true, true, 'demo', true, 'App Store demo trailer (fictional)'),
  ('demo-t:Q22', 'trailer', 'Q22', null, null, null, null, 'quad', true, true, 'demo', true, 'App Store demo trailer (fictional)')
on conflict (seed_key) do nothing;

-- Demo jobs get equipment so App Store screenshots stay valid. Demo rows only.
do $$
declare tp uuid; tq uuid; tan uuid; p14 uuid; q22 uuid;
begin
  if not exists (select 1 from pg_proc where proname = 'demo_user_ids' and pronamespace = 'public'::regnamespace) then return; end if;
  select id into tp  from public.equipment_types where seed_key = 'rate:tp';
  select id into tq  from public.equipment_types where seed_key = 'rate:tq';
  select id into tan from public.equipment_types where seed_key = 'rate:tandem';
  select id into p14 from public.units where seed_key = 'demo-t:P14';
  select id into q22 from public.units where seed_key = 'demo-t:Q22';
  update public.dispatches set equipment_type_id = tp, trailer_unit_id = p14
   where driver_id = 'd3b357fc-a8e1-43cd-9b83-a9b9bd5bb0aa' and equipment_type_id is null and pickup_address like '%Pit 2%';
  update public.dispatches set equipment_type_id = tan
   where driver_id in ('d3b357fc-a8e1-43cd-9b83-a9b9bd5bb0aa', '8743a7fd-2937-4f7e-95c3-fa7b69dddda8') and equipment_type_id is null;
  update public.dispatches set equipment_type_id = tq, trailer_unit_id = q22
   where driver_id = '48a1e4ff-d829-4875-b2ee-146e1c251452' and equipment_type_id is null;
end $$;
