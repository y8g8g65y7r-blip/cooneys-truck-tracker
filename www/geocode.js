/* Address lookup for the dispatcher's Find buttons (site + pickup).
 *
 * Why this exists (2026-09-29): "166 Pinebrook Way SW" returned nothing from
 * Nominatim, and a loose free-text match can land on a different street
 * entirely (Matt was offered Aspen Landing). A dispatch pin is where a loaded
 * truck gets sent, so a wrong pin is worse than no pin.
 *
 * Order:
 *   1. Nominatim (OSM), exactly as before, but restricted to Canada and biased
 *      to the Calgary region. Auto-accepted ONLY when the result's house number
 *      and street agree with what was typed.
 *   2. Authoritative government address points, queried in parallel:
 *        - City of Calgary "Parcel Address" (data.calgary.ca, Socrata 9zvu-p8uz)
 *        - Rocky View County municipal addresses (atlasmap.rockyview.ca)
 *      Rocky View matters: plenty of "Calgary, AB" postal addresses (Springbank,
 *      Bearspaw, Balzac, most pits off range roads) are NOT inside city limits,
 *      so the City's data will never have them. 166 Pinebrook Way SW is one.
 *   3. Nothing confirmed -> suggestions only (street-level or different-street
 *      matches, clearly labelled). The UI never auto-picks those; the dispatcher
 *      picks one or drops a pin on the map.
 *
 * Deliberately NOT used: the Esri World Geocoder. Its terms forbid storing
 * results unless the request carries forStorage=true AND a paid token, and a
 * dispatch stores lat/lng. See the project memory, Part 12.
 *
 * Classic script (window.AddressLookup) and require()-able for node tests,
 * same pattern as legs.js / stops.js.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AddressLookup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  var CALGARY = 'https://data.calgary.ca/resource/9zvu-p8uz.json';
  var ROCKYVIEW = 'https://atlasmap.rockyview.ca/arcgis/rest/services/Land/MunicipalAddresses/MapServer/0/query';
  // Calgary region: Cochrane to Strathmore, Airdrie to Okotoks. A bias, not a fence.
  var VIEWBOX = '-115.30,51.75,-113.00,50.40';
  var TIMEOUT_MS = 8000;
  var SAME_PLACE_M = 75;

  // Canonical street type -> every spelling we accept (OSM long form, Canada
  // Post short form, City of Calgary two-letter code, Rocky View short form).
  var TYPE_ALIASES = {
    alley: ['ALLEY', 'AL'], avenue: ['AVENUE', 'AVE', 'AV'], bay: ['BAY', 'BA'],
    bend: ['BEND'], boulevard: ['BOULEVARD', 'BLVD', 'BV'], cape: ['CAPE', 'CA'],
    centre: ['CENTRE', 'CTR', 'CE'], circle: ['CIRCLE', 'CIR', 'CI'], close: ['CLOSE', 'CL'],
    common: ['COMMON', 'COMMONS', 'CM'], court: ['COURT', 'CRT', 'CT', 'CO'],
    cove: ['COVE', 'CV'], crescent: ['CRESCENT', 'CRES', 'CR'], drive: ['DRIVE', 'DR'],
    estates: ['ESTATES'], gardens: ['GARDENS', 'GDNS', 'GD'], gate: ['GATE', 'GA'],
    glen: ['GLEN'], green: ['GREEN', 'GRN', 'GR'], grove: ['GROVE', 'GV'],
    heath: ['HEATH', 'HE'], heights: ['HEIGHTS', 'HTS', 'HT'], hill: ['HILL', 'HL'],
    hollow: ['HOLLOW'], island: ['ISLAND', 'IS'], landing: ['LANDING', 'LD'],
    lane: ['LANE', 'LN'], link: ['LINK', 'LI'], manor: ['MANOR', 'MR'],
    meadows: ['MEADOWS'], mews: ['MEWS', 'ME'], mount: ['MOUNT', 'MT'],
    parade: ['PARADE', 'PR'], park: ['PARK', 'PK', 'PA'], parkway: ['PARKWAY', 'PKY', 'PY'],
    passage: ['PASSAGE', 'PS'], path: ['PATH', 'PH'], place: ['PLACE', 'PL'],
    plaza: ['PLAZA', 'PZ'], point: ['POINT', 'PT'], ridge: ['RIDGE'], rise: ['RISE', 'RI'],
    road: ['ROAD', 'RD'], row: ['ROW', 'RO'], square: ['SQUARE', 'SQ'],
    street: ['STREET', 'ST'], terrace: ['TERRACE', 'TERR', 'TC'], trail: ['TRAIL', 'TRL', 'TR'],
    view: ['VIEW', 'VW'], villas: ['VILLAS', 'VI'], walk: ['WALK', 'WK'], way: ['WAY', 'WY']
  };
  var TYPE_OF = {};
  Object.keys(TYPE_ALIASES).forEach(function (canon) {
    TYPE_ALIASES[canon].forEach(function (a) { TYPE_OF[a] = canon; });
  });
  var QUADS = { NE: 1, NW: 1, SE: 1, SW: 1 };
  // Trailing words that are place, not street, when the address has no commas.
  var TAIL_WORDS = ['CANADA', 'AB', 'ALBERTA', 'CALGARY', 'AIRDRIE', 'CHESTERMERE', 'COCHRANE',
    'OKOTOKS', 'STRATHMORE', 'LANGDON', 'BALZAC', 'SPRINGBANK', 'BEARSPAW', 'CROSSFIELD',
    'IRRICANA', 'CARSTAIRS', 'COUNTY', 'ROCKY', 'VIEW', 'FOOTHILLS', 'HIGH', 'RIVER', 'DE', 'WINTON'];

  // Upper-case, strip punctuation, unify rural road names so "Range Road 33",
  // "Rge Rd 33" and "RR 33" all compare equal (Rocky View stores "RGE RD 33").
  function clean(s) {
    return String(s || '').toUpperCase()
      .replace(/[.'`’]/g, '')
      .replace(/[^A-Z0-9#\- ]+/g, ' ')
      .replace(/\bRANGE\s+(ROAD|RD)\b/g, 'RGE RD')
      .replace(/\bRGE\s+ROAD\b/g, 'RGE RD')
      .replace(/\bRR\s*(\d)/g, 'RGE RD $1')
      .replace(/\bTOWNSHIP\s+(ROAD|RD)\b/g, 'TWP RD')
      .replace(/\bTWP\s+ROAD\b/g, 'TWP RD')
      .replace(/\bHIGHWAY\b/g, 'HWY')
      .replace(/\b(\d+)(ST|ND|RD|TH)\b/g, '$1')      // 72nd -> 72
      .replace(/\s+/g, ' ').trim();
  }

  // "Pinebrook Way SW" -> { name:'PINEBROOK', type:'way', quad:'SW' }
  function parseStreet(s) {
    var toks = clean(s).split(' ').filter(Boolean);
    var quad = null, type = null;
    if (toks.length > 1 && QUADS[toks[toks.length - 1]]) quad = toks.pop();
    // Only treat the last word as a type if a name is left in front of it, and
    // never on rural roads ("RGE RD 33" ends in a number, so it is safe anyway).
    if (toks.length > 1 && TYPE_OF[toks[toks.length - 1]]) type = TYPE_OF[toks.pop()];
    var name = toks.join(' ');
    return name ? { name: name, type: type, quad: quad } : null;
  }

  // Free text -> { number, name, type, quad } or null when there is no street
  // to compare (a place-name search such as "Burnco Aggregates").
  function parseAddress(text) {
    var raw = String(text || '').trim();
    if (!raw) return null;
    // First comma segment, skipping a leading "Unit 5," / "#5," segment.
    var segs = raw.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    while (segs.length > 1 && /^(UNIT|SUITE|STE|BAY|APT|#)\s*[A-Z0-9-]*$/i.test(segs[0])) segs.shift();
    var first = segs[0] || raw;
    var s = clean(first)
      .replace(/^(UNIT|SUITE|STE|BAY|APT)\s*[A-Z0-9]+\s*/, '')
      .replace(/^#\s*[A-Z0-9]+\s*/, '')
      .replace(/^[A-Z]?\d+[A-Z]?\s*-\s*(?=\d)/, '');        // "5-1234 36 St" -> "1234 36 St"
    if (raw.indexOf(',') < 0) {
      // No commas: cut after the quadrant if there is one, else peel city /
      // province / postal code off the end.
      var m = s.match(/^(.*?\b(NE|NW|SE|SW))\b/);
      if (m && /^\d/.test(m[1])) s = m[1];
      else {
        s = s.replace(/\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/g, '').trim();
        var toks = s.split(' ');
        while (toks.length > 2 && TAIL_WORDS.indexOf(toks[toks.length - 1]) >= 0) toks.pop();
        s = toks.join(' ');
      }
    }
    var mm = s.match(/^(\d+)[A-Z]?\s+(.+)$/);
    if (!mm) {
      var st = parseStreet(s);
      // Street with no number ("Pinebrook Way SW") still gets street matching,
      // but only if it looks like a street (has a type or quadrant).
      return st && (st.type || st.quad) ? { number: null, name: st.name, type: st.type, quad: st.quad } : null;
    }
    var street = parseStreet(mm[2]);
    if (!street) return null;
    return { number: mm[1], name: street.name, type: street.type, quad: street.quad };
  }

  function sameStreet(a, b) {
    if (!a || !b || a.name !== b.name) return false;
    if (a.type && b.type && a.type !== b.type) return false;
    if (a.quad && b.quad && a.quad !== b.quad) return false;
    return true;
  }

  function metres(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/\b([a-z])/g, function (c) { return c.toUpperCase(); })
      .replace(/\b(Ne|Nw|Se|Sw)\b/g, function (q) { return q.toUpperCase(); })
      .replace(/\b(Rge Rd|Twp Rd|Hwy)\b/g, function (r) { return r.toUpperCase(); });
  }

  function timedFetch(fetchFn, url, opts) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, TIMEOUT_MS) : null;
    var o = Object.assign({}, opts || {}, ctl ? { signal: ctl.signal } : {});
    return fetchFn(url, o).then(function (res) {
      if (t) clearTimeout(t);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }, function (e) { if (t) clearTimeout(t); throw e; });
  }

  // Nominatim's usage policy is at most one request per second.
  var lastNominatim = 0;
  function nominatimGap() {
    var wait = lastNominatim + 1100 - Date.now();
    lastNominatim = Math.max(Date.now(), lastNominatim + 1100);
    return wait > 0 ? new Promise(function (r) { setTimeout(r, wait); }) : Promise.resolve();
  }

  function nominatim(fetchFn, q, bounded) {
    var url = NOMINATIM + '?format=jsonv2&addressdetails=1&limit=5&countrycodes=ca' +
      '&viewbox=' + VIEWBOX + (bounded ? '&bounded=1' : '') + '&q=' + encodeURIComponent(q);
    return nominatimGap().then(function () { return timedFetch(fetchFn, url); })
      .then(function (rows) {
        return (rows || []).map(function (r) {
          var a = r.address || {};
          var road = a.road || a.pedestrian || a.footway || a.street || a.residential || '';
          var area = a.neighbourhood || a.suburb || a.quarter || a.city || a.town || a.village || a.county || '';
          return {
            lat: parseFloat(r.lat), lng: parseFloat(r.lon),
            label: r.display_name, road: road, area: area,
            houseNumber: a.house_number || null, source: 'OpenStreetMap'
          };
        });
      });
  }

  function calgary(fetchFn, p) {
    var where = "house_number='" + p.number + "' AND street_name='" + p.name.replace(/'/g, "''") + "'";
    var url = CALGARY + '?$limit=20&$where=' + encodeURIComponent(where);
    return timedFetch(fetchFn, url).then(function (rows) {
      return (rows || []).filter(function (r) {
        return sameStreet(p, { name: clean(r.street_name), type: TYPE_OF[r.street_type] || null, quad: r.street_quad || null });
      }).map(function (r) {
        return { lat: parseFloat(r.latitude), lng: parseFloat(r.longitude),
                 label: titleCase(r.address) + ', Calgary', source: 'City of Calgary address points' };
      }).filter(function (h) { return isFinite(h.lat) && isFinite(h.lng); });
    });
  }

  function rockyView(fetchFn, p) {
    if (!/^\d+$/.test(p.number)) return Promise.resolve([]);
    var like = p.name.replace(/[^A-Z0-9 ]/g, '');
    var where = 'intHouseNum=' + p.number + " AND UPPER(vchRoad) LIKE '%" + like + "%'";
    var url = ROCKYVIEW + '?f=json&outSR=4326&returnGeometry=true' +
      '&outFields=vchAddress,vchRoad,vchUnitBay,vchPremiseType,AddressStatus' +
      '&where=' + encodeURIComponent(where);
    return timedFetch(fetchFn, url).then(function (d) {
      return ((d && d.features) || []).filter(function (f) {
        var at = f.attributes || {};
        if (at.AddressStatus && String(at.AddressStatus).toLowerCase() !== 'current') return false;
        return f.geometry && sameStreet(p, parseStreet(at.vchRoad));
      }).map(function (f) {
        var at = f.attributes;
        var kind = at.vchPremiseType ? ' (' + at.vchPremiseType + ')' : '';
        return { lat: f.geometry.y, lng: f.geometry.x,
                 label: titleCase(String(at.vchAddress || '').trim()) + ', Rocky View County' + kind,
                 source: 'Rocky View County address points' };
      });
    });
  }

  // Collapse hits that are the same physical spot (a parcel can carry several
  // records). Several DIFFERENT spots = ambiguous, never auto-picked.
  function cap(list) { return list.slice(0, 3); }

  function distinctPlaces(hits) {
    var out = [];
    hits.forEach(function (h) {
      if (!out.some(function (o) { return metres(o, h) < SAME_PLACE_M; })) out.push(h);
    });
    return out;
  }

  /* lookup(text, { fetch }) resolves to
   *   { status: 'found',   best: hit, suggestions: [] }
   *   { status: 'suggest', best: null, suggestions: [hit...] }   // nothing confirmed
   *   { status: 'none',    best: null, suggestions: [] }
   *   { status: 'error',   best: null, suggestions: [], error }   // every source failed
   * A hit is { lat, lng, label, source, precision, note? }. precision is
   * 'address' | 'street' | 'place' | 'other'.
   */
  function lookup(text, opts) {
    var fetchFn = (opts && opts.fetch) || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    var q = String(text || '').trim();
    if (!q) return Promise.resolve({ status: 'none', best: null, suggestions: [] });
    var p = parseAddress(q);
    var failures = 0, attempts = 0;
    var suggestions = [];
    function soft(promise) {
      attempts++;
      return promise.catch(function (e) { failures++; return []; });
    }
    function done(status, best) {
      if (status !== 'found' && attempts > 0 && failures === attempts) {
        return { status: 'error', best: null, suggestions: [], error: 'lookup failed' };
      }
      return { status: status, best: best || null, suggestions: best ? [] : suggestions };
    }

    return soft(nominatim(fetchFn, q, false)).then(function (rows) {
      if (!p) {
        // Place-name search, no street to check against: keep the old
        // behaviour (take OSM's best match), but the pin stays adjustable.
        if (rows.length) return done('found', Object.assign({ precision: 'place' }, rows[0]));
        return done('none');
      }
      var streetHits = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var same = sameStreet(p, parseStreet(r.road));
        var numOk = !p.number || String(r.houseNumber || '').split(/[;,]/).map(function (x) {
          return x.trim().replace(/[^0-9]/g, '');
        }).indexOf(p.number) >= 0;
        if (same && numOk) return done('found', Object.assign({ precision: p.number ? 'address' : 'street' }, r));
        if (same) streetHits.push(Object.assign({ precision: 'street', note: 'Street only, house ' + p.number + ' not found here' }, r));
        else suggestions.push(Object.assign({ precision: 'other', note: 'Different street: ' + (r.road || 'unnamed') + (r.area ? ', ' + r.area : '') }, r));
      }
      var authoritative = p.number
        ? Promise.all([soft(calgary(fetchFn, p)), soft(rockyView(fetchFn, p))])
        : Promise.resolve([[], []]);
      return authoritative.then(function (res) {
        var exact = distinctPlaces(res[0].concat(res[1]));
        if (exact.length === 1) return done('found', Object.assign({ precision: 'address' }, exact[0]));
        if (exact.length > 1) {
          suggestions = exact.map(function (h) { return Object.assign({ precision: 'address', note: 'Same number and street name, check the quadrant' }, h); });
          return done('suggest');
        }
        // Still nothing: ask OSM for the street itself (no quadrant, no city,
        // fenced to the region) so the dispatcher can start the pin nearby.
        var noHouse = p.number ? 'Street only, house ' + p.number + ' not found' : 'Street match';
        if (streetHits.length) { suggestions = cap(streetHits).concat(cap(suggestions)); return done('suggest'); }
        var streetQ = p.name + (p.type ? ' ' + p.type : '');
        return soft(nominatim(fetchFn, streetQ, true)).then(function (rows2) {
          rows2.forEach(function (r) {
            if (sameStreet(p, parseStreet(r.road)) && !streetHits.some(function (s) { return metres(s, r) < 300; })) {
              streetHits.push(Object.assign({ precision: 'street', note: noHouse + (r.area ? ' (' + r.area + ')' : '') }, r));
            }
          });
          suggestions = cap(streetHits).concat(cap(suggestions));
          return done(suggestions.length ? 'suggest' : 'none');
        });
      });
    });
  }

  // "51.0310, -114.2520" (Google Maps copy format) -> {lat,lng} or null.
  function parseCoords(s) {
    var m = String(s || '').trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
    if (!m) return null;
    var lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    // Alberta sanity: people paste "lng, lat" by mistake. Swap if that fits.
    if (lat < 0 && lng > 0 && Math.abs(lng) <= 90) { var t = lat; lat = lng; lng = t; }
    return { lat: lat, lng: lng };
  }

  return { lookup: lookup, parseAddress: parseAddress, parseStreet: parseStreet,
           sameStreet: sameStreet, parseCoords: parseCoords, metres: metres, clean: clean };
});
