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
                        maxExcursionMs: 20 * 60 * 1000, maxExcursionM: 3000,
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
    // time away recorded so it is visible rather than silently absorbed. Only
    // for a SHORT, NEARBY excursion (turning around, the scale down the road):
    // two drop-off visits an hour apart with a trip to the pit in between are
    // two dumps, even when a wrong pickup pin means GPS never "saw" the pit.
    var merged = [];
    for (var j = 0; j < visits.length; j++) {
      var last = merged[merged.length - 1];
      var shortHop = false;
      if (last && last.key === visits[j].key && visits[j].arrive - last.leave <= o.maxExcursionMs) {
        shortHop = true;
        for (var q = last.lastIndex; q <= visits[j].firstIndex; q++) {
          if (haversine(pts[q].lat, pts[q].lng, last.place.lat, last.place.lng) > o.maxExcursionM) { shortHop = false; break; }
        }
      }
      if (shortHop) {
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

  function avg(list) {
    if (!list.length) return null;
    var s = 0; for (var i = 0; i < list.length; i++) s += list[i];
    return s / list.length;
  }

  // --- boundaries -----------------------------------------------------------
  // A trip is four moments: arrive pickup, LEAVE pickup (loaded), arrive
  // drop-off, LEAVE drop-off (dumped). GPS supplies all four when the pins are
  // right. A called-in "loaded"/"dumped" (dispatch_load_events, or the job's
  // own picked_up_at when it came from a driver tap or the office) is the
  // LEAVE moment and is authoritative: it replaces the matching GPS one, or
  // stands on its own when GPS never saw that place (wrong pin, dead phone).
  var ORDER = { Parr: 0, Pleave: 1, Darr: 2, Dleave: 3 };

  function gpsBoundaries(visits, pts) {
    var out = [];
    for (var i = 0; i < visits.length; i++) {
      var v = visits[i], P = v.key === 'P';
      out.push({ type: P ? 'Parr' : 'Darr', t: v.arrive, src: 'gps', open: v.firstIndex === 0 });
      out.push({ type: P ? 'Pleave' : 'Dleave', t: v.leave, src: 'gps', open: v.lastIndex === pts.length - 1,
                 excursions: v.excursions });
    }
    return out;
  }

  function mergeManual(bounds, manual, windowMs) {
    for (var i = 0; i < manual.length; i++) {
      var m = manual[i], best = null, bestDt = Infinity;
      for (var j = 0; j < bounds.length; j++) {
        var b = bounds[j];
        if (b.type !== m.type || b.src !== 'gps' || b.claimed) continue;
        var dt = Math.abs(b.t - m.t);
        if (dt <= windowMs && dt < bestDt) { best = b; bestDt = dt; }
      }
      if (best) {
        best.claimed = true; best.gpsT = best.t; best.t = m.t; best.src = m.src; best.open = false;
        best.eventId = m.eventId; best.note = m.note;
      } else {
        bounds.push({ type: m.type, t: m.t, src: m.src, open: false, eventId: m.eventId, note: m.note });
      }
    }
    return bounds;
  }

  function manualBoundaries(events, job) {
    var out = [];
    (events || []).forEach(function (e) {
      var t = new Date(e.event_at).getTime();
      if (!isFinite(t)) return;
      out.push({ type: e.kind === 'dumped' ? 'Dleave' : 'Pleave', t: t, src: 'phone', eventId: e.id, note: e.note || null });
    });
    // The job's own "Loaded" (driver tap or office button) is the first load.
    // A geofence stamp is GPS-derived already, so it adds nothing.
    if (job && job.picked_up_at && (job.pickup_source === 'tap' || job.pickup_source === 'dispatch')) {
      var pt = new Date(job.picked_up_at).getTime();
      var dup = out.some(function (b) { return b.type === 'Pleave' && Math.abs(b.t - pt) <= 15 * 60 * 1000; });
      if (isFinite(pt) && !dup) out.push({ type: 'Pleave', t: pt, src: job.pickup_source === 'tap' ? 'tap' : 'phone' });
    }
    return out.sort(function (a, b) { return a.t - b.t; });
  }

  function phaseOf(a, b, pts, result, places, o, travel) {
    if (!a || !b) return null;
    var noGps = holeBetween(pts, a.t, b.t, o);
    var exactEnds = a.src !== 'gps' && b.src !== 'gps';   // both called in: elapsed time is exact
    var p = {
      startAt: a.t, endAt: b.t, durationMs: Math.max(0, b.t - a.t), noGpsMs: noGps,
      openStart: !!a.open, openEnd: !!b.open, srcStart: a.src, srcEnd: b.src,
      complete: !a.open && !b.open && (noGps === 0 || exactEnds)
    };
    if (travel) p.others = otherStopsBetween(result, a.t, b.t, places, o);
    return p;
  }

  // roundTrips(result, stops, options)
  //   result  = segment() output (uses .points, .stops, .stopPlaces)
  //   stops   = { pickup:{lat,lng,label}|null, dropoff:{lat,lng,label}|null,
  //               events:[dispatch_load_events rows], job:<dispatch row> }
  //             lat/lng may be null; a place without coords is simply never
  //             seen by GPS, and called-in events still build the table.
  // -> { mode, pickup, dropoff, firstLoad, trips:[...], summary, notes } | null
  //   null = nothing to show (no drop-off pin, not a shuttle, nothing called in):
  //   the caller keeps the plain leg list, exactly as before.
  function roundTrips(result, stopsIn, options) {
    var o = opts(options);
    for (var k in TRIP_DEFAULTS) if (!(options && options[k] != null)) o[k] = TRIP_DEFAULTS[k];
    stopsIn = stopsIn || {};
    var pts = (result && result.points) || [];
    function place(src, key, fallback) {
      if (!src) return null;
      return { key: key, lat: num(src.lat), lng: num(src.lng), label: src.label || fallback };
    }
    var drop = place(stopsIn.dropoff, 'D', 'Drop-off') || { key: 'D', lat: null, lng: null, label: 'Drop-off' };
    var pick = place(stopsIn.pickup, 'P', 'Pickup');
    var manual = manualBoundaries(stopsIn.events, stopsIn.job);
    var hasManual = manual.length > 0;
    var mode = 'dispatch';

    var dropSeen = drop.lat != null && drop.lng != null;
    if ((!pick || pick.lat == null) && dropSeen && result && pts.length >= 2) {
      // Single-stop job (or a pickup with no pin): the most-visited other stop
      // stands in, but only if the trail really shuttles to it (checked below).
      var best = null, places0 = result.stopPlaces || [];
      for (var i = 0; i < places0.length; i++) {
        var c = places0[i];
        if (haversine(c.lat, c.lng, drop.lat, drop.lng) <= o.exitM * 2) continue;
        if (c.visits >= 2 && (!best || c.visits > best.visits || (c.visits === best.visits && c.totalMs > best.totalMs))) best = c;
      }
      if (best) { pick = { key: 'P', lat: best.lat, lng: best.lng, label: (pick && pick.label) || best.label }; mode = 'inferred'; }
    }
    if (!pick) pick = { key: 'P', lat: null, lng: null, label: 'Pickup' };
    // No pickup place and nothing called in: not a round-trip job (old behaviour).
    if (pick.lat == null && !hasManual) return null;

    var geo = [pick, drop].filter(function (p) { return p.lat != null && p.lng != null; });
    if (!geo.some(function (p) { return p.key === 'D'; }) && !hasManual) return null;
    var visits = geo.length && pts.length >= 2 ? findVisits(pts, geo, o) : [];
    var bounds = mergeManual(gpsBoundaries(visits, pts), manual, 45 * 60 * 1000);
    bounds.sort(function (a, b) { return a.t - b.t || ORDER[a.type] - ORDER[b.type]; });

    // Walk the moments in time order.
    var firstLoad = { a: null, b: null };
    var trips = [], cur = null, stage = 'start';
    function newTrip(depart, mid) {
      cur = { depart: depart, darr: null, dleave: null, parr: null, reload: null, next: null,
              startedMidTrip: !!mid, excursions: [] };
      trips.push(cur);
    }
    for (var n = 0; n < bounds.length; n++) {
      var b = bounds[n];
      if (b.excursions && b.excursions.length) {
        var ex = b.excursions.map(function (e) {
          return { startAt: e.startAt, endAt: e.endAt, durationMs: e.durationMs, at: b.type === 'Pleave' ? 'pickup' : 'drop-off' };
        });
        if (cur) cur.excursions = cur.excursions.concat(ex); else firstLoad.exc = (firstLoad.exc || []).concat(ex);
      }
      if (b.type === 'Parr') {
        if (!cur) { firstLoad.a = b; stage = 'atP0'; }
        else if (stage === 'empty' || stage === 'atD') { cur.parr = b; stage = 'atP'; }
      } else if (b.type === 'Pleave') {
        if (b.open) {                                   // trail ends at the pickup: still loading
          if (!cur) firstLoad.b = b; else if (stage === 'atP' || stage === 'empty') cur.reload = b;
          stage = 'loading';
          continue;
        }
        if (!cur) { if (firstLoad.a || stage === 'start') firstLoad.b = b; }
        else { cur.reload = b; cur.next = b; if (stage === 'loaded') cur.noDump = true; }
        newTrip(b, false);
        stage = 'loaded';
      } else if (b.type === 'Darr') {
        if (!cur) newTrip(null, true);
        if (stage === 'loaded' || stage === 'start' || cur.startedMidTrip && !cur.darr) { cur.darr = b; stage = 'atD'; }
      } else if (b.type === 'Dleave') {
        if (!cur) newTrip(null, true);
        if (cur.dleave && !b.open) { newTrip(null, true); }     // dumped twice with no load between
        cur.dleave = b;
        stage = b.open ? 'dumping' : 'empty';
      }
    }

    var places = geo;
    var out = trips.map(function (t, i) {
      var r = {
        n: i + 1, startedMidTrip: t.startedMidTrip, noDump: !!t.noDump,
        departAt: t.depart ? t.depart.t : null,
        loaded: phaseOf(t.depart, t.darr, pts, result, places, o, true),
        dump: phaseOf(t.darr, t.dleave, pts, result, places, o, false),
        empty: phaseOf(t.dleave, t.parr, pts, result, places, o, true),
        load: phaseOf(t.parr, t.reload, pts, result, places, o, false),
        loadedDump: (!t.darr && t.depart && t.dleave) ? phaseOf(t.depart, t.dleave, pts, result, places, o, true) : null,
        emptyLoad: (!t.parr && t.dleave && t.reload) ? phaseOf(t.dleave, t.reload, pts, result, places, o, true) : null,
        cycle: (t.depart && t.next) ? phaseOf(t.depart, t.next, pts, result, places, o, false) : null,
        inProgress: !t.next && i === trips.length - 1,
        excursions: t.excursions,
        called: [t.depart, t.dleave, t.reload].filter(function (x, k, arr) { return x && x.src !== 'gps' && arr.indexOf(x) === k; })
          .map(function (x) { return { kind: x.type === 'Dleave' ? 'dumped' : 'loaded', at: x.t, src: x.src, note: x.note || null }; })
      };
      r.others = [].concat(r.loaded ? r.loaded.others : [], r.empty ? r.empty.others : [],
                           r.loadedDump ? r.loadedDump.others : [], r.emptyLoad ? r.emptyLoad.others : []);
      r.complete = !!(r.cycle && r.cycle.complete);
      r.totalMs = r.cycle ? r.cycle.durationMs : null;
      return r;
    });
    var first = phaseOf(firstLoad.a, firstLoad.b, pts, result, places, o, false);
    if (first && firstLoad.exc) first.excursions = firstLoad.exc;

    if (mode === 'inferred' && !hasManual && out.filter(function (t) { return t.loaded; }).length < 2) return null;
    if (!out.length && !first && !hasManual && !geo.length) return null;

    function done(key) {
      return out.map(function (t) { return t[key]; }).filter(function (p) { return p && p.complete; })
        .map(function (p) { return p.durationMs; });
    }
    var loadMs = done('load').concat(first && first.complete ? [first.durationMs] : []);
    var loadedMs = done('loaded'), dumpMs = done('dump'), emptyMs = done('empty');
    var cycles = out.filter(function (t) { return t.complete; }).map(function (t) { return t.totalMs; });
    // null (shown as a dash) when nothing complete was seen, never a fake 0.
    var sum = function (l) { if (!l.length) return null; var s = 0; for (var i = 0; i < l.length; i++) s += l[i]; return s; };
    var summary = {
      // Deliveries: any trip where the truck reached or left the drop-off,
      // whether GPS saw it or it was called in.
      loads: trips.filter(function (t) { return t.darr || t.dleave; }).length,
      calledIn: (stopsIn.events || []).length,
      trips: out.length,
      completeTrips: cycles.length,
      avgLoadMs: avg(loadMs), avgLoadedMs: avg(loadedMs), avgDumpMs: avg(dumpMs), avgEmptyMs: avg(emptyMs),
      avgCycleMs: avg(cycles),
      totalLoadMs: sum(loadMs), totalLoadedMs: sum(loadedMs), totalDumpMs: sum(dumpMs), totalEmptyMs: sum(emptyMs),
      otherStopMs: sum(out.reduce(function (a, t) { return a.concat(t.others.map(function (s) { return s.durationMs; })); }, []))
    };

    var notes = [];
    var sawP = visits.some(function (x) { return x.key === 'P'; });
    var sawD = visits.some(function (x) { return x.key === 'D'; });
    if (mode === 'dispatch' && pick.lat != null && !sawP && pts.length) notes.push('The truck never stopped within ' + o.enterM + ' m of the pickup pin, so pickup times come only from called-in loads. If it loaded somewhere else, the pickup pin is probably wrong.');
    if (drop.lat != null && !sawD && pts.length) notes.push('The truck never stopped within ' + o.enterM + ' m of the drop-off pin.');
    return { mode: mode, pickup: pick, dropoff: drop, firstLoad: first, trips: out, summary: summary, notes: notes };
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
  //
  // Columns follow the truck: Loaded (leave pickup -> drop-off), Dump, Empty
  // (-> next pickup), Load (the reload), Cycle = leave pickup to leave pickup
  // again, i.e. "loaded to loaded again", which is exactly what a phoned-in
  // "loaded again" gives dispatch even with no GPS at all.
  function tripTableHtml(rt, esc) {
    if (!rt || (!rt.trips.length && !rt.firstLoad)) {
      if (rt && rt.notes.length) return '<div class="trips"><div class="trips-note">' + rt.notes.map(esc).join(' ') + '</div></div>';
      return '';
    }
    var s = rt.summary;
    var used = {};
    function val(p, travel) {
      if (p.complete) return fmtShort(p.durationMs);
      if (travel && p.noGpsMs && !p.openStart && !p.openEnd) { used.nogps = true; return null; }
      if (p.openStart || p.openEnd) used.open = true;
      if (p.noGpsMs) used.hole = true;
      return (p.openStart || p.openEnd ? '≥' : '') + fmtShort(p.durationMs) + (p.noGpsMs ? '?' : '');
    }
    function cell(p, travel, live, span, what) {
      var cs = span ? ' colspan="2"' : '';
      if (!p) return live ? '<td class="now"' + cs + '>…</td>' : '<td class="na"' + cs + '>—</td>';
      var v = val(p, travel);
      var sub = span ? '<span class="sub">' + what + '</span>' : '';
      if (v === null) return '<td class="inc"' + cs + '>no GPS' + sub + '</td>';
      return '<td' + (p.complete ? '' : ' class="inc"') + cs + '>' + v + sub + '</td>';
    }
    var rows = rt.trips.map(function (t) {
      var liveLoaded = t.inProgress && t.departAt != null && !t.dump && !t.loaded && !t.loadedDump;
      var liveEmpty = t.inProgress && (t.dump || t.loadedDump) && !t.empty && !t.emptyLoad;
      var mid = t.loadedDump
        ? cell(t.loadedDump, true, false, true, 'loaded + dump')
        : cell(t.loaded, true, liveLoaded) + cell(t.dump, false, false);
      var tail = t.emptyLoad
        ? cell(t.emptyLoad, true, false, true, 'empty + load')
        : cell(t.empty, true, liveEmpty) + cell(t.load, false, t.inProgress && !!t.empty && !t.load);
      var cyc = t.cycle && t.cycle.complete ? fmtShort(t.totalMs) : '—';
      var html = '<tr' + (t.complete ? '' : ' class="partial"') + '><th scope="row">' + t.n +
        '<span class="at">' + (t.departAt != null ? fmtClock(t.departAt) : 'mid-trip') + '</span></th>' +
        mid + tail + '<td class="tot">' + cyc + '</td></tr>';
      var notes = [];
      if (t.called.length) {
        notes.push('<span class="call">Called in: ' + t.called.map(function (c) {
          return c.kind + ' ' + fmtClock(c.at) + (c.src === 'tap' ? ' (driver tap)' : '') + (c.note ? ' · ' + esc(c.note) : '');
        }).join(', ') + '</span>');
      }
      if (t.startedMidTrip) notes.push('Trail starts after this load left the pickup.');
      if (t.noDump) notes.push('<span class="flag">Loaded again with no dump seen in between</span>');
      t.others.forEach(function (o) {
        var leg = (t.empty || t.emptyLoad) && o.startAt >= (t.empty || t.emptyLoad).startAt ? 'Empty' : 'Loaded';
        notes.push('<span class="' + (o.flagged ? 'flag' : '') + '">' + leg + ' leg includes ' + fmtDuration(o.durationMs) +
          ' stopped at ' + esc(o.label) + ' (' + fmtClock(o.startAt) + ')</span>');
      });
      (t.excursions || []).forEach(function (e) {
        notes.push('<span class="flag">Left the ' + e.at + ' for ' + fmtDuration(e.durationMs) + ' (' + fmtClock(e.startAt) + ') and came back</span>');
      });
      if (notes.length) html += '<tr class="trip-note"><td colspan="6">' + notes.join('<br>') + '</td></tr>';
      return html;
    }).join('');
    var foot = '<tr class="avg"><th scope="row">Avg</th><td>' + fmtShort(s.avgLoadedMs) + '</td><td>' + fmtShort(s.avgDumpMs) +
      '</td><td>' + fmtShort(s.avgEmptyMs) + '</td><td>' + fmtShort(s.avgLoadMs) + '</td><td class="tot">' + fmtShort(s.avgCycleMs) + '</td></tr>' +
      '<tr class="sum"><th scope="row">Total</th><td>' + fmtShort(s.totalLoadedMs) + '</td><td>' + fmtShort(s.totalDumpMs) +
      '</td><td>' + fmtShort(s.totalEmptyMs) + '</td><td>' + fmtShort(s.totalLoadMs) + '</td><td class="tot"></td></tr>';
    var fl = rt.firstLoad;
    var head = '<div class="trips-head"><span class="t">Round trips</span><span class="route">' + esc(rt.pickup.label) + ' → ' + esc(rt.dropoff.label) + '</span></div>' +
      '<div class="trips-stats"><span><b>' + s.loads + '</b> load' + (s.loads === 1 ? '' : 's') + ' delivered</span>' +
      (s.calledIn ? '<span><b>' + s.calledIn + '</b> called in</span>' : '') +
      '<span>Avg cycle <b>' + fmtShort(s.avgCycleMs) + '</b></span>' +
      (fl ? '<span>First load <b>' + (val(fl, false) || '—') + '</b></span>' : '') +
      (s.otherStopMs ? '<span>Other stops <b>' + fmtShort(s.otherStopMs) + '</b></span>' : '') + '</div>';
    var notesOut = rt.notes.slice();
    if (rt.mode === 'inferred') notesOut.unshift('No pickup pin on this job, so the most-visited other stop (' + rt.pickup.label + ') is treated as the pickup.');
    var key = [];
    if (used.nogps) key.push('"no GPS" = part of that drive was not recorded');
    if (used.open) key.push('"≥" = the trail starts or ends during that stay, so it was at least that long');
    if (used.hole) key.push('"?" = the stay includes a stretch with no GPS');
    if (key.length) notesOut.push(key.join('; ') + '. Those cells are left out of the averages and totals.');
    notesOut.push('Cycle = left the pickup loaded to left it loaded again. Called-in times replace GPS; everything else is GPS.');
    return '<div class="trips">' + head +
      '<table class="trip-table"><thead><tr><th scope="col">Trip</th><th scope="col">Loaded</th><th scope="col">Dump</th>' +
      '<th scope="col">Empty</th><th scope="col">Load</th><th scope="col">Cycle</th></tr></thead><tbody>' + rows +
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
