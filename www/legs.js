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
      var named = null;
      for (var a = 0; a < (anchors || []).length; a++) {
        var an = anchors[a];
        if (an.lat == null || an.lng == null) continue;
        if (haversine(parseFloat(an.lat), parseFloat(an.lng), clusters[d].lat, clusters[d].lng) <= o.anchorMatchM) {
          named = an.label; break;
        }
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
    currentDwell: currentDwell,
    fetchPings: fetchPings,
    haversine: haversine,
    fmtDuration: fmtDuration,
    fmtDistance: fmtDistance,
    fmtSpeed: fmtSpeed,
    fmtClock: fmtClock
  };
});
