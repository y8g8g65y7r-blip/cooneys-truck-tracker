/* Dispatch stops: pickup -> drop-off (migration 0011).
 *
 * ONE place that decides what stage a job is in, so the driver's card, the
 * dispatch board and the live map can never disagree. Classic script (exposes
 * window.DispatchStops) and require()-able for a node sanity test, same as
 * legs.js.
 *
 * site_address / lat / lng are ALWAYS the drop-off. pickup_address null means a
 * single-stop dispatch and everything here falls back to exactly the old
 * behaviour.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DispatchStops = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function has(v) { return v != null && String(v).trim() !== ''; }
  function hasCoords(lat, lng) { return lat != null && lng != null && lat !== '' && lng !== ''; }

  function hasPickup(d) { return !!d && has(d.pickup_address); }

  // "1400 84 St SE, Calgary, AB" -> "1400 84 St SE"
  function shortAddress(a) { return String(a || '').split(',')[0].trim(); }

  // What to call the pickup in tight spaces: the name the dispatcher typed
  // ("Burnco"), else the first line of its address.
  function pickupLabel(d) {
    if (!hasPickup(d)) return '';
    return has(d.pickup_name) ? String(d.pickup_name).trim() : (shortAddress(d.pickup_address) || 'Pickup');
  }

  // key: single | to_pickup | loaded | completed | cancelled
  function stage(d) {
    if (!d) return { key: 'single', label: '' };
    if (d.status === 'cancelled') return { key: 'cancelled', label: 'Cancelled' };
    if (d.status === 'completed') return { key: 'completed', label: 'Completed' };
    if (!hasPickup(d)) return { key: 'single', label: '' };
    if (!d.picked_up_at) return { key: 'to_pickup', label: 'To pickup' };
    return { key: 'loaded', label: 'Loaded → to drop-off' };
  }

  // A specific stop. kind: 'pickup' | 'dropoff'. lat/lng may be null
  // (dispatcher never pressed Find) — callers then fall back to the address.
  function stopOf(d, kind) {
    if (!d) return null;
    if (kind === 'pickup') {
      if (!hasPickup(d)) return null;
      var pc = hasCoords(d.pickup_lat, d.pickup_lng);
      return { kind: 'pickup', address: d.pickup_address, label: pickupLabel(d),
               lat: pc ? parseFloat(d.pickup_lat) : null, lng: pc ? parseFloat(d.pickup_lng) : null };
    }
    var dc = hasCoords(d.lat, d.lng);
    return { kind: 'dropoff', address: d.site_address, label: shortAddress(d.site_address) || 'Drop-off',
             lat: dc ? parseFloat(d.lat) : null, lng: dc ? parseFloat(d.lng) : null };
  }

  // The stop the truck is heading for right now, or null when the job is closed.
  function nextStop(d) {
    var s = stage(d).key;
    if (s === 'completed' || s === 'cancelled') return null;
    return stopOf(d, s === 'to_pickup' ? 'pickup' : 'dropoff');
  }

  // Google Maps directions link for one stop. Coordinates when the dispatcher
  // confirmed them with Find, else the address text (the existing behaviour).
  function directionsUrl(stop) {
    if (!stop) return null;
    var dest = (stop.lat != null && stop.lng != null)
      ? stop.lat + ',' + stop.lng
      : encodeURIComponent(stop.address || '');
    return 'https://www.google.com/maps/dir/?api=1&destination=' + dest;
  }

  // Named anchors for legs.js so the trip breakdown reads
  // "Burnco -> 1400 84 St SE" rather than "Stop A -> Stop B".
  function anchors(d, dropoffLabel) {
    var out = [];
    if (hasPickup(d) && hasCoords(d.pickup_lat, d.pickup_lng)) {
      out.push({ lat: d.pickup_lat, lng: d.pickup_lng, label: pickupLabel(d) });
    }
    if (d && hasCoords(d.lat, d.lng)) {
      out.push({ lat: d.lat, lng: d.lng, label: dropoffLabel || shortAddress(d.site_address) || 'Site' });
    }
    return out;
  }

  // "Burnco -> 1400 84 St SE" for one-line list rows; plain site otherwise.
  function routeText(d) {
    return hasPickup(d) ? pickupLabel(d) + ' → ' + (d.site_address || '') : (d ? d.site_address || '' : '');
  }

  function sourceText(src) {
    if (src === 'geofence') return 'auto, left pickup';
    if (src === 'tap') return 'driver tapped';
    if (src === 'dispatch') return 'set by dispatch';
    return '';
  }

  return {
    hasPickup: hasPickup, pickupLabel: pickupLabel, stage: stage, nextStop: nextStop, stopOf: stopOf,
    directionsUrl: directionsUrl, anchors: anchors, routeText: routeText,
    shortAddress: shortAddress, sourceText: sourceText
  };
});
