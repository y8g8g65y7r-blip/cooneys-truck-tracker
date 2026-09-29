// ============================================================
// Cooney's Trucking — Truck Tracker: leg / idle segmentation
//
// Turns a raw stream of location_updates rows into the thing dispatch
// actually wants to read: alternating DRIVING legs and STOPS, with a real
// average speed per leg that excludes loading/unloading time.
//
// Why this exists: a bulk-haul dispatch is not one trip. A driver assigned
// "Burnco -> job site" shuttles the same two points from 07:00 to 17:00 and
// never marks the job complete, so a single "on job: 10h" number says nothing.
// Splitting the GPS trail on its own stops gives per-leg times and speeds with
// zero extra taps from the driver.
//
// Loaded as a classic script by dashboard.html and dispatcher.html; also
// require()-able from Node for the test harness. Deliberately dependency-free.
//
// NOTE ON THE EDGE FUNCTION: supabase/functions/check-idle-drivers does NOT
// share this code. It answers a much narrower question ("has this truck moved
// in the last 10 minutes?") with a radius-dwell test that needs no smoothing
// and is immune to a single bad fix. Keep the two thresholds (IDLE_ALERT_MS
// here, IDLE_THRESHOLD_MS there) in agreement — 10 minutes — but do not try to
// merge the algorithms, they are answering different questions.
// ============================================================

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TruckLegs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = {
    // Sustained below this = not driving. A truck creeping in a pit queue runs
    // 3-6 km/h, so this sits just under that; GPS jitter on a 90s heartbeat is
    // well under 1 km/h.
    idleSpeedKph: 4,
    // A stop shorter than this is a light, a stop sign or a scale queue, not a
    // real stop — it must not chop one highway run into three "legs".
    minIdleMs: 3 * 60 * 1000,
    // A "leg" this short and this close is yard shuffling or GPS wander, not a
    // trip. Folded back into the stop around it.
    minLegDistanceM: 300,
    // Longer than this between pings and we do not know what happened. The
    // trail breaks rather than inventing a very slow leg across the hole —
    // that is exactly the false "40 km/h" reading this feature must not produce.
    maxGapMs: 10 * 60 * 1000,
    // Obvious cell-tower fixes rather than GPS. Dropped outright.
    maxAccuracyM: 250,
    // Implied speed above this between two fixes is a glitch, not a truck.
    // Treated as a trail break so the bad jump never lands in a distance total.
    maxPlausibleKph: 200,
    // Two stops within this of each other are the same place (the pit scale vs.
    // the pit loader are one "Burnco" as far as dispatch is concerned).
    stopClusterM: 250,
    // A stop this close to a known anchor (the dispatch site) takes its name.
    anchorMatchM: 500,
    // Matt's rule: 10 minutes stationary triggers the driver alert. Note this
    // ALSO covers a perfectly legitimate 15-minute load at the pit, which is
    // why the reporting UI does not paint everything over 10 minutes red — it
    // uses the two tiers below instead, and the 10-minute bar is reserved for
    // the push/map "not moving right now" signal.
    idleAlertMs: 10 * 60 * 1000,
    // Reporting tiers: longer than a normal load/dump cycle, and clearly long.
    longStopMs: 20 * 60 * 1000,
    veryLongStopMs: 45 * 60 * 1000,
    // Steps shorter than this are ignored when picking a leg's top speed —
    // a 3-second sample is noise, not a sustained speed.
    maxSpeedMinStepMs: 20 * 1000
  };

  var EARTH_R = 6371000;

  function toRad(d) { return d * Math.PI / 180; }

  function haversine(aLat, aLng, bLat, bLng) {
    var dLat = toRad(bLat - aLat);
    var dLng = toRad(bLng - aLng);
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * EARTH_R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function opts(o) {
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    if (o) for (var j in o) if (o[j] != null) out[j] = o[j];
    return out;
  }

  // --- point normalisation ------------------------------------------------
  // Supabase returns numeric columns as strings, rows can arrive in either
  // order, and a duplicate timestamp would produce a divide-by-zero step.
  function normalize(rows, o) {
    var pts = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      var lat = parseFloat(r.lat);
      var lng = parseFloat(r.lng);
      var t = new Date(r.created_at).getTime();
      if (!isFinite(lat) || !isFinite(lng) || !isFinite(t)) continue;
      var acc = r.accuracy == null ? null : parseFloat(r.accuracy);
      if (acc != null && isFinite(acc) && acc > o.maxAccuracyM) continue;
      pts.push({ lat: lat, lng: lng, t: t, accuracy: acc, source: r.source || null });
    }
    pts.sort(function (a, b) { return a.t - b.t; });
    // Collapse identical timestamps — keep the first, they carry no new time.
    var out = [];
    for (var k = 0; k < pts.length; k++) {
      if (out.length && pts[k].t === out[out.length - 1].t) continue;
      out.push(pts[k]);
    }
    return out;
  }

  // --- step classification ------------------------------------------------
  function buildSteps(pts, o) {
    var steps = [];
    for (var i = 1; i < pts.length; i++) {
      var dt = pts[i].t - pts[i - 1].t;
      if (dt <= 0) continue;
      var dist = haversine(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
      var kph = (dist / 1000) / (dt / 3600000);
      var kind;
      if (dt > o.maxGapMs) kind = 'gap';
      else if (kph > o.maxPlausibleKph) kind = 'gap';
      else if (kph < o.idleSpeedKph) kind = 'idle';
      else kind = 'move';
      steps.push({ a: i - 1, b: i, dt: dt, dist: dist, kph: kph, kind: kind });
    }
    return steps;
  }

  function merge(steps) {
    var segs = [];
    for (var i = 0; i < steps.length; i++) {
      var last = segs[segs.length - 1];
      if (last && last.kind === steps[i].kind) {
        last.steps.push(steps[i]);
        last.b = steps[i].b;
      } else {
        segs.push({ kind: steps[i].kind, a: steps[i].a, b: steps[i].b, steps: [steps[i]] });
      }
    }
    return segs;
  }

  function totals(seg) {
    var dt = 0, dist = 0;
    for (var i = 0; i < seg.steps.length; i++) { dt += seg.steps[i].dt; dist += seg.steps[i].dist; }
    return { dt: dt, dist: dist };
  }

  // Two smoothing rules, applied until stable. Gaps are never absorbed or
  // reclassified — an unknown stretch stays unknown.
  function smooth(segs, o) {
    for (var pass = 0; pass < 6; pass++) {
      var changed = false;
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        var prev = segs[i - 1];
        var next = segs[i + 1];
        var t = totals(s);
        // Brief stop between two driving runs -> it was traffic, keep driving.
        if (s.kind === 'idle' && t.dt < o.minIdleMs &&
            prev && prev.kind === 'move' && next && next.kind === 'move') {
          s.kind = 'move'; changed = true;
        }
        // Short shuffle between two stops -> repositioning inside one place.
        if (s.kind === 'move' && t.dist < o.minLegDistanceM &&
            prev && prev.kind === 'idle' && next && next.kind === 'idle') {
          s.kind = 'idle'; changed = true;
        }
      }
      if (!changed) break;
      // Re-merge: reclassification can leave neighbours of the same kind.
      var flat = [];
      for (var j = 0; j < segs.length; j++) {
        for (var k = 0; k < segs[j].steps.length; k++) {
          flat.push({ a: segs[j].steps[k].a, b: segs[j].steps[k].b, dt: segs[j].steps[k].dt,
                      dist: segs[j].steps[k].dist, kph: segs[j].steps[k].kph, kind: segs[j].kind });
        }
      }
      segs = merge(flat);
    }
    return segs;
  }

  function centroid(pts, a, b) {
    var lat = 0, lng = 0, n = 0;
    for (var i = a; i <= b; i++) { lat += pts[i].lat; lng += pts[i].lng; n++; }
    return n ? { lat: lat / n, lng: lng / n } : null;
  }

  // Fastest SUSTAINED speed in a segment: the highest average over any run of
  // consecutive steps spanning at least maxSpeedMinStepMs.
  //
  // The obvious version — "max over steps longer than 20s" — is wrong, and was
  // wrong in production: pings arrive every ~3s while driving, so almost no
  // single step qualifies, and the handful that do are the ones where the GPS
  // paused (typically at a light). That reported a top speed of 8 km/h on a leg
  // averaging 56 km/h. A window, not a filter.
  function maxSpeed(seg, o) {
    var steps = seg.steps;
    var best = null;
    for (var i = 0; i < steps.length; i++) {
      var dt = 0, dist = 0;
      for (var j = i; j < steps.length; j++) {
        dt += steps[j].dt;
        dist += steps[j].dist;
        if (dt >= o.maxSpeedMinStepMs) {
          var kph = (dist / 1000) / (dt / 3600000);
          if (best == null || kph > best) best = kph;
          break;
        }
      }
    }
    if (best == null) {
      // Segment shorter than the window — fall back to the single fastest step.
      for (var k = 0; k < steps.length; k++) {
        if (best == null || steps[k].kph > best) best = steps[k].kph;
      }
    }
    return best;
  }

  // --- stop naming --------------------------------------------------------
  // Idle segments at the same physical place get one label, so a shuttle run
  // reads "Stop A -> Stop B, Stop B -> Stop A" instead of six unrelated stops.
  // An anchor (the dispatch's own site coordinates) claims its cluster by name.
  function clusterStops(stops, o, anchors) {
    var clusters = [];
    for (var i = 0; i < stops.length; i++) {
      var s = stops[i];
      if (!s.lat && !s.lng) continue;
      var hit = null;
      for (var c = 0; c < clusters.length; c++) {
        if (haversine(clusters[c].lat, clusters[c].lng, s.lat, s.lng) <= o.stopClusterM) { hit = clusters[c]; break; }
      }
      if (!hit) {
        hit = { id: clusters.length, sumLat: 0, sumLng: 0, n: 0, lat: s.lat, lng: s.lng,
                visits: 0, totalMs: 0, label: null };
        clusters.push(hit);
      }
      hit.sumLat += s.lat; hit.sumLng += s.lng; hit.n++;
      hit.lat = hit.sumLat / hit.n; hit.lng = hit.sumLng / hit.n;
      hit.visits++; hit.totalMs += s.durationMs;
      s.stopId = hit.id;
    }
    var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    var letterIdx = 0;
    for (var d = 0; d < clusters.length; d++) {
      // NEAREST anchor within range, not the first one listed: a dispatch can
      // now carry two (pickup + drop-off), and a pit and a site under a
      // kilometre apart must not both be labelled with whichever came first.
      var named = null, bestM = Infinity;
      for (var a = 0; a < (anchors || []).length; a++) {
        var an = anchors[a];
        if (an.lat == null || an.lng == null) continue;
        var m = haversine(parseFloat(an.lat), parseFloat(an.lng), clusters[d].lat, clusters[d].lng);
        if (m <= o.anchorMatchM && m < bestM) { named = an.label; bestM = m; }
      }
      clusters[d].label = named || ('Stop ' + (letters[letterIdx++] || ('#' + (d + 1))));
      clusters[d].named = !!named;
    }
    for (var e = 0; e < stops.length; e++) {
      if (stops[e].stopId != null) stops[e].stopLabel = clusters[stops[e].stopId].label;
    }
    return clusters;
  }

  // --- public API ---------------------------------------------------------
  //
  // segment(rows, options) -> {
  //   points, segments, legs, stops, gaps, stopPlaces, summary
  // }
  // Every entry in `segments` is one of:
  //   { type:'leg',  startAt, endAt, durationMs, distanceM, avgKph, maxKph, from, to }
  //   { type:'stop', startAt, endAt, durationMs, lat, lng, stopLabel, overThreshold }
  //   { type:'gap',  startAt, endAt, durationMs }   // no data, nothing claimed
  function segment(rows, options) {
    var o = opts(options);
    var pts = normalize(rows, o);
    var result = {
      points: pts,
      segments: [],
      legs: [],
      stops: [],
      gaps: [],
      stopPlaces: [],
      summary: {
        legCount: 0, stopCount: 0, drivingMs: 0, stoppedMs: 0, noDataMs: 0,
        distanceM: 0, avgKph: null, maxKph: null,
        longestStopMs: 0, flaggedStopCount: 0, longStopCount: 0,
        firstPingAt: pts.length ? pts[0].t : null,
        lastPingAt: pts.length ? pts[pts.length - 1].t : null,
        pointCount: pts.length
      }
    };
    if (pts.length < 2) return result;

    var segs = smooth(merge(buildSteps(pts, o)), o);

    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      var t = totals(s);
      var base = {
        startAt: pts[s.a].t,
        endAt: pts[s.b].t,
        durationMs: t.dt,
        startIndex: s.a,
        endIndex: s.b
      };
      if (s.kind === 'move') {
        base.type = 'leg';
        base.distanceM = t.dist;
        base.avgKph = t.dt > 0 ? (t.dist / 1000) / (t.dt / 3600000) : null;
        base.maxKph = maxSpeed(s, o);
        base.start = { lat: pts[s.a].lat, lng: pts[s.a].lng };
        base.end = { lat: pts[s.b].lat, lng: pts[s.b].lng };
        result.legs.push(base);
      } else if (s.kind === 'idle') {
        base.type = 'stop';
        var c = centroid(pts, s.a, s.b);
        base.lat = c ? c.lat : null;
        base.lng = c ? c.lng : null;
        base.overThreshold = t.dt >= o.idleAlertMs;
        base.long = t.dt >= o.longStopMs;
        base.veryLong = t.dt >= o.veryLongStopMs;
        result.stops.push(base);
      } else {
        base.type = 'gap';
        // Straight-line only, and deliberately NOT added to any distance total:
        // we do not know the route taken, so we do not claim it.
        base.straightLineM = t.dist;
        result.gaps.push(base);
      }
      result.segments.push(base);
    }

    result.stopPlaces = clusterStops(result.stops, o, options && options.anchors);

    // Legs read "from where to where" using the stops either side of them.
    for (var j = 0; j < result.segments.length; j++) {
      var seg = result.segments[j];
      if (seg.type !== 'leg') continue;
      var before = null, after = null;
      for (var b = j - 1; b >= 0; b--) { if (result.segments[b].type === 'stop') { before = result.segments[b]; break; } if (result.segments[b].type === 'gap') break; }
      for (var f = j + 1; f < result.segments.length; f++) { if (result.segments[f].type === 'stop') { after = result.segments[f]; break; } if (result.segments[f].type === 'gap') break; }
      seg.fromLabel = before ? before.stopLabel : null;
      seg.toLabel = after ? after.stopLabel : null;
    }

    var sm = result.summary;
    sm.legCount = result.legs.length;
    sm.stopCount = result.stops.length;
    for (var L = 0; L < result.legs.length; L++) {
      sm.drivingMs += result.legs[L].durationMs;
      sm.distanceM += result.legs[L].distanceM;
      if (result.legs[L].maxKph != null && (sm.maxKph == null || result.legs[L].maxKph > sm.maxKph)) sm.maxKph = result.legs[L].maxKph;
    }
    for (var S = 0; S < result.stops.length; S++) {
      sm.stoppedMs += result.stops[S].durationMs;
      if (result.stops[S].durationMs > sm.longestStopMs) sm.longestStopMs = result.stops[S].durationMs;
      if (result.stops[S].overThreshold) sm.flaggedStopCount++;
      if (result.stops[S].long) sm.longStopCount++;
    }
    for (var G = 0; G < result.gaps.length; G++) sm.noDataMs += result.gaps[G].durationMs;
    sm.avgKph = sm.drivingMs > 0 ? (sm.distanceM / 1000) / (sm.drivingMs / 3600000) : null;
    return result;
  }

  // --- round trips (pickup -> drop-off cycles) ------------------------------
  //
  // Matt (2026-09-29): "show each leg of each trip's time, from load to
  // drop-off, then a separate time from that drop-off to the next pickup".
  // segment() only knows anonymous driving runs and stops; this classifies the
  // trail against the job's two real places and folds it into cycles:
  //
  //   Load (dwell at pickup) -> Loaded (pickup -> drop-off) ->
  //   Dump (dwell at drop-off) -> Empty (drop-off -> next pickup) -> repeat
  //
  // Places are geofences, not stop segments, because a truck creeping through
  // a pit queue at 5 km/h is "loading", not "driving". Radii match the server
  // geofence (advance_pickups_by_geofence): inside 250 m to arrive, beyond
  // 500 m to leave. Fixes worse than 100 m accuracy are ignored for place
  // decisions (their time still counts).
  //
  // Holes follow segment()'s rule: never invent a time across one. A travel
  // phase containing a hole > maxGapMs is incomplete and left out of every
  // average. A dwell whose ends are both inside the place still has a real
  // arrive and leave time, so it is kept, but a hole inside it also marks it
  // incomplete (the truck could have left and come back unseen).
  var TRIP_DEFAULTS = { enterM: 250, exitM: 500, placeAccuracyM: 100, minVisitMs: 2 * 60 * 1000,
                        otherStopFlagMs: 10 * 60 * 1000 };

  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }

  function findVisits(pts, places, o) {
    var visits = [], cur = null, prevT = null;
    function dist(p, pl) { return haversine(p.lat, p.lng, pl.lat, pl.lng); }
    function nearestInside(p) {
      var best = null, bestM = Infinity;
      for (var i = 0; i < places.length; i++) {
        var m = dist(p, places[i]);
        if (m <= o.enterM && m < bestM) { best = places[i]; bestM = m; }
      }
      return best;
    }
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (cur && prevT != null && p.t - prevT > o.maxGapMs) cur.holeMs += p.t - prevT;
      prevT = p.t;
      if (p.accuracy != null && p.accuracy > o.placeAccuracyM) continue;
      if (cur) {
        var d = dist(p, cur.place);
        var other = nearestInside(p);
        if (d <= o.exitM && !(other && other !== cur.place && dist(p, other) < d)) {
          cur.leave = p.t; cur.lastIndex = i;
          continue;
        }
        visits.push(cur); cur = null;
      }
      var inside = nearestInside(p);
      if (inside) cur = { place: inside, key: inside.key, arrive: p.t, leave: p.t, firstIndex: i, lastIndex: i, holeMs: 0, excursions: [] };
    }
    if (cur) visits.push(cur);
    // Drive-bys (the haul road passes the pit gate) are not visits.
    visits = visits.filter(function (v) { return v.leave - v.arrive >= o.minVisitMs; });
    // Left and came back without reaching the other place: one visit, with the
    // time away recorded so it is visible rather than silently absorbed.
    var merged = [];
    for (var j = 0; j < visits.length; j++) {
      var last = merged[merged.length - 1];
      if (last && last.key === visits[j].key) {
        last.excursions.push({ startAt: last.leave, endAt: visits[j].arrive, durationMs: visits[j].arrive - last.leave });
        last.leave = visits[j].leave; last.lastIndex = visits[j].lastIndex;
        last.holeMs += visits[j].holeMs;
      } else merged.push(visits[j]);
    }
    return merged;
  }

  function holeBetween(pts, fromT, toT, o) {
    var ms = 0;
    for (var i = 1; i < pts.length; i++) {
      if (pts[i].t <= fromT) continue;
      if (pts[i - 1].t >= toT) break;
      var dt = pts[i].t - pts[i - 1].t;
      if (dt > o.maxGapMs) ms += dt;
    }
    return ms;
  }

  // Stops from segment() that sit between the two places: fuel, scale, a break.
  // Their time stays in the leg they interrupt; they are listed so an empty
  // return with a 25-minute coffee stop in it is visible.
  function otherStopsBetween(result, fromT, toT, places, o) {
    var out = [];
    for (var i = 0; i < result.stops.length; i++) {
      var s = result.stops[i];
      if (s.endAt <= fromT || s.startAt >= toT || s.lat == null) continue;
      var atPlace = false;
      for (var k = 0; k < places.length; k++) {
        if (haversine(s.lat, s.lng, places[k].lat, places[k].lng) <= o.exitM) { atPlace = true; break; }
      }
      if (atPlace) continue;
      var ms = Math.min(s.endAt, toT) - Math.max(s.startAt, fromT);
      out.push({ startAt: s.startAt, endAt: s.endAt, durationMs: ms, label: s.stopLabel || 'Stop',
                 lat: s.lat, lng: s.lng, flagged: ms >= o.otherStopFlagMs });
    }
    return out;
  }

  function dwellPhase(v, pts, o) {
    var truncStart = v.firstIndex === 0, truncEnd = v.lastIndex === pts.length - 1;
    return {
      startAt: v.arrive, endAt: v.leave, durationMs: v.leave - v.arrive,
      noGpsMs: v.holeMs, excursions: v.excursions,
      // Data starting/ending inside the place means we did not see the arrival
      // (or the departure): the real dwell is longer than what is shown.
      openStart: truncStart, openEnd: truncEnd,
      complete: !truncStart && !truncEnd && v.holeMs === 0
    };
  }

  function travelPhase(result, pts, fromV, toV, places, o) {
    var noGps = holeBetween(pts, fromV.leave, toV.arrive, o);
    return {
      startAt: fromV.leave, endAt: toV.arrive, durationMs: toV.arrive - fromV.leave,
      noGpsMs: noGps, others: otherStopsBetween(result, fromV.leave, toV.arrive, places, o),
      complete: noGps === 0
    };
  }

  function avg(list) {
    if (!list.length) return null;
    var s = 0; for (var i = 0; i < list.length; i++) s += list[i];
    return s / list.length;
  }

  // roundTrips(result, { pickup:{lat,lng,label}, dropoff:{lat,lng,label} }, options)
  //   result  = segment() output (uses .points and .stops)
  //   pickup  = null for a single-stop job: the most-visited clustered place
  //             that is not the drop-off stands in, but ONLY if the trail then
  //             really shuttles (>= 2 pickup -> drop-off runs). Otherwise null
  //             comes back and the caller shows the ordinary leg list alone.
  // -> { mode:'dispatch'|'inferred', pickup, dropoff, trips:[...], summary, notes } | null
  function roundTrips(result, stopsIn, options) {
    var o = opts(options);
    for (var k in TRIP_DEFAULTS) if (!(options && options[k] != null)) o[k] = TRIP_DEFAULTS[k];
    var pts = (result && result.points) || [];
    var drop = stopsIn && stopsIn.dropoff && num(stopsIn.dropoff.lat) != null && num(stopsIn.dropoff.lng) != null
      ? { key: 'D', lat: num(stopsIn.dropoff.lat), lng: num(stopsIn.dropoff.lng), label: stopsIn.dropoff.label || 'Drop-off' } : null;
    var pick = stopsIn && stopsIn.pickup && num(stopsIn.pickup.lat) != null && num(stopsIn.pickup.lng) != null
      ? { key: 'P', lat: num(stopsIn.pickup.lat), lng: num(stopsIn.pickup.lng), label: stopsIn.pickup.label || 'Pickup' } : null;
    if (!drop || pts.length < 2) return null;
    var mode = 'dispatch';
    if (!pick) {
      var best = null;
      var places = (result.stopPlaces || []);
      for (var i = 0; i < places.length; i++) {
        var c = places[i];
        if (haversine(c.lat, c.lng, drop.lat, drop.lng) <= o.exitM * 2) continue;
        if (c.visits >= 2 && (!best || c.visits > best.visits || (c.visits === best.visits && c.totalMs > best.totalMs))) best = c;
      }
      if (!best) return null;
      pick = { key: 'P', lat: best.lat, lng: best.lng, label: best.label };
      mode = 'inferred';
    }
    var placesArr = [pick, drop];
    var visits = findVisits(pts, placesArr, o);

    var trips = [];
    var cur = null;
    for (var v = 0; v < visits.length; v++) {
      var vis = visits[v], nxt = visits[v + 1];
      if (vis.key === 'P') {
        cur = { load: dwellPhase(vis, pts, o), loaded: null, dump: null, empty: null };
        trips.push(cur);
        if (nxt && nxt.key === 'D') cur.loaded = travelPhase(result, pts, vis, nxt, placesArr, o);
        else cur.inProgress = !nxt;          // loaded and on the road (or data ends)
      } else {
        if (!cur) {                           // shift starts at the drop-off: we never saw the load
          cur = { load: null, loaded: null, dump: null, empty: null, startedMidTrip: true };
          trips.push(cur);
        }
        cur.dump = dwellPhase(vis, pts, o);
        if (nxt && nxt.key === 'P') cur.empty = travelPhase(result, pts, vis, nxt, placesArr, o);
        else cur.inProgress = !nxt;
        cur = null;                           // the next pickup opens the next trip
      }
    }
    for (var n = 0; n < trips.length; n++) {
      var t = trips[n];
      t.n = n + 1;
      var parts = [t.load, t.loaded, t.dump, t.empty];
      t.complete = parts.every(function (p) { return p && p.complete; });
      t.totalMs = t.complete ? t.load.durationMs + t.loaded.durationMs + t.dump.durationMs + t.empty.durationMs : null;
      t.others = [].concat(t.loaded ? t.loaded.others : [], t.empty ? t.empty.others : []);
    }

    if (mode === 'inferred') {
      var runs = trips.filter(function (t) { return t.loaded; }).length;
      if (runs < 2) return null;              // not a shuttle: plain leg list only
    }

    function pick_(key) {
      return trips.map(function (t) { return t[key]; }).filter(function (p) { return p && p.complete; })
        .map(function (p) { return p.durationMs; });
    }
    var loadMs = pick_('load'), loadedMs = pick_('loaded'), dumpMs = pick_('dump'), emptyMs = pick_('empty');
    var cycles = trips.filter(function (t) { return t.complete; }).map(function (t) { return t.totalMs; });
    // null (shown as a dash) when nothing complete was seen, never a fake 0.
    var sum = function (l) { if (!l.length) return null; var s = 0; for (var i = 0; i < l.length; i++) s += l[i]; return s; };
    var summary = {
      loads: trips.filter(function (t) { return t.dump; }).length,   // deliveries seen at the drop-off
      trips: trips.length,
      completeTrips: cycles.length,
      avgLoadMs: avg(loadMs), avgLoadedMs: avg(loadedMs), avgDumpMs: avg(dumpMs), avgEmptyMs: avg(emptyMs),
      avgCycleMs: avg(cycles),
      totalLoadMs: sum(loadMs), totalLoadedMs: sum(loadedMs), totalDumpMs: sum(dumpMs), totalEmptyMs: sum(emptyMs),
      otherStopMs: sum(trips.reduce(function (a, t) { return a.concat(t.others.map(function (s) { return s.durationMs; })); }, []))
    };
    var notes = [];
    var sawP = visits.some(function (x) { return x.key === 'P'; });
    var sawD = visits.some(function (x) { return x.key === 'D'; });
    if (mode === 'dispatch' && !sawP && pts.length) notes.push('The truck never stopped within ' + o.enterM + ' m of the pickup pin. If it loaded somewhere else, the pickup pin is probably wrong.');
    if (!sawD && pts.length) notes.push('The truck never stopped within ' + o.enterM + ' m of the drop-off pin.');
    return { mode: mode, pickup: pick, dropoff: drop, trips: trips, summary: summary, notes: notes };
  }

  // Compact duration for table cells: "7m", "58m", "1h04".
  function fmtShort(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    var mins = Math.round(ms / 60000);
    if (mins < 60) return mins + 'm';
    var m = mins % 60;
    return Math.floor(mins / 60) + 'h' + (m < 10 ? '0' : '') + m;
  }

  // The round-trip table, shared by dispatcher.html and dashboard.html so the
  // driver and the office read identical numbers. Markup only; each page styles
  // the .trips / .trip-table classes for its own theme. esc = the page's HTML
  // escaper (every label here can come from a dispatcher-typed address).
  function tripTableHtml(rt, esc) {
    if (!rt || !rt.trips.length) {
      if (rt && rt.notes.length) return '<div class="trips"><div class="trips-note">' + rt.notes.map(esc).join(' ') + '</div></div>';
      return '';
    }
    var s = rt.summary;
    var used = {};
    function cell(p, kind, trip) {
      if (!p) {
        var live = trip.inProgress && ((kind === 'loaded' && trip.load && !trip.loaded) || (kind === 'empty' && trip.dump && !trip.empty));
        return live ? '<td class="now" title="Under way now, or the trail ends here">…</td>' : '<td class="na">—</td>';
      }
      if (p.complete) return '<td>' + fmtShort(p.durationMs) + '</td>';
      if (kind === 'loaded' || kind === 'empty') {
        used.nogps = true;
        return '<td class="inc" title="' + fmtDuration(p.noGpsMs) + ' of this leg has no GPS">no GPS</td>';
      }
      if (p.openStart || p.openEnd) used.open = true;
      if (p.noGpsMs) used.hole = true;
      var why = p.noGpsMs ? fmtDuration(p.noGpsMs) + ' without GPS inside this stay' : (p.openStart ? 'Trail starts here: arrival not seen' : 'Trail ends here: still there or left unseen');
      return '<td class="inc" title="' + why + '">' + (p.openStart || p.openEnd ? '≥' : '') + fmtShort(p.durationMs) + (p.noGpsMs ? '?' : '') + '</td>';
    }
    var rows = rt.trips.map(function (t) {
      var first = t.load || t.loaded || t.dump || t.empty;
      var html = '<tr' + (t.complete ? '' : ' class="partial"') + '><th scope="row">' + t.n +
        '<span class="at">' + (first ? fmtClock(first.startAt) : '') + '</span></th>' +
        cell(t.load, 'load', t) + cell(t.loaded, 'loaded', t) + cell(t.dump, 'dump', t) + cell(t.empty, 'empty', t) +
        '<td class="tot">' + (t.complete ? fmtShort(t.totalMs) : '—') + '</td></tr>';
      var notes = [];
      if (t.startedMidTrip) notes.push('Trail starts at the drop-off: this load was not seen.');
      t.others.forEach(function (o) {
        var leg = t.empty && o.startAt >= t.empty.startAt ? 'Empty' : 'Loaded';
        notes.push('<span class="' + (o.flagged ? 'flag' : '') + '">' + leg + ' leg includes ' + fmtDuration(o.durationMs) +
          ' stopped at ' + esc(o.label) + ' (' + fmtClock(o.startAt) + ')</span>');
      });
      [['load', t.load, 'pickup'], ['dump', t.dump, 'drop-off']].forEach(function (x) {
        if (x[1] && x[1].excursions && x[1].excursions.length) {
          x[1].excursions.forEach(function (e) {
            notes.push('<span class="flag">Left the ' + x[2] + ' for ' + fmtDuration(e.durationMs) + ' (' + fmtClock(e.startAt) + ') and came back</span>');
          });
        }
      });
      if (notes.length) html += '<tr class="trip-note"><td colspan="6">' + notes.join('<br>') + '</td></tr>';
      return html;
    }).join('');
    var foot = '<tr class="avg"><th scope="row">Avg</th><td>' + fmtShort(s.avgLoadMs) + '</td><td>' + fmtShort(s.avgLoadedMs) +
      '</td><td>' + fmtShort(s.avgDumpMs) + '</td><td>' + fmtShort(s.avgEmptyMs) + '</td><td class="tot">' + fmtShort(s.avgCycleMs) + '</td></tr>' +
      '<tr class="sum"><th scope="row">Total</th><td>' + fmtShort(s.totalLoadMs) + '</td><td>' + fmtShort(s.totalLoadedMs) +
      '</td><td>' + fmtShort(s.totalDumpMs) + '</td><td>' + fmtShort(s.totalEmptyMs) + '</td><td class="tot"></td></tr>';
    var head = '<div class="trips-head"><span class="t">Round trips</span><span class="route">' + esc(rt.pickup.label) + ' → ' + esc(rt.dropoff.label) + '</span></div>' +
      '<div class="trips-stats"><span><b>' + s.loads + '</b> load' + (s.loads === 1 ? '' : 's') + ' delivered</span>' +
      '<span>Avg cycle <b>' + fmtShort(s.avgCycleMs) + '</b></span>' +
      (s.otherStopMs ? '<span>Other stops <b>' + fmtShort(s.otherStopMs) + '</b></span>' : '') + '</div>';
    var notesOut = rt.notes.slice();
    if (rt.mode === 'inferred') notesOut.unshift('No pickup on this job, so the most-visited other stop (' + rt.pickup.label + ') is treated as the pickup.');
    var key = [];
    if (used.nogps) key.push('"no GPS" = part of that drive was not recorded');
    if (used.open) key.push('"≥" = the trail starts or ends during that stay, so it was at least that long');
    if (used.hole) key.push('"?" = the stay includes a stretch with no GPS');
    if (key.length) notesOut.push(key.join('; ') + '. Those cells are left out of the averages and totals.');
    return '<div class="trips">' + head +
      '<table class="trip-table"><thead><tr><th scope="col">Trip</th><th scope="col">Load</th><th scope="col">Loaded</th>' +
      '<th scope="col">Dump</th><th scope="col">Empty</th><th scope="col">Cycle</th></tr></thead><tbody>' + rows +
      '</tbody><tfoot>' + foot + '</tfoot></table>' +
      (notesOut.length ? '<div class="trips-note">' + notesOut.map(esc).join(' ') + '</div>' : '') + '</div>';
  }

  // How long has this truck been sitting, as of its newest ping? Mirrors the
  // Edge Function's radius-dwell test so the driver's own screen and the
  // server-side alert never disagree about "parked for 12 minutes".
  function currentDwell(rows, options) {
    var o = opts(options);
    var pts = normalize(rows, o);
    if (!pts.length) return { stationary: false, ms: 0, since: null, lat: null, lng: null };
    var anchor = pts[pts.length - 1];
    var since = anchor.t;
    for (var i = pts.length - 2; i >= 0; i--) {
      if (pts[i + 1].t - pts[i].t > o.maxGapMs) break;
      if (haversine(anchor.lat, anchor.lng, pts[i].lat, pts[i].lng) > (o.dwellRadiusM || 150)) break;
      since = pts[i].t;
    }
    var ms = anchor.t - since;
    return {
      stationary: ms >= o.idleAlertMs,
      ms: ms,
      since: since,
      lat: anchor.lat,
      lng: anchor.lng,
      truncated: since === pts[0].t
    };
  }

  // --- fetching -----------------------------------------------------------
  // PostgREST caps a Supabase response at 1000 rows and does NOT tell you it
  // truncated. A 10-hour shift at a 40m distance filter is several thousand
  // pings, so a plain .select() silently returns the first ~15 minutes and
  // every leg after that vanishes. Always page.
  function fetchPings(sb, userId, fromIso, toIso, maxPages) {
    var size = 1000;
    var cap = maxPages || 30;
    var all = [];
    var page = 0;
    function next() {
      return sb.from('location_updates')
        .select('lat, lng, accuracy, speed, created_at')
        .eq('user_id', userId)
        .gte('created_at', fromIso)
        .lte('created_at', toIso)
        .order('created_at', { ascending: true })
        .range(page * size, page * size + size - 1)
        .then(function (res) {
          if (res.error) throw res.error;
          var rows = res.data || [];
          all = all.concat(rows);
          page++;
          if (rows.length === size && page < cap) return next();
          return { rows: all, truncated: rows.length === size && page >= cap };
        });
    }
    return next();
  }

  // --- formatting ---------------------------------------------------------
  function fmtDuration(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    var mins = Math.round(ms / 60000);
    if (mins < 1) return '<1 min';
    if (mins < 60) return mins + ' min';
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    return m ? h + 'h ' + m + 'm' : h + 'h';
  }

  function fmtDistance(m) {
    if (m == null || !isFinite(m)) return '—';
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  }

  function fmtSpeed(kph) {
    if (kph == null || !isFinite(kph)) return '—';
    return Math.round(kph) + ' km/h';
  }

  function fmtClock(ms) {
    if (ms == null) return '—';
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return {
    DEFAULTS: DEFAULTS,
    segment: segment,
    roundTrips: roundTrips,
    tripTableHtml: tripTableHtml,
    fmtShort: fmtShort,
    currentDwell: currentDwell,
    fetchPings: fetchPings,
    haversine: haversine,
    fmtDuration: fmtDuration,
    fmtDistance: fmtDistance,
    fmtSpeed: fmtSpeed,
    fmtClock: fmtClock
  };
});
