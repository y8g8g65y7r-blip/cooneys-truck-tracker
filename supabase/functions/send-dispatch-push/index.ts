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
//   The APNs JWT/send mechanics live in ../_shared/apns.ts — shared with
//   send-message-push. Do not re-implement that logic here.
//
// Deploy:
//   supabase functions deploy send-dispatch-push
//
// Required secrets (server-only — set ONCE, never commit):
//   supabase secrets set APNS_TEAM_ID=7Y339CK6MY
//   supabase secrets set APNS_KEY_ID=<key id from the .p8 you download>
//   supabase secrets set APNS_AUTH_KEY="$(cat AuthKey_XXXXXXXXXX.p8)"
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service role key>
//     (skip if already set — secrets are shared project-wide across all Edge
//     Functions, not per-function)
//
// The APNs auth key (.p8) is created once in Apple Developer Portal ->
// Certificates, Identifiers & Profiles -> Keys -> "+" -> check "Apple Push
// Notifications service (APNs)". One key works for push across the whole
// team, unlike the per-app App Store Connect API key used for TestFlight —
// there's no REST API to create this key, it's a manual UI step, and Apple
// only lets you download the .p8 once.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { MAX_ALERT_BODY, sendApnsPush } from '../_shared/apns.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
    const { data: dispatch, error: dispatchErr } = await admin
      .from('dispatches')
      .select('id, driver_id, site_address, status')
      .eq('id', dispatchId)
      .maybeSingle()

    if (dispatchErr) {
      console.error(`[push] lookup failed for dispatch ${dispatchId}: ${dispatchErr.message}`)
      return json({ ok: true, sent: false, reason: 'Dispatch lookup failed, push not attempted' }, 200)
    }
    if (!dispatch) {
      console.error(`[push] not sent: dispatch ${dispatchId} no longer exists`)
      return json({ ok: true, sent: false, reason: 'Dispatch no longer exists' }, 200)
    }
    if (dispatch.status !== 'active') {
      console.error(`[push] not sent: dispatch ${dispatchId} is ${dispatch.status}`)
      return json({ ok: true, sent: false, reason: `Dispatch is ${dispatch.status}` }, 200)
    }

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

    const result = await sendApnsPush(
      { teamId: APNS_TEAM_ID, keyId: APNS_KEY_ID, authKey: APNS_AUTH_KEY },
      deviceToken,
      {
        aps: {
          alert: { title: 'New Dispatch', body: address },
          sound: 'default',
        },
        type: 'dispatch',
        dispatch_id: dispatchId,
      },
      {
        // Re-sending the same job replaces its banner instead of stacking a
        // second indistinguishable one.
        collapseId: dispatchId,
      },
    )

    if (result.sent) return json({ ok: true, sent: true }, 200)

    console.error(`[push] not sent: driver ${driverId}, dispatch ${dispatchId}, reason ${result.reason}`)

    // BadDeviceToken / Unregistered: the token is dead (reinstall, OS revoke,
    // etc). Clear it so future sends don't keep hitting a stale token — the
    // app will re-register and overwrite it next time it opens. Scoped to the
    // token we actually sent to: the driver may have re-registered while this
    // request was in flight, and we must not discard the new token.
    if (result.reason === 'BadDeviceToken' || result.reason === 'Unregistered') {
      await admin
        .from('profiles')
        .update({ push_token: null })
        .eq('id', driverId)
        .eq('push_token', deviceToken)
    }
    return json({ ok: true, sent: false, reason: result.reason }, 200)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unexpected error'
    console.error(`[push] unexpected failure: ${msg}`)
    return json({ ok: false, error: msg }, 500)
  }
})
