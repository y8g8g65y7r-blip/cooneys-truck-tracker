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
//   IMPORTANT: because delivery failures are reported in the body rather than
//   the status code, every non-delivery is also console.error'd so it lands in
//   `supabase functions logs`, and dispatcher.html surfaces it inline. Without
//   that, a completely dead push pipeline looks identical to a healthy one.
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

// Apple rejects a provider token older than 1 hour, and rejects *minting* a new
// one more than once per 20 minutes on a given connection
// (429 TooManyProviderTokenUpdates). 50 minutes sits safely inside both bounds.
const JWT_TTL_MS = 50 * 60 * 1000

// APNs caps the whole payload at 4KB. site_address is unbounded `text`, so clamp
// it well short of that rather than letting APNs reject the notification.
const MAX_ALERT_BODY = 300

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Module scope: reused while the isolate stays warm. Both are pure functions of
// the APNs secrets, so caching them is safe across requests.
let cachedKey: CryptoKey | null = null
let cachedJwt: { token: string; mintedAt: number } | null = null
// Single-flight: two dispatches landing on one cold isolate would otherwise each
// mint a token milliseconds apart. Because WebCrypto ECDSA is non-deterministic
// those are two DISTINCT tokens, which is exactly what trips Apple's
// "one new token per 20 minutes" rule. Concurrent callers share one mint.
let mintInFlight: Promise<string> | null = null

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
    // Secrets can arrive with real newlines or with literal "\n"/"\r\n" escapes
    // depending on how they were set (CLI arg vs --env-file), so strip both
    // forms. Backslash and 'r'/'n' are not in the base64 alphabet, so this
    // cannot damage a legitimate payload byte.
    .replace(/\\r/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '')
  if (!clean) throw new Error('APNS_AUTH_KEY is empty after PEM cleanup')
  let binary: string
  try {
    binary = atob(clean)
  } catch {
    // Almost always the wrong key format: Apple's .p8 is PKCS#8 and begins
    // "-----BEGIN PRIVATE KEY-----". A SEC1 key ("BEGIN EC PRIVATE KEY") leaves
    // its header behind and lands here with a useless InvalidCharacterError.
    throw new Error(
      'APNS_AUTH_KEY is not valid base64 after PEM cleanup — expected a PKCS#8 .p8 ("BEGIN PRIVATE KEY")',
    )
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

async function getApnsJwt(
  teamId: string,
  keyId: string,
  privateKeyPem: string,
  forceRefresh = false,
): Promise<string> {
  if (!forceRefresh && cachedJwt && Date.now() - cachedJwt.mintedAt < JWT_TTL_MS) {
    return cachedJwt.token
  }
  if (!mintInFlight) {
    mintInFlight = mintApnsJwt(teamId, keyId, privateKeyPem)
      .then((token) => {
        cachedJwt = { token, mintedAt: Date.now() }
        return token
      })
      .finally(() => {
        mintInFlight = null
      })
  }
  return await mintInFlight
}

async function mintApnsJwt(teamId: string, keyId: string, privateKeyPem: string): Promise<string> {
  if (!cachedKey) {
    cachedKey = await crypto.subtle.importKey(
      'pkcs8',
      pemToPkcs8(privateKeyPem),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
  }
  const header = { alg: 'ES256', kid: keyId }
  // Apple's provider-token spec defines exactly {iss, iat} — there is no `exp`.
  // Validity is the 1-hour window measured from `iat`.
  const claims = { iss: teamId, iat: Math.floor(Date.now() / 1000) }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  // Web Crypto ECDSA signing returns the raw IEEE P1363 (r||s) format, which
  // is exactly what JWS/JWT ES256 expects — no DER-to-raw conversion needed.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cachedKey,
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
      console.error('[push] misconfigured: missing Supabase env')
      return json({ ok: false, error: 'Server not configured' }, 500)
    }
    if (!APNS_TEAM_ID || !APNS_KEY_ID || !APNS_AUTH_KEY) {
      // Not set up yet — don't fail dispatch creation over it, just report why.
      console.error('[push] not sent: APNs secrets are not configured')
      return json({ ok: true, sent: false, reason: 'APNs not configured on the server yet' }, 200)
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

    const dispatchId = typeof body.dispatch_id === 'string' ? body.dispatch_id : ''
    if (!UUID_RE.test(dispatchId)) {
      return json({ ok: false, error: 'dispatch_id must be a UUID' }, 400)
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // Resolve the dispatch server-side rather than trusting client-supplied
    // driver_id/address. The caller awaits the insert before invoking us, so the
    // row is committed by now. This keeps the notification text and the record
    // from ever diverging, and guarantees every push is backed by a real row.
    // maybeSingle(), not single(): a missing row is an expected outcome here
    // (the job may have been cancelled), not an error to be conflated with a
    // transient failure. Both are handled distinctly below.
    const { data: dispatch, error: dispatchErr } = await admin
      .from('dispatches')
      .select('id, driver_id, site_address, status')
      .eq('id', dispatchId)
      .maybeSingle()

    // supabase-js RESOLVES with {data:null, error} on a failed query. Treating
    // that as "not found" would report a confident, wrong reason to the
    // dispatcher — the same mistake this changeset fixes in dashboard.html.
    if (dispatchErr) {
      console.error(`[push] lookup failed for dispatch ${dispatchId}: ${dispatchErr.message}`)
      return json({ ok: true, sent: false, reason: 'Dispatch lookup failed, push not attempted' }, 200)
    }
    if (!dispatch) {
      console.error(`[push] not sent: dispatch ${dispatchId} no longer exists`)
      return json({ ok: true, sent: false, reason: 'Dispatch no longer exists' }, 200)
    }
    // The invoke is fire-and-forget and the function can cold-start for seconds,
    // so a dispatcher who sent then immediately cancelled must not still punch a
    // time-sensitive "New Dispatch" alert through the driver's Driving Focus.
    if (dispatch.status !== 'active') {
      console.error(`[push] not sent: dispatch ${dispatchId} is ${dispatch.status}`)
      return json({ ok: true, sent: false, reason: `Dispatch is ${dispatch.status}` }, 200)
    }

    // If the client also sent driver_id, it must agree with the row.
    if (typeof body.driver_id === 'string' && body.driver_id && body.driver_id !== dispatch.driver_id) {
      console.error(`[push] not sent: driver_id mismatch for dispatch ${dispatchId}`)
      return json({ ok: false, error: 'driver_id does not match the dispatch' }, 400)
    }

    const driverId = dispatch.driver_id
    const address = String(dispatch.site_address ?? 'New dispatch').slice(0, MAX_ALERT_BODY)

    const { data: driverProfile, error: profileErr } = await admin
      .from('profiles')
      .select('push_token')
      .eq('id', driverId)
      .maybeSingle()

    if (profileErr) {
      console.error(`[push] lookup failed for driver ${driverId}: ${profileErr.message}`)
      return json({ ok: true, sent: false, reason: 'Driver lookup failed, push not attempted' }, 200)
    }

    const deviceToken = driverProfile?.push_token
    if (!deviceToken) {
      console.error(`[push] not sent: driver ${driverId} has no registered device`)
      return json({ ok: true, sent: false, reason: 'Driver has no registered device yet' }, 200)
    }

    const payload = JSON.stringify({
      aps: {
        alert: { title: 'New Dispatch', body: address },
        sound: 'default',
        // NOTE: 'interruption-level': 'time-sensitive' belongs here so dispatch
        // alerts pierce Driving Focus, but it is inert without the matching
        // entitlement, which cannot be added until the capability is enabled on
        // the App ID (see ios/App/App/App.entitlements). Ship both together.
      },
      dispatch_id: dispatchId,
    })

    const send = async (jwt: string) =>
      await fetch(`${APNS_HOST}/3/device/${deviceToken}`, {
        method: 'POST',
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-topic': BUNDLE_ID,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          // Retry delivery for an hour if the phone is off/out of coverage;
          // omitted or 0 means a single attempt, which is wrong for a dispatch.
          'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
          // Re-sending the same job replaces its banner instead of stacking a
          // second indistinguishable one.
          'apns-collapse-id': dispatchId,
        },
        body: payload,
      })

    let jwt = await getApnsJwt(APNS_TEAM_ID, APNS_KEY_ID, APNS_AUTH_KEY)
    let apnsRes = await send(jwt)
    let errBody = apnsRes.status === 200 ? null : await apnsRes.json().catch(() => ({} as Record<string, unknown>))

    // ExpiredProviderToken: our cached token aged out — mint a fresh one.
    // TooManyProviderTokenUpdates: we minted too fast on this connection; retry
    // with the SAME token rather than minting another, which would compound it.
    // Note we deliberately KEEP that token cached. 429 rate-limits token
    // CHANGES, it does not mean the token is invalid — discarding it would force
    // another mint on the next request and make the problem worse, not better.
    if (errBody?.reason === 'ExpiredProviderToken') {
      jwt = await getApnsJwt(APNS_TEAM_ID, APNS_KEY_ID, APNS_AUTH_KEY, true)
      apnsRes = await send(jwt)
      errBody = apnsRes.status === 200 ? null : await apnsRes.json().catch(() => ({} as Record<string, unknown>))
    } else if (errBody?.reason === 'TooManyProviderTokenUpdates') {
      await new Promise((r) => setTimeout(r, 250))
      apnsRes = await send(jwt)
      errBody = apnsRes.status === 200 ? null : await apnsRes.json().catch(() => ({} as Record<string, unknown>))
    }

    if (apnsRes.status === 200) {
      // APNs returns an empty body on success. Deno holds the connection until
      // the body is consumed or cancelled, so release it explicitly rather than
      // waiting on GC — this path runs on every successful dispatch.
      await apnsRes.body?.cancel().catch(() => {})
      return json({ ok: true, sent: true }, 200)
    }

    const reason = (errBody?.reason as string) || `APNs HTTP ${apnsRes.status}`
    console.error(`[push] not sent: driver ${driverId}, dispatch ${dispatchId}, APNs ${apnsRes.status} ${reason}`)

    // BadDeviceToken / Unregistered: the token is dead (reinstall, OS revoke,
    // etc). Clear it so future sends don't keep hitting a stale token — the
    // app will re-register and overwrite it next time it opens.
    // Scoped to the token we actually sent to: the driver may have re-registered
    // while this request was in flight, and we must not discard the new token.
    if (reason === 'BadDeviceToken' || reason === 'Unregistered') {
      await admin
        .from('profiles')
        .update({ push_token: null })
        .eq('id', driverId)
        .eq('push_token', deviceToken)
    }
    return json({ ok: true, sent: false, reason }, 200)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unexpected error'
    console.error(`[push] unexpected failure: ${msg}`)
    return json({ ok: false, error: msg }, 500)
  }
})
