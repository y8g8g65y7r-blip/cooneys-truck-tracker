// node test/roundtrips.test.js  -- synthetic trails for TruckLegs.roundTrips()
const assert = require('assert');
const L = require('../www/legs.js');

const P = { lat: 51.0000, lng: -114.2000, label: 'Pit' };
const D = { lat: 51.0000, lng: -114.0000, label: 'Site' };   // ~14 km east
const T0 = Date.parse('2026-09-29T13:00:00Z');
const MIN = 60000;

function trail() {
  const rows = [];
  let t = T0, pos = { lat: P.lat, lng: P.lng };
  const push = (p, acc) => rows.push({ lat: p.lat, lng: p.lng, accuracy: acc == null ? 4 : acc, created_at: new Date(t).toISOString() });
  return {
    rows,
    park(min, at) { if (at) pos = { lat: at.lat, lng: at.lng }; const end = t + min * MIN; while (t < end) { push(pos); t += 90000; } push(pos); return this; },
    drive(to, min, stepS) {
      const n = Math.round(min * 60 / (stepS || 5)); const a = { ...pos };
      for (let i = 1; i <= n; i++) { t += (stepS || 5) * 1000; pos = { lat: a.lat + (to.lat - a.lat) * i / n, lng: a.lng + (to.lng - a.lng) * i / n }; push(pos); }
      return this;
    },
    hole(min) { t += min * MIN; return this; },
    at() { return pos; }
  };
}
const mid = (a, b, f) => ({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f });
const rt = (rows, stops) => L.roundTrips(L.segment(rows), stops);
const near = (ms, min, tolMin) => Math.abs(ms / MIN - min) <= (tolMin || 1.6);
const iso = ms => new Date(ms).toISOString();

// 1. Three clean cycles: load 12, haul 20, dump 5, empty 18, then loading again.
{
  const tr = trail().park(1, { lat: P.lat + 0.02, lng: P.lng }).drive(P, 3);   // arrive from the yard
  for (let i = 0; i < 3; i++) tr.park(12).drive(D, 20).park(5).drive(P, 18);
  tr.park(12);
  const r = rt(tr.rows, { pickup: P, dropoff: D });
  assert.strictEqual(r.mode, 'dispatch');
  assert.strictEqual(r.summary.loads, 3);
  assert.strictEqual(r.trips.length, 3);
  assert.strictEqual(r.summary.completeTrips, 2);   // trip 3's reload is still going
  assert(near(r.firstLoad.durationMs, 12, 3), 'first load');
  assert(near(r.summary.avgLoadedMs, 20, 3), 'loaded ' + r.summary.avgLoadedMs / MIN);
  assert(near(r.summary.avgEmptyMs, 18, 3), 'empty ' + r.summary.avgEmptyMs / MIN);
  assert(near(r.summary.avgDumpMs, 5, 3), 'dump ' + r.summary.avgDumpMs / MIN);
  assert(near(r.summary.avgLoadMs, 12, 3), 'load ' + r.summary.avgLoadMs / MIN);
  assert(near(r.summary.avgCycleMs, 55, 2), 'cycle ' + r.summary.avgCycleMs / MIN);
  assert(r.trips[2].inProgress && r.trips[2].load.openEnd, 'trip 3 reloading now');
  console.log('ok 1 three clean cycles, avg cycle', Math.round(r.summary.avgCycleMs / MIN), 'min');
}

// 2. A 25-minute coffee stop on the empty return: counted in Empty, flagged.
{
  const tr = trail().drive(P, 1).park(10).drive(D, 20).park(5).drive(mid(D, P, 0.5), 9).park(25).drive(P, 9).park(10).drive(D, 20).park(4);
  const r = rt(tr.rows, { pickup: P, dropoff: D });
  const t1 = r.trips[0];
  assert.strictEqual(t1.others.length, 1);
  assert(t1.others[0].flagged && near(t1.others[0].durationMs, 25, 2));
  assert(near(t1.empty.durationMs, 43, 3), 'empty incl. stop ' + t1.empty.durationMs / MIN);
  console.log('ok 2 other stop inside the empty leg is counted and flagged');
}

// 3. A 20-minute GPS hole in the loaded haul: leg + cycle incomplete, never averaged.
{
  const tr = trail().drive(P, 1).park(10).drive(mid(P, D, 0.3), 6).hole(20).drive(D, 5).park(5).drive(P, 18).park(10).drive(D, 20).park(5);
  const r = rt(tr.rows, { pickup: P, dropoff: D });
  assert(!r.trips[0].loaded.complete && r.trips[0].loaded.noGpsMs >= 19 * MIN);
  assert(!r.trips[0].complete);
  assert(near(r.summary.avgLoadedMs, 20, 3), 'only the clean haul is averaged');
  console.log('ok 3 hole marks the leg incomplete, never averaged');
}

// 4. Single-stop job shuttling to an unnamed pit: inferred pickup.
{
  const tr = trail().drive(P, 1);
  for (let i = 0; i < 3; i++) tr.park(9).drive(D, 20).park(5).drive(P, 18);
  const r = L.roundTrips(L.segment(tr.rows), { pickup: null, dropoff: D });
  assert(r && r.mode === 'inferred', 'inferred');
  assert.strictEqual(r.summary.loads, 3);
  console.log('ok 4 single-stop shuttle infers the pickup (' + r.pickup.label + ')');
}

// 5. Single-stop job, one delivery, no shuttle, nothing called in: null.
{
  const tr = trail().drive(P, 1).park(9).drive(D, 20).park(5);
  assert.strictEqual(L.roundTrips(L.segment(tr.rows), { pickup: null, dropoff: D }), null);
  assert.strictEqual(L.roundTrips(L.segment(tr.rows), { pickup: null, dropoff: null }), null);
  console.log('ok 5 no shuttle / no coords / nothing called in -> null (existing breakdown only)');
}

// 6. Haul road passes the pit gate without stopping: not a visit.
{
  const side = { lat: P.lat, lng: P.lng - 0.05 };
  const tr = trail().park(3, side).drive(P, 4).drive(D, 20).park(5);
  const r = rt(tr.rows, { pickup: P, dropoff: D });
  assert(!r.firstLoad, 'drive-by is not a load');
  assert.strictEqual(r.trips[0].startedMidTrip, true);
  console.log('ok 6 drive-by past the pickup is ignored');
}

// 7. Bad-accuracy fixes cannot fake an exit from the pit.
{
  const tr = trail().drive(P, 1).park(10);
  tr.rows.push({ lat: P.lat + 0.01, lng: P.lng, accuracy: 180, created_at: new Date(Date.parse(tr.rows[tr.rows.length - 1].created_at) + 30000).toISOString() });
  tr.park(0).drive(D, 20).park(5).drive(P, 18).park(2);
  const r = rt(tr.rows, { pickup: P, dropoff: D });
  assert(!r.firstLoad.excursions && near(r.firstLoad.durationMs, 11, 2), JSON.stringify(r.firstLoad));
  console.log('ok 7 inaccurate fix ignored for place decisions');
}

// 8. A called-in "loaded" replaces the GPS departure it matches, and is labelled.
{
  const tr = trail().drive(P, 1).park(10).drive(D, 20).park(5).drive(P, 18).park(10).drive(D, 20).park(5);
  const g = rt(tr.rows, { pickup: P, dropoff: D });
  const gpsLeave = g.trips[0].departAt;
  const ev = [{ id: 'e1', kind: 'loaded', event_at: iso(gpsLeave - 4 * MIN), note: '32 t' }];
  const r = rt(tr.rows, { pickup: P, dropoff: D, events: ev });
  assert.strictEqual(r.trips[0].departAt, gpsLeave - 4 * MIN);
  assert.strictEqual(r.trips.length, g.trips.length, 'no extra trip');
  assert.strictEqual(r.trips[0].called[0].kind, 'loaded');
  assert.strictEqual(r.summary.calledIn, 1);
  console.log('ok 8 called-in load overrides the matching GPS boundary');
}

// 9. Wrong pickup pin (never visited) + called-in loads: trips still build.
{
  const wrongPick = { lat: 51.05, lng: -114.2, label: 'Wrong pin' };
  const tr = trail().drive(P, 1).park(10).drive(D, 20).park(5).drive(P, 18).park(10).drive(D, 20).park(5).drive(P, 5);
  const g = rt(tr.rows, { pickup: P, dropoff: D });
  const ev = [{ kind: 'loaded', event_at: iso(g.trips[0].departAt) }, { kind: 'loaded', event_at: iso(g.trips[1].departAt) }];
  const r = rt(tr.rows, { pickup: wrongPick, dropoff: D, events: ev });
  assert.strictEqual(r.summary.loads, 2, 'two dumps seen by GPS');
  assert(near(r.trips[0].loaded.durationMs, 20, 3), 'loaded = called-in load -> GPS arrival');
  assert(r.trips[0].emptyLoad && r.trips[0].complete, 'empty + load combined, cycle exact');
  assert(near(r.trips[0].totalMs, 20 + 5 + 18 + 10, 3), 'cycle ' + r.trips[0].totalMs / MIN);
  assert(r.notes.some(n => /pickup pin/.test(n)));
  console.log('ok 9 wrong pickup pin: called-in loads + GPS dumps still give cycles');
}

// 10. Called in only: no pins, no GPS at all.
{
  const ev = [['loaded', 0], ['dumped', 60], ['loaded', 120], ['dumped', 180]].map(([k, m]) => ({ kind: k, event_at: iso(T0 + m * MIN) }));
  const r = L.roundTrips(L.segment([]), { pickup: { label: 'Pit' }, dropoff: { label: 'Site' }, events: ev });
  assert(r, 'table exists from phone-ins alone');
  assert.strictEqual(r.summary.loads, 2);
  assert(near(r.trips[0].loadedDump.durationMs, 60, 0.1) && near(r.trips[0].emptyLoad.durationMs, 60, 0.1));
  assert(near(r.trips[0].totalMs, 120, 0.1) && r.trips[0].complete);
  console.log('ok 10 phone-ins alone give loads and cycles');
}

// 11. The job's own picked_up_at (office button) is the first load, deduped against an event.
{
  const tr = trail().drive(P, 1).park(10).drive(D, 20).park(5).drive(P, 18).park(10).drive(D, 20).park(5);
  const g = rt(tr.rows, { pickup: P, dropoff: D });
  const job = { picked_up_at: iso(g.trips[0].departAt + 60000), pickup_source: 'dispatch' };
  const ev = [{ kind: 'loaded', event_at: iso(g.trips[0].departAt + 2 * 60000) }];
  const r = rt(tr.rows, { pickup: P, dropoff: D, events: ev, job });
  assert.strictEqual(r.trips.length, g.trips.length);
  assert.strictEqual(r.trips[0].called.length, 1, 'one load, not two');
  console.log('ok 11 picked_up_at + event within 15 min count once');
}
console.log('all round-trip tests passed');
