// ============================================================
// Cooney's Trucking — Edge Function: check-idle-drivers
//
// Purpose: catch a truck that has stopped moving and is still on the clock.
// Runs on a pg_cron schedule (every 3 minutes, see migration 0007), because the
// whole point is that this must fire when NOBODY has the app open watching —
// a client-side "compute it when someone looks" check would miss exactly the
// case it exists for.
//
// What it does per run, per driver:
//   1. Pull that driver's most recent pings.
//   2. Radius-dwell test: walk backwards from the newest ping while every
//      earlier ping is within IDLE_RADIUS_M of it. The oldest such ping is when
//      the truck stopped.
//   3. Dwell >= IDLE_THRESHOLD_MIN  -> open (or extend) a row in idle_events,
//      and push the driver ONCE per event.
//      Dwell below the threshold    -> close any open event; the truck rolled.
//
// WHY A RADIUS TEST AND NOT www/legs.js's SEGMENTATION: this answers a much
// narrower question ("has it moved in the last 10 minutes?"). A radius test
// needs no smoothing passes and cannot be fooled by one bad fix the way a
// speed-threshold test can. legs.js stays the source of truth for REPORTING
// (per-leg times and average speeds); this stays the source of truth for the
// live alert. Keep the 10-minute number in agreement between them; do not try
// to merge the two algorithms.
//
// Deploy:
//   supabase functions deploy check-idle-drivers
//
// Secrets (all optional except the APNs three, which are already set for
// send-dispatch-push and are shared project-wide):
//   IDLE_THRESHOLD_MIN     default 10   — minutes stationary before alerting
//   IDLE_RADIUS_M          default 150  — how far a truck may drift and still count as parked
//   IDLE_PUSH_ENABLED      default true — set "false" to keep the map flag but silence the phones
//   IDLE_REQUIRE_DISPATCH  default true — only push a driver who has an active job
//
// NOTE ON DUPLICATION: the APNs JWT/send block below is a deliberate copy of
// send-dispatch-push's. That function is deployed, working, and was painful to
// get right (see project_truck_tracker memory); refactoring both onto a shared
// module would mean redeploying the dispatch push path to gain nothing but DRY.
// If the JWT logic ever changes, change it in BOTH files.
// ============================================================

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BUNDLE_ID = 'com.cooneystrucking.trucktracker'
const APNS_HOST = 'https://api.push.apple.com'
const JWT_TTL_MS = 50 * 60 * 1000
const MAX_ALERT_BODY = 300

// How many recent pings to consider per driver. At the 90s parked heartbeat
// this covers ~90 minutes of standing still, which is far beyond the threshold;
// while driving it covers only a few minutes, which is all that is needed to
// prove the truck moved.
const PINGS_PER_DRIVER = 60
// Ignore anything older than this outright, so yesterday's last ping can never
// be read as "parked for 14 hours".
const PING_WINDOW_MS = 3 * 60 * 60 * 1000
// No ping this recently means the app is not reporting at all. That is a
// different problem from being parked, and we must not claim a truck is idle
// on the strength of a ping from 40 minutes ago.
const REPORTING_STALE_MS = 8 * 60 * 1000
// An open event whose truck stopped reporting entirely gets closed rather than
// flagging the live map forever.
const ABANDON_MS = 60 * 60 * 1000

let cachedKey: CryptoKey | null = null
let cachedJwt: { token: string; mintedAt: number } | null = null
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
    .replace(/\\r/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '')
  if (!clean) throw new Error('APNS_AUTH_KEY is empty after PEM cleanup')
  let binary: string
  try {
    binary = atob(clean)
  } catch {
    throw new Error('APNS_AUTH_KEY is not valid base64 after PEM cleanup — expected a PKCS#8 .p8')
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

async function mintApnsJwt(teamId: string, keyId: string, pem: string): Promise<string> {
  if (!cachedKey) {
    cachedKey = await crypto.subtle.importKey(
      'pkcs8',
      pemToPkcs8(pem),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
  }
  const header = { alg: 'ES256', kid: keyId }
  const claims = { iss: teamId, iat: Math.floor(Date.now() / 1000) }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cachedKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${base64url(signature)}`
}

async function getApnsJwt(teamId: string, keyId: string, pem: string, force = false): Promise<string> {
  if (!force && cachedJwt && Date.now() - cachedJwt.mintedAt < JWT_TTL_MS) return cachedJwt.token
  if (!mintInFlight) {
    mintInFlight = mintApnsJwt(teamId, keyId, pem)
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

const EARTH_R = 6371000
function toRad(d: number) { return (d * Math.PI) / 180 }
function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s))
}

function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name)
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = Deno.env.get(name)
  if (raw == null || raw === '') return fallback
  return !/^(false|0|no|off)$/i.test(raw.trim())
}

// Read the `role` claim out of an already-gateway-verified JWT. Returns null
// for anything that is not a three-part JWT (e.g. the newer sb_secret_ keys),
// which simply falls through to the normal user-authentication path.
function jwtRole(token: string): string | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const claims = JSON.parse(atob(padded))
    return typeof claims.role === 'string' ? claims.role : null
  } catch {
    return null
  }
}

type Ping = { lat: string | number; lng: string | number; created_at: string; accuracy: string | number | null }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
      console.error('[idle] misconfigured: missing Supabase env')
      return json({ ok: false, error: 'Server not configured' }, 500)
    }

    // Two callers are legitimate: the pg_cron job (presents the service role
    // key) and a dispatcher hitting it by hand to test. Nobody else.
    const authHeader = req.headers.get('Authorization') || ''
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim()
    // Do NOT rely on bearer === SERVICE_ROLE_KEY. Supabase is midway through a
    // key-format migration: the key this function is handed in
    // SUPABASE_SERVICE_ROLE_KEY and the legacy service_role JWT the cron job
    // reads out of Vault are not always the same string, and a plain compare
    // silently rejected every scheduled run (verified 2026-08-16 — a manual
    // invocation with a genuine service_role key came back 401).
    //
    // Safe alternative: the platform gateway verifies the token's signature
    // BEFORE this code runs (verify_jwt is on), so by the time we see a claim
    // set it is already authentic. We only have to read the role out of it.
    const isCron = bearer.length > 0 && (bearer === SERVICE_ROLE_KEY || jwtRole(bearer) === 'service_role')
    if (!isCron) {
      if (!authHeader) return json({ ok: false, error: 'Missing authorization' }, 401)
      const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      })
      const { data: { user } } = await anon.auth.getUser()
      if (!user) return json({ ok: false, error: 'Invalid or expired session' }, 401)
      const { data: prof } = await anon.from('profiles').select('role').eq('id', user.id).single()
      if (!prof || (prof.role !== 'admin' && prof.role !== 'dispatcher')) {
        return json({ ok: false, error: 'Dispatcher access required' }, 403)
      }
    }

    const thresholdMs = envInt('IDLE_THRESHOLD_MIN', 10) * 60 * 1000
    const radiusM = envInt('IDLE_RADIUS_M', 150)
    const pushEnabled = envBool('IDLE_PUSH_ENABLED', true)
    const requireDispatch = envBool('IDLE_REQUIRE_DISPATCH', true)

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const now = Date.now()
    const windowStart = new Date(now - PING_WINDOW_MS).toISOString()

    const { data: drivers, error: driverErr } = await admin
      .from('profiles')
      .select('id, full_name, unit_number, push_token, active')
      .eq('role', 'driver')
    if (driverErr) {
      console.error(`[idle] driver roster failed: ${driverErr.message}`)
      return json({ ok: false, error: 'Driver roster query failed' }, 500)
    }
    const roster = (drivers || []).filter((d) => d.active !== false)

    const { data: openEvents, error: openErr } = await admin
      .from('idle_events')
      .select('*')
      .is('ended_at', null)
    if (openErr) {
      console.error(`[idle] open-event query failed: ${openErr.message}`)
      return json({ ok: false, error: 'Idle event query failed' }, 500)
    }
    const openByUser = new Map<string, Record<string, unknown>>()
    for (const e of openEvents || []) openByUser.set(e.user_id as string, e)

    const summary: Record<string, unknown>[] = []
    const pushes: Promise<void>[] = []

    for (const driver of roster) {
      const { data: pings, error: pingErr } = await admin
        .from('location_updates')
        .select('lat, lng, accuracy, created_at')
        .eq('user_id', driver.id)
        .gte('created_at', windowStart)
        .order('created_at', { ascending: false })
        .limit(PINGS_PER_DRIVER)

      if (pingErr) {
        console.error(`[idle] ping query failed for ${driver.id}: ${pingErr.message}`)
        continue
      }

      const open = openByUser.get(driver.id as string)
      const rows = (pings || []) as Ping[]

      if (rows.length === 0) {
        // Not reporting at all. Close a long-abandoned event so the live map
        // does not carry a permanent flag for a truck that went home.
        if (open && now - new Date(open.last_ping_at as string).getTime() > ABANDON_MS) {
          await admin.from('idle_events')
            .update({ ended_at: open.last_ping_at })
            .eq('id', open.id as string)
        }
        summary.push({ unit: driver.unit_number, state: 'no-pings' })
        continue
      }

      const newest = rows[0]
      const newestT = new Date(newest.created_at).getTime()
      if (now - newestT > REPORTING_STALE_MS) {
        if (open && now - new Date(open.last_ping_at as string).getTime() > ABANDON_MS) {
          await admin.from('idle_events')
            .update({ ended_at: open.last_ping_at })
            .eq('id', open.id as string)
        }
        summary.push({ unit: driver.unit_number, state: 'stale-reporting', lastPingMinAgo: Math.round((now - newestT) / 60000) })
        continue
      }

      // Radius dwell, newest -> oldest.
      const aLat = parseFloat(String(newest.lat))
      const aLng = parseFloat(String(newest.lng))
      let sinceT = newestT
      for (let i = 1; i < rows.length; i++) {
        const t = new Date(rows[i].created_at).getTime()
        // A hole in the trail: we do not know the truck sat still through it.
        if (sinceT - t > 10 * 60 * 1000) break
        const d = haversine(aLat, aLng, parseFloat(String(rows[i].lat)), parseFloat(String(rows[i].lng)))
        if (d > radiusM) break
        sinceT = t
      }
      const dwellMs = newestT - sinceT

      if (dwellMs < thresholdMs) {
        if (open) {
          await admin.from('idle_events').update({ ended_at: new Date(now).toISOString() }).eq('id', open.id as string)
        }
        summary.push({ unit: driver.unit_number, state: 'moving', dwellMin: Math.round(dwellMs / 60000) })
        continue
      }

      // Parked past the threshold. Extend the open event, or open a new one
      // backdated to when the truck actually stopped.
      let eventId: string
      let alreadyNotified: boolean
      let dispatchId: string | null = null

      const { data: activeDispatch } = await admin
        .from('dispatches')
        .select('id, site_address')
        .eq('driver_id', driver.id)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      dispatchId = activeDispatch?.id ?? null

      if (open) {
        eventId = open.id as string
        alreadyNotified = open.notified_at != null
        await admin.from('idle_events').update({
          last_ping_at: new Date(newestT).toISOString(),
          lat: aLat,
          lng: aLng,
          dispatch_id: dispatchId ?? open.dispatch_id ?? null,
          // Keep the earliest known start: a previous run may have seen further
          // back than this run's ping window does.
          started_at: new Date(Math.min(sinceT, new Date(open.started_at as string).getTime())).toISOString(),
        }).eq('id', eventId)
      } else {
        const { data: created, error: insErr } = await admin.from('idle_events').insert({
          user_id: driver.id,
          started_at: new Date(sinceT).toISOString(),
          last_ping_at: new Date(newestT).toISOString(),
          lat: aLat,
          lng: aLng,
          dispatch_id: dispatchId,
        }).select('id').single()
        if (insErr || !created) {
          // The partial unique index can reject a race with an overlapping run.
          // That is the index doing its job; skip this driver this cycle.
          console.error(`[idle] could not open event for ${driver.id}: ${insErr?.message}`)
          summary.push({ unit: driver.unit_number, state: 'insert-conflict' })
          continue
        }
        eventId = created.id as string
        alreadyNotified = false
      }

      const dwellMin = Math.round(dwellMs / 60000)
      summary.push({
        unit: driver.unit_number, state: 'idle', dwellMin,
        eventId, hasDispatch: !!dispatchId, notified: alreadyNotified,
      })

      if (alreadyNotified) continue
      if (!pushEnabled) continue
      if (requireDispatch && !dispatchId) continue
      if (!driver.push_token) continue

      pushes.push(
        sendIdlePush(admin, {
          driverId: driver.id as string,
          token: driver.push_token as string,
          eventId,
          dwellMin,
          address: activeDispatch?.site_address ?? null,
        }),
      )
    }

    await Promise.all(pushes)
    return json({ ok: true, checked: roster.length, thresholdMin: thresholdMs / 60000, drivers: summary }, 200)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unexpected error'
    console.error(`[idle] unexpected failure: ${msg}`)
    return json({ ok: false, error: msg }, 500)
  }
})

async function sendIdlePush(
  admin: SupabaseClient,
  args: { driverId: string; token: string; eventId: string; dwellMin: number; address: string | null },
): Promise<void> {
  const APNS_TEAM_ID = Deno.env.get('APNS_TEAM_ID')
  const APNS_KEY_ID = Deno.env.get('APNS_KEY_ID')
  const APNS_AUTH_KEY = Deno.env.get('APNS_AUTH_KEY')
  if (!APNS_TEAM_ID || !APNS_KEY_ID || !APNS_AUTH_KEY) {
    console.error('[idle] push skipped: APNs secrets not configured')
    return
  }

  // Written as a nudge, not an accusation. It goes to the driver's own phone,
  // and a message that reads like surveillance gets the app deleted.
  const body =
    (args.address ? String(args.address).slice(0, MAX_ALERT_BODY) + ' — ' : '') +
    `your truck has not moved for ${args.dwellMin} minutes. If you are held up, let dispatch know.`

  const payload = JSON.stringify({
    aps: {
      alert: { title: `Stopped ${args.dwellMin} min`, body },
      sound: 'default',
    },
    type: 'idle',
    idle_event_id: args.eventId,
  })

  const send = async (jwt: string) =>
    await fetch(`${APNS_HOST}/3/device/${args.token}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${jwt}`,
        'apns-topic': BUNDLE_ID,
        'apns-push-type': 'alert',
        // Priority 5, not 10: this is a nudge, not a dispatch. It can wait for
        // a power-efficient delivery window and must not punch through as
        // aggressively as a new job does.
        'apns-priority': '5',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 1800),
        // One banner per idle event, replaced rather than stacked.
        'apns-collapse-id': `idle-${args.eventId}`,
      },
      body: payload,
    })

  try {
    let jwt = await getApnsJwt(APNS_TEAM_ID, APNS_KEY_ID, APNS_AUTH_KEY)
    let res = await send(jwt)
    let errBody = res.status === 200 ? null : await res.json().catch(() => ({} as Record<string, unknown>))

    if (errBody?.reason === 'ExpiredProviderToken') {
      jwt = await getApnsJwt(APNS_TEAM_ID, APNS_KEY_ID, APNS_AUTH_KEY, true)
      res = await send(jwt)
      errBody = res.status === 200 ? null : await res.json().catch(() => ({} as Record<string, unknown>))
    } else if (errBody?.reason === 'TooManyProviderTokenUpdates') {
      await new Promise((r) => setTimeout(r, 250))
      res = await send(jwt)
      errBody = res.status === 200 ? null : await res.json().catch(() => ({} as Record<string, unknown>))
    }

    if (res.status === 200) {
      await res.body?.cancel().catch(() => {})
      // Stamp AFTER a confirmed delivery, never before: stamping first would
      // silently swallow the one alert this event ever gets.
      await admin.from('idle_events').update({ notified_at: new Date().toISOString() }).eq('id', args.eventId)
      return
    }

    const reason = (errBody?.reason as string) || `APNs HTTP ${res.status}`
    console.error(`[idle] push not sent: driver ${args.driverId}, event ${args.eventId}, ${reason}`)
    if (reason === 'BadDeviceToken' || reason === 'Unregistered') {
      await admin.from('profiles').update({ push_token: null })
        .eq('id', args.driverId).eq('push_token', args.token)
    }
  } catch (e) {
    console.error(`[idle] push threw for ${args.driverId}: ${e instanceof Error ? e.message : 'unknown'}`)
  }
}
