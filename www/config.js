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
