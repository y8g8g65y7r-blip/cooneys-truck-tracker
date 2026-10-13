/* Driver job screen logic (migration 0013), kept free of the DOM so it can be
 * tested in node. Classic script (window.JobKit) and require()-able, same as
 * legs.js / stops.js.
 *
 *   navTargets()    Open-in-Maps links: the DESTINATION ONLY, never a route or
 *                   waypoints. The driver's own app decides the route.
 *   resolveNotice() the route-responsibility notice: server copy (app_settings)
 *                   over the bundled fallback in config.js.
 *   threadItems()   one timeline per job: messages, notes, Loaded/Unloaded taps
 *                   and job milestones, oldest first.
 *   loadSummary()   load count and which button to emphasise next.
 *   Outbox          a persisted send queue. A tap or a message made in a dead
 *                   zone is kept on the phone and retried; it is never dropped
 *                   silently and never blocks the driver.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JobKit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // ids. crypto.randomUUID is iOS 15.4+; getRandomValues is everywhere we run.
  function uuid4() {
    var b = new Uint8Array(16), c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
    if (c) c.getRandomValues(b); else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = []; for (var j = 0; j < 16; j++) h.push((b[j] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' + h.slice(10).join('');
  }

  // ---------------------------------------------------------------------------
  // Open in Maps. `stop` = { lat, lng, address, label } (DispatchStops.stopOf).
  // startDirections=false (default) drops a pin at the destination and leaves
  // the driver to tap Directions/Go in their own app; true opens straight into
  // that app's directions screen. Either way only the destination is passed:
  // no saddr, no waypoints, nothing the company computed.
  var APPS = [
    { app: 'apple', label: 'Apple Maps', scheme: 'maps' },
    { app: 'google', label: 'Google Maps', scheme: 'comgooglemaps' },
    { app: 'waze', label: 'Waze', scheme: 'waze' }
  ];

  function fmtLL(stop) {
    if (!stop || stop.lat == null || stop.lng == null || stop.lat === '' || stop.lng === '') return null;
    var lat = Number(stop.lat), lng = Number(stop.lng);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return lat.toFixed(6) + ',' + lng.toFixed(6);
  }

  function navTargets(stop, opts) {
    if (!stop) return [];
    var start = !!(opts && opts.startDirections);
    var ll = fmtLL(stop);
    var text = String(stop.address || stop.label || '').trim();
    if (!ll && !text) return [];
    var q = encodeURIComponent(text);
    var name = encodeURIComponent(String(stop.label || stop.address || 'Destination').trim());
    var dest = ll || q;
    return APPS.map(function (a) {
      var url, web;
      if (a.app === 'apple') {
        var p = start ? 'daddr=' + dest + '&dirflg=d' : (ll ? 'll=' + ll + '&q=' + name : 'q=' + q);
        url = 'maps://?' + p; web = 'https://maps.apple.com/?' + p;
      } else if (a.app === 'google') {
        url = start ? 'comgooglemaps://?daddr=' + dest + '&directionsmode=driving'
                    : 'comgooglemaps://?q=' + dest + (ll ? '&center=' + ll : '');
        web = start ? 'https://www.google.com/maps/dir/?api=1&destination=' + dest
                    : 'https://www.google.com/maps/search/?api=1&query=' + dest;
      } else {
        var w = (ll ? 'll=' + ll : 'q=' + q) + (start ? '&navigate=yes' : '');
        url = 'waze://?' + w; web = 'https://waze.com/ul?' + w;
      }
      return { app: a.app, label: a.label, scheme: a.scheme, url: url, webUrl: web, dest: ll || text };
    });
  }

  // Android / desktop browser: one geo: link hands the place to whatever map
  // app the phone has (Android shows its own chooser).
  function geoUri(stop) {
    var ll = fmtLL(stop);
    var label = String((stop && (stop.label || stop.address)) || 'Destination').replace(/[()]/g, '');
    if (ll) return 'geo:' + ll + '?q=' + ll + '(' + encodeURIComponent(label) + ')';
    var text = String((stop && stop.address) || '').trim();
    return text ? 'geo:0,0?q=' + encodeURIComponent(text) : null;
  }

  // ---------------------------------------------------------------------------
  // Notice. The server copy wins when it is well-formed; anything malformed
  // falls back to the bundled copy rather than showing a blank notice.
  function validNotice(n) {
    return !!n && typeof n === 'object' && typeof n.text === 'string' && n.text.trim().length > 0
      && typeof n.version === 'string' && n.version.trim().length > 0
      && (!n.ack_required || (typeof n.ack_text === 'string' && n.ack_text.trim().length > 0));
  }
  function resolveNotice(remote, bundled) {
    var src = validNotice(remote) ? remote : bundled;
    if (!validNotice(src)) return null;
    return {
      version: src.version.trim(),
      text: src.text.trim(),
      ack_required: !!src.ack_required,
      ack_text: src.ack_required ? src.ack_text.trim() : null,
      start_directions: !!src.start_directions,
      source: src === remote ? 'server' : 'bundled'
    };
  }
  // The driver ticks once per notice version per app build: a new wording or a
  // new app version asks again (SADIE: "first use, or once per app version").
  function ackKey(userId, noticeVersion, appBuild) {
    return 'tt_navack|' + userId + '|' + noticeVersion + '|' + (appBuild || 'web');
  }

  // ---------------------------------------------------------------------------
  // Thread. Everything the driver and dispatch need to see about one job, in
  // order. `pending` are outbox items not yet confirmed by the server.
  function ts(x) { var t = new Date(x).getTime(); return isFinite(t) ? t : null; }

  function threadItems(o) {
    var job = o.job || {}, myId = o.myId, out = [];
    (o.messages || []).forEach(function (m) {
      out.push({ type: m.kind === 'note' ? 'note' : 'message', id: m.id, at: ts(m.created_at), body: m.body,
                 mine: m.sender_id === myId, senderId: m.sender_id, state: 'sent' });
    });
    var loadedAts = [];
    (o.events || []).forEach(function (e) {
      out.push({ type: 'event', id: e.id, at: ts(e.event_at), kind: e.kind, source: e.source, note: e.note || null,
                 mine: e.source === 'driver' && e.driver_id === myId, state: 'sent' });
      if (e.kind === 'loaded') loadedAts.push(ts(e.event_at));
    });
    (o.pending || []).forEach(function (p) {
      if (out.some(function (x) { return x.id === p.id; })) return;   // server copy already here
      if (p.type === 'load_event') {
        out.push({ type: 'event', id: p.id, at: ts(p.payload.event_at), kind: p.payload.kind, source: 'driver',
                   mine: true, state: p.state === 'failed' ? 'failed' : 'pending', error: p.lastError || null,
                   undoUntil: p.notBefore || null });
        if (p.payload.kind === 'loaded') loadedAts.push(ts(p.payload.event_at));
      } else if (p.type === 'message') {
        out.push({ type: p.payload.kind === 'note' ? 'note' : 'message', id: p.id, at: ts(p.created_at), body: p.payload.body,
                   mine: true, state: p.state === 'failed' ? 'failed' : 'pending', error: p.lastError || null });
      }
    });
    if (job.created_at) out.push({ type: 'system', id: 'sys-sent', at: ts(job.created_at), what: 'sent' });
    if (job.accepted_at) out.push({ type: 'system', id: 'sys-accepted', at: ts(job.accepted_at), what: 'accepted' });
    // The stage flag only adds information when no Loaded tap explains it
    // (geofence auto-advance, the office's button, or an older app build).
    if (job.picked_up_at) {
      var pt = ts(job.picked_up_at);
      var explained = loadedAts.some(function (t) { return t != null && Math.abs(t - pt) <= 2 * 60 * 1000; });
      if (!explained) out.push({ type: 'system', id: 'sys-picked', at: pt, what: 'picked_up', source: job.pickup_source || null });
    }
    if (job.completed_at && job.status === 'completed') out.push({ type: 'system', id: 'sys-done', at: ts(job.completed_at), what: 'completed' });
    if (job.status === 'cancelled') out.push({ type: 'system', id: 'sys-cxl', at: ts(job.completed_at || job.created_at) + 1, what: 'cancelled' });
    var order = { system: 0, event: 1, note: 2, message: 3 };
    return out.filter(function (x) { return x.at != null; }).sort(function (a, b) {
      return a.at - b.at || order[a.type] - order[b.type];
    });
  }

  // How many loads, what happened last, and which big button to emphasise.
  // A failed (not sent) tap does not count.
  function loadSummary(items, job) {
    var ev = (items || []).filter(function (x) { return x.type === 'event' && x.state !== 'failed'; });
    var loads = ev.filter(function (x) { return x.kind === 'loaded'; }).length;
    var unloads = ev.filter(function (x) { return x.kind === 'dumped'; }).length;
    var last = ev.length ? ev[ev.length - 1] : null;
    // An older-build tap or the geofence may have loaded the job with no event.
    if (!loads && job && job.picked_up_at) {
      loads = 1;
      var pt = ts(job.picked_up_at);
      if (!last || pt > last.at) last = { kind: 'loaded', at: pt };
    }
    return { loads: loads, unloads: unloads, last: last, next: last && last.kind === 'loaded' ? 'dumped' : 'loaded' };
  }

  // ---------------------------------------------------------------------------
  // Equipment (0017): what the driver is driving, from the job's own snapshot.
  // Mirrors equipmentLine() in supabase/functions/send-dispatch-push; keep the
  // two in step. Old-build jobs have no equipment: set=false.
  function equipmentInfo(job) {
    var d = job || {};
    if (!d.equipment_name) {
      return { set: false, headline: 'EQUIPMENT NOT SET', type: null,
               unit: d.unit_number ? 'Unit ' + d.unit_number : 'Unit not set', trailer: null, action: null,
               line: 'Equipment not set — ask dispatch what you are taking' };
    }
    var head = String(d.equipment_label || d.equipment_name);
    var unit = d.unit_number ? 'Unit ' + d.unit_number : 'Unit not set';
    if (d.needs_trailer) {
      var box = d.trailer_kind === 'demo_rock_box';
      var trailer = d.trailer_number ? String(d.trailer_number) : (box ? 'box # not set' : 'trailer # not set');
      var action = box ? 'HOOK UP BOX' : 'HOOK UP TRAILER';
      return { set: true, headline: head, type: d.equipment_name, unit: unit, trailer: trailer, action: action,
               line: head + ' — ' + unit + ' + ' + trailer + ' — ' + action };
    }
    return { set: true, headline: head, type: d.equipment_name, unit: unit, trailer: null, action: 'NO TRAILER',
             line: head + ' — ' + unit + ' — no trailer' };
  }
  // Signature of what the driver must take: a change means "tell them".
  function equipmentSig(job) {
    var d = job || {};
    return [d.equipment_type_id || '', d.unit_id || d.unit_number || '', d.trailer_unit_id || d.trailer_number || ''].join('|');
  }

  // ---------------------------------------------------------------------------
  // Outbox. Items: { id, type, dispatch_id, payload, created_at, notBefore,
  // tries, nextAt, state: 'pending' | 'sending' | 'failed', lastError }.
  // `send(item)` resolves { error } from supabase-js; the id is the row's
  // primary key, so a retry after a lost response is a harmless duplicate.
  function classifyError(err) {
    if (!err) return 'ok';
    var code = String(err.code || '');
    if (code === '23505') return 'ok';                       // already delivered
    if (/^(22|23|42|P0)/.test(code)) return 'permanent';     // rejected by the database: retrying will not help
    return 'retry';                                          // network, timeout, expired session, 5xx
  }

  function backoffMs(tries) { return Math.min(60000, 2000 * Math.pow(2, Math.max(0, tries - 1))); }

  function Outbox(opts) {
    this.storage = opts.storage || null;
    this.key = opts.key;
    this.send = opts.send;
    this.now = opts.now || function () { return Date.now(); };
    this.onChange = opts.onChange || function () {};
    this.onDelivered = opts.onDelivered || function () {};
    this.list = [];
    this._flushing = null;
    try {
      var raw = this.storage && this.storage.getItem(this.key);
      var arr = raw ? JSON.parse(raw) : [];
      // An app killed mid-send left 'sending' rows: send them again (idempotent).
      this.list = Array.isArray(arr) ? arr.map(function (x) { if (x.state === 'sending') x.state = 'pending'; return x; }) : [];
    } catch (e) { this.list = []; }
  }
  Outbox.prototype._save = function () {
    try { if (this.storage) this.storage.setItem(this.key, JSON.stringify(this.list)); } catch (e) {}
    try { this.onChange(this.list.slice()); } catch (e) {}
  };
  Outbox.prototype.items = function () { return this.list.slice(); };
  Outbox.prototype.pendingFor = function (dispatchId) {
    return this.list.filter(function (x) { return x.dispatch_id === dispatchId; });
  };
  Outbox.prototype.count = function () { return this.list.length; };
  Outbox.prototype.enqueue = function (item) {
    var now = this.now();
    var it = {
      id: item.id || uuid4(), type: item.type, dispatch_id: item.dispatch_id || null, payload: item.payload || {},
      created_at: new Date(now).toISOString(), notBefore: item.delayMs ? now + item.delayMs : 0,
      tries: 0, nextAt: 0, state: 'pending', lastError: null
    };
    this.list.push(it);
    this._save();
    return it;
  };
  // Undo before it was sent. Refused once a send is under way or done.
  Outbox.prototype.cancel = function (id) {
    var i = this.list.findIndex(function (x) { return x.id === id; });
    if (i < 0 || this.list[i].state === 'sending') return false;
    this.list.splice(i, 1);
    this._save();
    return true;
  };
  Outbox.prototype.retry = function (id) {
    var it = this.list.find(function (x) { return x.id === id; });
    if (!it) return false;
    it.state = 'pending'; it.nextAt = 0; it.lastError = null;
    this._save();
    return true;
  };
  // Give up on a failed item (the driver chose Discard).
  Outbox.prototype.discard = function (id) {
    var i = this.list.findIndex(function (x) { return x.id === id && x.state === 'failed'; });
    if (i < 0) return false;
    this.list.splice(i, 1);
    this._save();
    return true;
  };
  // In order. Stops at the first network failure: the rest would fail the same
  // way, and order matters (Loaded before Unloaded). A database rejection only
  // fails that item; the rest carry on. force=true ignores the retry backoff
  // (signal just came back, the app resumed, or the driver tapped Retry): a
  // driver back in coverage should never wait out a 60 s timer.
  Outbox.prototype.flush = function (opts) {
    var self = this, force = !!(opts && opts.force);
    if (self._flushing) {
      if (force) self._forceAgain = true;
      return self._flushing;
    }
    // The guard is released when the run settles, NOT in a finally inside it:
    // a run with nothing due finishes without ever awaiting, so a finally would
    // clear the guard BEFORE this assignment set it, and wedge the outbox.
    var run = (async function () {
      var delivered = 0;
      {
        for (var k = 0; k < self.list.length; k++) {
          var it = self.list[k], now = self.now();
          if (it.state === 'failed') continue;
          if (it.notBefore && now < it.notBefore) continue;
          if (!force && it.nextAt && now < it.nextAt) break;
          it.state = 'sending'; self._save();
          var res;
          try { res = await self.send(it); } catch (e) { res = { error: { message: String(e && e.message || e) } }; }
          var verdict = classifyError(res && res.error);
          if (verdict === 'ok') {
            var idx = self.list.indexOf(it);
            if (idx >= 0) self.list.splice(idx, 1);
            k = idx - 1;
            delivered++;
            self._save();
            try { self.onDelivered(it, res); } catch (e) {}
          } else if (verdict === 'permanent') {
            it.state = 'failed'; it.lastError = (res.error && res.error.message) || 'Rejected';
            self._save();
          } else {
            it.state = 'pending'; it.tries += 1; it.nextAt = self.now() + backoffMs(it.tries);
            it.lastError = (res && res.error && res.error.message) || 'No connection';
            self._save();
            break;
          }
        }
      }
      return delivered;
    })();
    self._flushing = run;
    var release = function () {
      if (self._flushing === run) self._flushing = null;
      // A forced flush asked for while this run was under way gets its own run.
      if (self._forceAgain) { self._forceAgain = false; self.flush({ force: true }); }
    };
    run.then(release, release);
    return run;
  };
  // Earliest moment something becomes sendable (for a timer).
  Outbox.prototype.nextDueAt = function () {
    var t = Infinity;
    this.list.forEach(function (x) {
      if (x.state === 'failed') return;
      t = Math.min(t, Math.max(x.notBefore || 0, x.nextAt || 0));
    });
    return t;
  };

  return {
    uuid4: uuid4, navTargets: navTargets, geoUri: geoUri, resolveNotice: resolveNotice, ackKey: ackKey,
    threadItems: threadItems, loadSummary: loadSummary, classifyError: classifyError, backoffMs: backoffMs,
    equipmentInfo: equipmentInfo, equipmentSig: equipmentSig,
    Outbox: Outbox, APPS: APPS
  };
});
