// node test/jobkit.test.js
const assert = require('assert')
const K = require('../www/jobkit.js')

let n = 0
const t = async (name, fn) => { await fn(); n++; console.log('ok  ' + name) }

;(async () => {
  // ---- navTargets: destination only -----------------------------------------
  const stop = { lat: 51.030967, lng: -114.251956, address: '166 Pinebrook Way SW, Calgary, AB', label: 'Pinebrook' }
  await t('pin mode (default): every app gets the destination and nothing else', () => {
    const ts = K.navTargets(stop)
    assert.deepStrictEqual(ts.map(x => x.app), ['apple', 'google', 'waze'])
    for (const x of ts) {
      for (const u of [x.url, x.webUrl]) {
        assert.ok(u.includes('51.030967,-114.251956'), u)
        assert.ok(!/saddr|waypoint|via=|origin=|daddr=.*daddr=/i.test(u), 'no origin/waypoints: ' + u)
        assert.ok(!/navigate=yes|dirflg|directionsmode|\/dir\//.test(u), 'pin mode must not start directions: ' + u)
      }
    }
    assert.strictEqual(ts[0].url, 'maps://?ll=51.030967,-114.251956&q=Pinebrook')
    assert.strictEqual(ts[1].url, 'comgooglemaps://?q=51.030967,-114.251956&center=51.030967,-114.251956')
    assert.strictEqual(ts[2].url, 'waze://?ll=51.030967,-114.251956')
  })
  await t('directions mode: still destination only, app computes the route', () => {
    const ts = K.navTargets(stop, { startDirections: true })
    assert.strictEqual(ts[0].url, 'maps://?daddr=51.030967,-114.251956&dirflg=d')
    assert.strictEqual(ts[1].url, 'comgooglemaps://?daddr=51.030967,-114.251956&directionsmode=driving')
    assert.strictEqual(ts[2].url, 'waze://?ll=51.030967,-114.251956&navigate=yes')
    assert.strictEqual(ts[1].webUrl, 'https://www.google.com/maps/dir/?api=1&destination=51.030967,-114.251956')
    for (const x of ts) assert.ok(!/saddr|waypoint|origin=/i.test(x.url + x.webUrl))
  })
  await t('address-only stop (no pin) passes the address text', () => {
    const ts = K.navTargets({ address: '1400 84 St SE, Calgary', lat: null, lng: null })
    assert.strictEqual(ts[0].url, 'maps://?q=1400%2084%20St%20SE%2C%20Calgary')
    assert.strictEqual(ts[2].url, 'waze://?q=1400%2084%20St%20SE%2C%20Calgary')
  })
  await t('garbage coordinates fall back to the address; nothing at all -> no targets', () => {
    assert.ok(K.navTargets({ lat: 'x', lng: 5, address: 'A St' })[0].url.includes('q=A%20St'))
    assert.ok(K.navTargets({ lat: 99, lng: 5, address: 'A St' })[0].url.includes('q=A%20St'))
    assert.deepStrictEqual(K.navTargets({}), [])
    assert.deepStrictEqual(K.navTargets(null), [])
  })
  await t('geo: URI for Android/browser', () => {
    assert.strictEqual(K.geoUri(stop), 'geo:51.030967,-114.251956?q=51.030967,-114.251956(Pinebrook)')
    assert.strictEqual(K.geoUri({ address: 'A St' }), 'geo:0,0?q=A%20St')
  })

  // ---- notice ------------------------------------------------------------------
  const bundled = { version: 'b1', text: 'Bundled text', ack_required: true, ack_text: 'I ack' }
  await t('server notice wins when well-formed', () => {
    const r = K.resolveNotice({ version: 's1', text: 'Server text', ack_required: false }, bundled)
    assert.strictEqual(r.source, 'server'); assert.strictEqual(r.text, 'Server text'); assert.strictEqual(r.ack_required, false)
  })
  await t('malformed server notice (blank text, ack on but no ack text) falls back to bundled', () => {
    assert.strictEqual(K.resolveNotice({ version: 's1', text: ' ' }, bundled).source, 'bundled')
    assert.strictEqual(K.resolveNotice({ version: 's1', text: 'x', ack_required: true }, bundled).source, 'bundled')
    assert.strictEqual(K.resolveNotice(null, bundled).text, 'Bundled text')
  })
  await t('ack key changes with notice version and app build', () => {
    assert.notStrictEqual(K.ackKey('u', 'v1', '7'), K.ackKey('u', 'v2', '7'))
    assert.notStrictEqual(K.ackKey('u', 'v1', '7'), K.ackKey('u', 'v1', '8'))
  })

  // ---- thread ------------------------------------------------------------------
  const me = 'me', job = { id: 'j', created_at: '2026-10-12T14:00:00Z', accepted_at: '2026-10-12T14:01:00Z', picked_up_at: '2026-10-12T14:30:10Z', pickup_source: 'tap', status: 'active' }
  const msgs = [{ id: 'm1', sender_id: 'staff', body: 'Go to pit 3', created_at: '2026-10-12T14:05:00Z' },
                { id: 'm2', sender_id: me, body: 'Scale ticket 4471', kind: 'note', created_at: '2026-10-12T14:31:00Z' }]
  const evs = [{ id: 'e1', kind: 'loaded', event_at: '2026-10-12T14:30:00Z', source: 'driver', driver_id: me }]
  await t('thread merges messages, notes, taps and milestones in order; a tap-explained Loaded flag is not doubled', () => {
    const it = K.threadItems({ messages: msgs, events: evs, job, myId: me })
    assert.deepStrictEqual(it.map(x => x.type + ':' + (x.what || x.kind || x.id)), ['system:sent', 'system:accepted', 'message:m1', 'event:loaded', 'note:m2'])
    assert.strictEqual(it.find(x => x.id === 'm2').mine, true)
  })
  await t('geofence/office Loaded with no tap shows as a milestone', () => {
    const it = K.threadItems({ messages: [], events: [], job: Object.assign({}, job, { pickup_source: 'geofence' }), myId: me })
    assert.ok(it.some(x => x.what === 'picked_up' && x.source === 'geofence'))
  })
  await t('pending outbox items appear once, then defer to the server copy', () => {
    const pend = [{ id: 'p1', type: 'load_event', payload: { kind: 'dumped', event_at: '2026-10-12T15:00:00Z' }, state: 'pending' },
                  { id: 'm1', type: 'message', payload: { body: 'dup' }, created_at: '2026-10-12T14:05:00Z', state: 'pending' }]
    const it = K.threadItems({ messages: msgs, events: evs, job, myId: me, pending: pend })
    assert.strictEqual(it.filter(x => x.id === 'm1').length, 1)
    assert.strictEqual(it.find(x => x.id === 'p1').state, 'pending')
  })
  await t('load summary counts and alternates; failed taps do not count', () => {
    const it = K.threadItems({ messages: [], events: evs, job, myId: me, pending: [
      { id: 'p1', type: 'load_event', payload: { kind: 'dumped', event_at: '2026-10-12T15:00:00Z' }, state: 'pending' },
      { id: 'p2', type: 'load_event', payload: { kind: 'loaded', event_at: '2026-10-12T15:30:00Z' }, state: 'failed' }] })
    const s = K.loadSummary(it, job)
    assert.deepStrictEqual([s.loads, s.unloads, s.last.kind, s.next], [1, 1, 'dumped', 'loaded'])
  })
  await t('old-build / geofence Loaded with no events still counts as load 1', () => {
    const s = K.loadSummary([], job)
    assert.deepStrictEqual([s.loads, s.next], [1, 'dumped'])
    assert.strictEqual(K.loadSummary([], { status: 'active' }).next, 'loaded')
  })

  // ---- outbox ------------------------------------------------------------------
  const mem = () => { const m = {}; return { getItem: k => m[k] || null, setItem: (k, v) => { m[k] = v }, _m: m } }
  await t('error classification', () => {
    assert.strictEqual(K.classifyError(null), 'ok')
    assert.strictEqual(K.classifyError({ code: '23505' }), 'ok')
    assert.strictEqual(K.classifyError({ code: '42501' }), 'permanent')
    assert.strictEqual(K.classifyError({ code: 'P0001' }), 'permanent')
    assert.strictEqual(K.classifyError({ code: '', message: 'TypeError: Failed to fetch' }), 'retry')
    assert.strictEqual(K.classifyError({ code: 'PGRST301', message: 'JWT expired' }), 'retry')
  })
  await t('offline: items persist, keep order, back off; reconnect delivers in order', async () => {
    let clock = 1000, online = false; const sent = []
    const st = mem()
    const ob = new K.Outbox({ storage: st, key: 'k', now: () => clock, send: async it => online ? (sent.push(it.payload.n), { error: null }) : { error: { message: 'Failed to fetch' } } })
    ob.enqueue({ type: 'load_event', payload: { n: 1 } }); ob.enqueue({ type: 'message', payload: { n: 2 } })
    assert.strictEqual(await ob.flush(), 0)
    assert.strictEqual(ob.items()[0].tries, 1); assert.strictEqual(ob.items()[1].tries, 0, 'stops at first network failure')
    // app restart: the queue is still there
    const ob2 = new K.Outbox({ storage: st, key: 'k', now: () => clock, send: async it => online ? (sent.push(it.payload.n), { error: null }) : { error: { message: 'x' } } })
    assert.strictEqual(ob2.count(), 2)
    online = true
    assert.strictEqual(await ob2.flush(), 0, 'backoff not elapsed yet'); clock += 2001
    assert.strictEqual(await ob2.flush(), 2); assert.deepStrictEqual(sent, [1, 2]); assert.strictEqual(ob2.count(), 0)
  })
  await t('force flush (signal back / Retry now) ignores the backoff', async () => {
    let clock = 0, online = false
    const ob = new K.Outbox({ storage: mem(), key: 'k', now: () => clock, send: async () => online ? { error: null } : { error: { message: 'Failed to fetch' } } })
    ob.enqueue({ type: 'message', payload: {} })
    for (let i = 0; i < 6; i++) { await ob.flush({ force: true }) }
    assert.ok(ob.items()[0].nextAt - clock >= 60000, 'backed off to the 60 s cap')
    online = true
    assert.strictEqual(await ob.flush(), 0, 'a timer flush still waits')
    assert.strictEqual(await ob.flush({ force: true }), 1, 'a forced flush sends now')
  })
  await t('duplicate (lost response, retried) counts as delivered', async () => {
    const ob = new K.Outbox({ storage: mem(), key: 'k', send: async () => ({ error: { code: '23505' } }) })
    ob.enqueue({ type: 'message', payload: {} }); assert.strictEqual(await ob.flush(), 1); assert.strictEqual(ob.count(), 0)
  })
  await t('a database rejection fails that item only, visibly, and the rest still send', async () => {
    const ob = new K.Outbox({ storage: mem(), key: 'k', send: async it => it.payload.bad ? { error: { code: '42501', message: 'row-level security' } } : { error: null } })
    ob.enqueue({ type: 'load_event', payload: { bad: true } }); ob.enqueue({ type: 'message', payload: {} })
    assert.strictEqual(await ob.flush(), 1)
    assert.strictEqual(ob.items()[0].state, 'failed'); assert.ok(/row-level/.test(ob.items()[0].lastError))
    assert.ok(ob.retry(ob.items()[0].id)); assert.strictEqual(ob.items()[0].state, 'pending')
    ob.items()[0].state = 'failed'; assert.ok(ob.discard(ob.items()[0].id)); assert.strictEqual(ob.count(), 0)
  })
  await t('undo window: held until notBefore, cancel removes it unsent', async () => {
    let clock = 0; let calls = 0
    const ob = new K.Outbox({ storage: mem(), key: 'k', now: () => clock, send: async () => (calls++, { error: null }) })
    const a = ob.enqueue({ type: 'load_event', payload: {}, delayMs: 5000 })
    assert.strictEqual(await ob.flush(), 0); assert.strictEqual(calls, 0)
    assert.strictEqual(ob.nextDueAt(), 5000)
    assert.ok(ob.cancel(a.id)); assert.strictEqual(ob.count(), 0)
    ob.enqueue({ type: 'load_event', payload: {}, delayMs: 5000 }); clock = 5001
    assert.strictEqual(await ob.flush(), 1)
  })
  await t('concurrent flushes share one run (no double send)', async () => {
    let calls = 0
    const ob = new K.Outbox({ storage: mem(), key: 'k', send: async () => { calls++; await new Promise(r => setTimeout(r, 10)); return { error: null } } })
    ob.enqueue({ type: 'message', payload: {} })
    await Promise.all([ob.flush(), ob.flush(), ob.flush()]); assert.strictEqual(calls, 1)
  })
  await t('a killed app left an item mid-send: it is retried on next start', () => {
    const st = mem(); st.setItem('k', JSON.stringify([{ id: 'x', type: 'message', payload: {}, state: 'sending', tries: 0 }]))
    const ob = new K.Outbox({ storage: st, key: 'k', send: async () => ({}) })
    assert.strictEqual(ob.items()[0].state, 'pending')
  })
  await t('uuid4 shape', () => { assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(K.uuid4())) })

  console.log(`\n${n} passed`)
})().catch(e => { console.error('FAIL', e); process.exit(1) })
