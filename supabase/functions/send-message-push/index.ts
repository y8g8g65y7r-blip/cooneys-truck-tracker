// ============================================================
// Cooney's Trucking — Edge Function: send-message-push
//
// Purpose: Real-time APNs push for the dispatch message thread (Dario's ask:
//   driver <-> dispatcher, or dispatcher <-> a subcontracted driver, need to
//   talk about a specific job — see migration 0010). Called by dashboard.html
//   / dispatcher.html right after a dispatch_messages row is inserted.
//   Fire-and-forget, same contract as send-dispatch-push: a push failure must
//   never make the message itself look like it failed to send (RLS + the
//   insert already succeeded; this is a best-effort phone alert on top).
//
//   Fan-out differs by direction: a DRIVER's message pushes every
//   admin/dispatcher with a registered device (there can be several — Kale,
//   Matt, etc.); a STAFF message pushes the one driver on the job. Content is
//   resolved entirely server-side from the message row and its dispatch/
//   sender, never trusted from the client, matching send-dispatch-push.
//
//   The APNs JWT/send mechanics live in ../_shared/apns.ts — shared with
//   send-dispatch-push. Do not re-implement that logic here.
//
// Deploy:
//   supabase functions deploy send-message-push
//
// No new secrets — reuses APNS_TEAM_ID / APNS_KEY_ID / APNS_AUTH_KEY /
// SUPABASE_SERVICE_ROLE_KEY already set for send-dispatch-push.
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
      console.error('[msg-push] misconfigured: missing Supabase env')
      return json({ ok: false, error: 'Server not configured' }, 500)
    }
    if (!APNS_TEAM_ID || !APNS_KEY_ID || !APNS_AUTH_KEY) {
      console.error('[msg-push] not sent: APNs secrets are not configured')
      return json({ ok: true, sent: 0, attempted: 0, reason: 'APNs not configured on the server yet' }, 200)
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

    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return json({ ok: false, error: 'Invalid JSON body' }, 400)
    }

    const messageId = typeof body.message_id === 'string' ? body.message_id : ''
    if (!UUID_RE.test(messageId)) {
      return json({ ok: false, error: 'message_id must be a UUID' }, 400)
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // Resolve the message + its dispatch server-side. Never trust client-
    // supplied body text or recipient identity — same rule send-dispatch-push
    // applies to site_address/driver_id.
    const { data: message, error: msgErr } = await admin
      .from('dispatch_messages')
      .select('id, dispatch_id, sender_id, body')
      .eq('id', messageId)
      .maybeSingle()

    if (msgErr) {
      console.error(`[msg-push] lookup failed for message ${messageId}: ${msgErr.message}`)
      return json({ ok: true, sent: 0, attempted: 0, reason: 'Message lookup failed' }, 200)
    }
    if (!message) {
      console.error(`[msg-push] not sent: message ${messageId} no longer exists`)
      return json({ ok: true, sent: 0, attempted: 0, reason: 'Message no longer exists' }, 200)
    }
    // Only the actual sender can trigger a push for their own message — this
    // is a phone-alert side channel on an already-authorized insert, not a
    // general "notify anyone about anything" endpoint.
    if (message.sender_id !== user.id) {
      return json({ ok: false, error: 'You did not send this message' }, 403)
    }

    const { data: dispatch, error: dispatchErr } = await admin
      .from('dispatches')
      .select('id, driver_id, site_address')
      .eq('id', message.dispatch_id)
      .maybeSingle()

    if (dispatchErr || !dispatch) {
      console.error(`[msg-push] not sent: dispatch for message ${messageId} could not be resolved`)
      return json({ ok: true, sent: 0, attempted: 0, reason: 'Dispatch could not be resolved' }, 200)
    }

    const { data: senderProfile } = await admin
      .from('profiles')
      .select('full_name, unit_number, role')
      .eq('id', user.id)
      .maybeSingle()

    const senderIsDriver = user.id === dispatch.driver_id
    const senderLabel = senderIsDriver
      ? `Unit ${senderProfile?.unit_number || '?'} (${senderProfile?.full_name || 'Driver'})`
      : (senderProfile?.full_name || 'Dispatch')
    const alertTitle = `${senderLabel} — ${String(dispatch.site_address ?? 'job').split(',')[0]}`
    const alertBody = String(message.body ?? '').slice(0, MAX_ALERT_BODY)

    // Fan-out direction: a driver's message goes to every registered
    // admin/dispatcher device; a staff message goes to the one driver on the
    // job. A dispatch can have several dispatchers (Kale, Matt, ...), so this
    // is a list either way even though the driver side is usually length 1.
    let recipientTokens: string[] = []
    if (senderIsDriver) {
      const { data: staff } = await admin
        .from('profiles')
        .select('push_token')
        .in('role', ['admin', 'dispatcher'])
        .not('push_token', 'is', null)
      recipientTokens = (staff || []).map((p) => p.push_token as string).filter(Boolean)
    } else {
      const { data: driverProfile } = await admin
        .from('profiles')
        .select('push_token')
        .eq('id', dispatch.driver_id)
        .maybeSingle()
      if (driverProfile?.push_token) recipientTokens = [driverProfile.push_token]
    }

    if (recipientTokens.length === 0) {
      console.error(`[msg-push] not sent: no registered device for message ${messageId}`)
      return json({ ok: true, sent: 0, attempted: 0, reason: 'No recipient has a registered device' }, 200)
    }

    const creds = { teamId: APNS_TEAM_ID, keyId: APNS_KEY_ID, authKey: APNS_AUTH_KEY }
    const payload = {
      aps: {
        alert: { title: alertTitle, body: alertBody },
        sound: 'default',
      },
      type: 'message',
      dispatch_id: dispatch.id,
    }

    // No collapse-id: unlike "here is your current dispatch" (one evolving
    // banner), each message is a distinct thing someone said and must not
    // silently replace an earlier, still-unread one.
    const results = await Promise.allSettled(
      recipientTokens.map((token) => sendApnsPush(creds, token, payload)),
    )

    let sentCount = 0
    const reasons: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.sent) {
        sentCount++
      } else {
        const reason = r.status === 'fulfilled' ? r.value.reason : (r.reason?.message || 'unknown error')
        reasons.push(String(reason))
        console.error(`[msg-push] not sent to token ${i}: ${reason}`)
        // Same dead-token cleanup as send-dispatch-push, best-effort — a
        // failed cleanup here must not fail the response.
        if (reason === 'BadDeviceToken' || reason === 'Unregistered') {
          admin.from('profiles').update({ push_token: null }).eq('push_token', recipientTokens[i]).then(
            () => {},
            () => {},
          )
        }
      }
    })

    return json(
      { ok: true, sent: sentCount, attempted: recipientTokens.length, reasons: reasons.length ? reasons : undefined },
      200,
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unexpected error'
    console.error(`[msg-push] unexpected failure: ${msg}`)
    return json({ ok: false, error: msg }, 500)
  }
})
