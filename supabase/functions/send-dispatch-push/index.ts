// ============================================================
// Cooney's Trucking — Edge Function: send-dispatch-push
//
// Purpose: Send a real APNs push notification to a driver's phone the moment
//   dispatch assigns them a job. Called by dispatcher.html right after a
//   dispatches row is inserted. Fire-and-forget from the client's point of
//   view — a push failure (no token yet, driver hasn't opened the native
//   build, etc.) must never block dispatch creation, so this always returns
//   200 with an `ok` flag describing what happened.
//
// Deploy:
//   supabase functions deploy send-dispatch-push
//
// Required secrets (server-only — set ONCE, never commit):
//   supabase secrets set APNS_TEAM_ID=7Y339CK6MY
//   supabase secrets set APNS_KEY_ID=<key id from the .p8 you download>
//   supabase secrets set APNS_AUTH_KEY="$(cat AuthKey_XXXXXXXXXX.p8)"
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service role key>
//     (skip if already set for admin-create-employee — secrets are shared
//     project-wide across all Edge Functions, not per-function)
//
// The APNs auth key (.p8) is created once in Apple Developer Portal ->
// Certificates, Identifiers & Profiles -> Keys -> "+" -> check "Apple Push
// Notifications service (APNs)". One key works for push across the whole
// team, unlike the per-app App Store Connect API key used for TestFlight —
// there's no REST API to create this key, it's a manual UI step, and Apple
// only lets you download the .p8 once.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BUNDLE_ID = 'com.cooneystrucking.trucktracker'
const APNS_HOST = 'https://api.push.apple.com' // ad-hoc/TestFlight/App Store builds all use production APNs, never the sandbox host

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function base64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  let str = ''
  for (const b of bytes) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

async function buildApnsJwt(teamId: string, keyId: string, privateKeyPem: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(privateKeyPem),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const header = { alg: 'ES256', kid: keyId }
  const claims = { iss: teamId, iat: Math.floor(Date.now() / 1000) }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  // Web Crypto ECDSA signing returns the raw IEEE P1363 (r||s) format, which
  // is exactly what JWS/JWT ES256 expects — no DER-to-raw conversion needed.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${base64url(signature)}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const APNS_TEAM_ID = Deno.env.get('APNS_TEAM_ID')
    const APNS_KEY_ID = Deno.env.get('APNS_KEY_ID')
    const APNS_AUTH_KEY = Deno.env.get('APNS_AUTH_KEY')

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
      return json({ ok: false, error: 'Server not configured' }, 500)
    }
    if (!APNS_TEAM_ID || !APNS_KEY_ID || !APNS_AUTH_KEY) {
      // Not set up yet — don't fail dispatch creation over it, just report why.
      return json({ ok: false, error: 'APNs not configured on the server yet' }, 200)
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ ok: false, error: 'Missing authorization' }, 401)

    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const {
      data: { user },
    } = await anon.auth.getUser()
    if (!user) return json({ ok: false, error: 'Invalid or expired session' }, 401)

    const { data: callerProfile } = await anon
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()
    if (!callerProfile || (callerProfile.role !== 'admin' && callerProfile.role !== 'dispatcher')) {
      return json({ ok: false, error: 'Dispatcher access required' }, 403)
    }

    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return json({ ok: false, error: 'Invalid JSON body' }, 400)
    }

    const driverId = typeof body.driver_id === 'string' ? body.driver_id : ''
    const address = typeof body.address === 'string' ? body.address : 'New dispatch'
    const dispatchId = typeof body.dispatch_id === 'string' ? body.dispatch_id : null
    if (!driverId) return json({ ok: false, error: 'driver_id is required' }, 400)

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: driverProfile } = await admin
      .from('profiles')
      .select('push_token, full_name')
      .eq('id', driverId)
      .single()

    if (!driverProfile?.push_token) {
      return json({ ok: true, sent: false, reason: 'Driver has no registered device yet' }, 200)
    }

    const jwt = await buildApnsJwt(APNS_TEAM_ID, APNS_KEY_ID, APNS_AUTH_KEY)

    const apnsRes = await fetch(`${APNS_HOST}/3/device/${driverProfile.push_token}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${jwt}`,
        'apns-topic': BUNDLE_ID,
        'apns-push-type': 'alert',
        'apns-priority': '10',
      },
      body: JSON.stringify({
        aps: {
          alert: { title: 'New Dispatch', body: address },
          sound: 'default',
          'mutable-content': 1,
        },
        dispatch_id: dispatchId,
      }),
    })

    if (apnsRes.status === 200) {
      return json({ ok: true, sent: true }, 200)
    }

    const errBody = await apnsRes.json().catch(() => ({}))
    // BadDeviceToken / Unregistered: the token is dead (reinstall, OS revoke,
    // etc). Clear it so future sends don't keep hitting a stale token — the
    // app will re-register and overwrite it next time it opens.
    if (errBody?.reason === 'BadDeviceToken' || errBody?.reason === 'Unregistered') {
      await admin.from('profiles').update({ push_token: null }).eq('id', driverId)
    }
    return json({ ok: true, sent: false, reason: errBody?.reason || `APNs HTTP ${apnsRes.status}` }, 200)
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : 'Unexpected error' }, 500)
  }
})
