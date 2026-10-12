// Replace with your Supabase project details
// Found in: Supabase Dashboard → Project Settings → API
const SUPABASE_URL = 'https://xpntyinplxjvjeotbnnf.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_bdPHb9u_Ve4xDZv5G8ssCw_0q6SYy3I'

// Haul-ticket letterhead constants — the same values pre-printed on the paper
// book, not per-ticket driver input. One place to correct them.
// WCB_NUMBER and GST_NUMBER are the real ticket's W.C.B.# and GST# fields;
// they were not supplied, so they are blank and simply do not render.
const COMPANY = {
  name: "Cooney's Trucking Ltd.",
  address: '831 48 Ave SE, Calgary, AB T2G 2A7',
  phone: '403-333-3477',
  email: 'tickets@cooneystrucking.com',
  wcbNumber: '',
  gstNumber: ''
}

// Fixed equipment list, verbatim from the paper ticket.
const EQUIPMENT_TYPES = [
  'Tandem', 'Tri Pup', 'Tandem End Dump', 'Tri End Dump',
  'Tandem End Dump Rock', 'Tandem Demo Box', 'Tri Demo Box', 'Others'
]

// Web-layer build stamp, logged with every Open-in-Maps acknowledgement so the
// evidence trail says which screens the driver was looking at. Bump on change.
const WEB_BUILD = 'w2026.10.12-job-screen'

// Route-responsibility notice shown BEFORE the driver's own maps app opens
// (Open in Maps, migration 0013). SADIE draft Option A, approved by Matt Kelly
// 2026-10-12 (relayed by GORDON). Gate category 3.
//
// THIS IS THE FALLBACK. The live copy is the 'nav_notice' row in the
// public.app_settings table, which the app reads at launch and caches, so the
// wording, the acknowledgement line, or whether the tick-box is required can be
// changed with one SQL update and NO rebuild. This bundled copy is only used
// when the phone has never reached the server (first launch in a dead zone).
// Keep the two in step. Bump `version` whenever text or ack_text changes so
// every driver ticks the new wording once.
const NAV_NOTICE = {
  version: '2026-10-12-A',
  text: "Maps opens with the destination address only. The route is your choice and your responsibility. Check your truck's height and weight against the signs on the road. Set it up while parked.",
  ack_required: true,
  ack_text: "I understand my map app does not know my truck's size, and I choose my own route.",
  // false: the app drops a pin at the destination and the driver taps
  // Directions/Go in their own app. true: open straight into directions.
  start_directions: false
}
