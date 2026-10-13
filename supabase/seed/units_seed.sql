-- ============================================================
-- Units seed (2026-10-13). Re-runnable: keyed on seed_key, never overwrites a
-- row the office has since edited in the app (www/units.html).
--
-- Sources:
--   axon  Power units from the Axon equipment list
--         (output/compliance/fleet-unit-files/_staging/axon/2026-09-21-axon-equipment-list.csv),
--         classified power vs trailer by SADIE on the A-38 sheet
--         (output/safety/truck-tracker-routing/2026-10-12-unit-dimension-record-sheet.md).
--         Sold (11, 24) and "#87 Do not use" are loaded INACTIVE: kept for history,
--         never offered to dispatch. Trailers are out of scope.
--   app   Unit numbers on today's real driver profiles that are NOT on the Axon
--         list: 98 (Dario), 90 (Brano), 22 (Mike Kellstr). Matt 2026-10-13: these
--         were TEST numbers he and Mike made up before they knew the real unit
--         numbers, not trucks. Loaded INACTIVE (never offered to dispatch, never a
--         default) and kept only so old jobs still show the number they had.
--         T1 (test login) and E1 (Employee One seat, a placeholder per the 2026-09-24
--         memory, not a truck number) are deliberately left out until Matt says otherwise.
--         Unit 10 IS on the Axon list (A-38 row 2); Matt confirmed it in the fleet 2026-10-13.
--   demo  The fictional App Store demo trucks 62/74/81, visible to demo
--         accounts only (demo_isolation policy on units).
--
-- Matt confirms a unit:   update public.units set confirmed = true where unit_number = '<n>' and not is_demo and active;
-- Matt says it is not a truck: update public.units set active = false, note = 'Not a truck (Matt)' where unit_number = '<n>' and not is_demo;
-- (or use the Units page in the app)
-- ============================================================

insert into public.units (seed_key, unit_number, year, make, plate, vin, active, confirmed, source, is_demo, note) values
  ('axon:#87:3AKJGED17GSGZ6087', '87',  2015, 'Freightliner',            '89P618',  '3AKJGED17GSGZ6087', false, true, 'axon', false, 'Axon name "#87 Do not use". Not the active 87.'),
  ('axon:10:1FVHALCK57DY44749',  '10',  2007, 'Freightliner',            '89N157',  '1FVHALCK57DY44749', true,  true, 'axon', false, 'Confirmed in the fleet by Matt Kelly 2026-10-13 (also on the Axon list, row 2 of A-38)'),
  ('axon:11:1FVHALCK57DX56638',  '11',  2007, 'Freightliner',            '91N717',  '1FVHALCK57DX56638', false, true, 'axon', false, 'Sold per Axon'),
  ('axon:14S:1HTWGAAR5AJ250468', '14S', 2010, 'International 7700',      null,      '1HTWGAAR5AJ250468', true,  true, 'axon', false, 'Plate missing in Axon'),
  ('axon:16:5KKHAXDV9GPHA4744',  '16',  2016, 'Western Star',            '79P349',  '5KKHAXDV9GPHA4744', true,  true, 'axon', false, null),
  ('axon:23:2NKDLB0X36M991643',  '23',  2006, 'Kenworth T800',           '56P503',  '2NKDLB0X36M991643', true,  true, 'axon', false, null),
  ('axon:24:1XKDD69X2XR957765',  '24',  1999, 'Kenworth T800',           '56P549',  '1XKDD69X2XR957765', false, true, 'axon', false, 'Sold per Axon'),
  ('axon:3:2HSCUAPR6AC163328',   '3',   2010, 'International',           '91N703',  '2HSCUAPR6AC163328', true,  true, 'axon', false, null),
  ('axon:36:1NKDLP0X9DJ962536',  '36',  2013, 'Kenworth T800',           '74P053',  '1NKDLP0X9DJ962536', true,  true, 'axon', false, null),
  ('axon:40:2FZHAZAV03AL78961',  '40',  2003, 'Sterling',                '62P598',  '2FZHAZAV03AL78961', true,  true, 'axon', false, null),
  ('axon:45:none',               '45',  2015, 'Western Star',            null,      null,                true,  true, 'axon', false, 'No VIN or plate in Axon; power unit inferred from the number'),
  ('axon:46:1FVHBGCV04HM32046',  '46',  2004, 'Freightliner',            null,      '1FVHBGCV04HM32046', true,  true, 'axon', false, 'Plate missing in Axon'),
  ('axon:50:1XKDD49X43R971150',  '50',  2003, 'Kenworth',                '65P721',  '1XKDD49X43R971150', true,  true, 'axon', false, null),
  ('axon:55:5KKHAXDV3DPFD8555',  '55',  2013, 'Western Star 4700',       '79P421',  '5KKHAXDV3DPFD8555', true,  true, 'axon', false, null),
  ('axon:57:1M2AA18C13W154557',  '57',  2003, 'Mack (Automatic)',        '64P813',  '1M2AA18C13W154557', true,  true, 'axon', false, null),
  ('axon:58:1M1AA18YXYW132385',  '58',  2000, 'Mack',                    'CWB1833', '1M1AA18YXYW132385', true,  true, 'axon', false, null),
  ('axon:64:1XPTD49XFD271964',   '64',  null, 'Peterbilt',               null,      '1XPTD49XFD271964',  true,  true, 'axon', false, 'Axon: year 0, no plate, make spelled "Peterbuilt", VIN looks 16 characters'),
  ('axon:69:2HSCHAPR65C058069',  '69',  2005, 'International 9900',      '27P174',  '2HSCHAPR65C058069', true,  true, 'axon', false, null),
  ('axon:71:1HSDJSJR6CH545771',  '71',  2011, 'International',           '65P723',  '1HSDJSJR6CH545771', true,  true, 'axon', false, null),
  ('axon:8:2HSCHSCR26C200849',   '8',   2006, 'International 9900',      '89N168',  '2HSCHSCR26C200849', true,  true, 'axon', false, null),
  ('axon:84:2FWJAZAV06AV41305',  '84',  2006, 'Sterling',                '13P981',  '2FWJAZAV06AV41305', true,  true, 'axon', false, null),
  ('axon:87:3AKJGND69FDGN3787',  '87',  2015, 'Freightliner',            '89P607',  '3AKJGND69FDGN3787', true,  true, 'axon', false, 'Not the inactive "#87 Do not use"'),
  ('axon:9:1FVHALCK07DY44741',   '9',   2007, 'Freightliner',            null,      '1FVHALCK07DY44741', true,  true, 'axon', false, 'Plate missing in Axon'),
  ('axon:964:1HTWNADR75J044964', '964', null, 'International',           null,      '1HTWNADR75J044964', true,  true, 'axon', false, 'Axon: year 0, no plate'),
  ('axon:97:5KJJALAV26PU75097',  '97',  2006, 'Western Star',            '91N729',  '5KJJALAV26PU75097', true,  true, 'axon', false, null),
  ('axon:99:3HSCUAPR6AN275111',  '99',  2010, 'International',           '79P420',  '3HSCUAPR6AN275111', true,  true, 'axon', false, 'Axon spells the make "Intenational"'),
  ('app:98',                     '98',  null, null,                      null,      null,                false, false, 'app', false, 'Test number Matt and Mike made up before they knew the real unit numbers (Matt 2026-10-13). Not a truck. Kept so old jobs still show it.'),
  ('app:90',                     '90',  null, null,                      null,      null,                false, false, 'app', false, 'Test number Matt and Mike made up before they knew the real unit numbers (Matt 2026-10-13). Not a truck. Kept so old jobs still show it.'),
  ('app:22',                     '22',  null, null,                      null,      null,                false, false, 'app', false, 'Test number Matt and Mike made up before they knew the real unit numbers (Matt 2026-10-13). Not a truck. Kept so old jobs still show it.'),
  ('demo:62',                    '62',  null, null,                      null,      null,                true,  true, 'demo', true,  'App Store demo truck (fictional)'),
  ('demo:74',                    '74',  null, null,                      null,      null,                true,  true, 'demo', true,  'App Store demo truck (fictional)'),
  ('demo:81',                    '81',  null, null,                      null,      null,                true,  true, 'demo', true,  'App Store demo truck (fictional)')
on conflict (seed_key) do nothing;
