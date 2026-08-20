// ============================================================
// Cooney's Trucking — shared APNs client
//
// Extracted from send-dispatch-push (2026-07-31) when send-message-push
// needed the exact same JWT-minting/caching/retry logic. This is the only
// hand-rolled crypto in the app (ES256 provider-token JWT via Web Crypto, no
// external JWT library) — changes here affect every push path, so a fix or a
// behavior change belongs here once, not copy-pasted per function.
//
// Required secrets (project-wide, shared across all Edge Functions):
//   APNS_TEAM_ID, APNS_KEY_ID, APNS_AUTH_KEY (see send-dispatch-push's header
//   for exactly how these are created/set — unchanged by this refactor).
// ============================================================

export const BUNDLE_ID = 'com.cooneystrucking.trucktracker'
export const APNS_HOST = 'https://api.push.apple.com' // ad-hoc/TestFlight/App Store builds all use production APNs, never the sandbox host

// APNs caps the whole payload at 4KB. Free-typed text is unbounded, so callers
// should clamp any alert body through this before building a payload.
export const MAX_ALERT_BODY = 300

// Apple rejects a provider token older than 1 hour, and rejects *minting* a new
// one more than once per 20 minutes on a given connection
// (429 TooManyProviderTokenUpdates). 50 minutes sits safely inside both bounds.
const JWT_TTL_MS = 50 * 60 * 1000

// Module scope: reused while the isolate stays warm. Both are pure functions of
// the APNs secrets, so caching them is safe across requests. NOTE: each Edge
// Function that imports this module gets its OWN copy of this module state —
// Supabase bundles/deploys each function as a separate isolate, so
// send-dispatch-push and send-message-push each mint and cache their own
// token independently. That is fine (both are well inside Apple's rate limit
// on their own) and is not something a caller needs to account for.
let cachedKey: CryptoKey | null = null
let cachedJwt: { token: string; mintedAt: number } | null = null
// Single-flight: two pushes landing on one cold isolate would otherwise each
// mint a token milliseconds apart. Because WebCrypto ECDSA is non-deterministic
// those are two DISTINCT tokens, which is exactly what trips Apple's
// "one new token per 20 minutes" rule. Concurrent callers share one mint.
let mintInFlight: Promise<string> | null = null

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
    throw new Error(
      'APNS_AUTH_KEY is not valid base64 after PEM cleanup — expected a PKCS#8 .p8 ("BEGIN PRIVATE KEY")',
    )
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
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

export interface ApnsCreds {
  teamId: string
  keyId: string
  authKey: string
}

export interface ApnsSendOptions {
  /** apns-collapse-id header. Omit to let every notification stand on its own
   *  (right for a running message thread); set it when a later push should
   *  replace an earlier one (right for "here is your current dispatch"). */
  collapseId?: string
  /** Seconds from now APNs should keep retrying delivery. Default 1 hour. */
  expirationSeconds?: number
}

export interface ApnsSendResult {
  sent: boolean
  reason?: string
}

// Sends one payload to one device token, with the ExpiredProviderToken /
// TooManyProviderTokenUpdates retry dance send-dispatch-push already proved
// out in production. Callers get back a simple {sent, reason} — the JWT
// lifecycle is entirely this module's problem.
export async function sendApnsPush(
  creds: ApnsCreds,
  deviceToken: string,
  payload: Record<string, unknown>,
  opts: ApnsSendOptions = {},
): Promise<ApnsSendResult> {
  const body = JSON.stringify(payload)
  const send = async (jwt: string) =>
    await fetch(`${APNS_HOST}/3/device/${deviceToken}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${jwt}`,
        'apns-topic': BUNDLE_ID,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + (opts.expirationSeconds ?? 3600)),
        ...(opts.collapseId ? { 'apns-collapse-id': opts.collapseId } : {}),
      },
      body,
    })

  let jwt = await getApnsJwt(creds.teamId, creds.keyId, creds.authKey)
  let res = await send(jwt)
  let errBody = res.status === 200 ? null : await res.json().catch(() => ({} as Record<string, unknown>))

  // ExpiredProviderToken: our cached token aged out — mint a fresh one.
  // TooManyProviderTokenUpdates: we minted too fast on this connection; retry
  // with the SAME token rather than minting another, which would compound it.
  if (errBody?.reason === 'ExpiredProviderToken') {
    jwt = await getApnsJwt(creds.teamId, creds.keyId, creds.authKey, true)
    res = await send(jwt)
    errBody = res.status === 200 ? null : await res.json().catch(() => ({} as Record<string, unknown>))
  } else if (errBody?.reason === 'TooManyProviderTokenUpdates') {
    await new Promise((r) => setTimeout(r, 250))
    res = await send(jwt)
    errBody = res.status === 200 ? null : await res.json().catch(() => ({} as Record<string, unknown>))
  }

  if (res.status === 200) {
    // APNs returns an empty body on success. Deno holds the connection until
    // the body is consumed or cancelled, so release it explicitly.
    await res.body?.cancel().catch(() => {})
    return { sent: true }
  }

  const reason = (errBody?.reason as string) || `APNs HTTP ${res.status}`
  return { sent: false, reason }
}
