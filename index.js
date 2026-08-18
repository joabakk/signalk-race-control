const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const DEFAULT_HANDICAP_SOURCE_PAGE = 'https://ssca.no/aktiviteter/vet-tall';
const HANDICAP_CACHE_TTL_MS = 60 * 60 * 1000;

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // ignore, \n (possibly preceded by \r) ends the row
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// The register uses Norwegian decimal commas (e.g. "1,07"), quoted in the
// CSV export precisely because the comma would otherwise look like a field
// separator.
function parseNorwegianNumber(s) {
  if (s == null) return null;
  const t = String(s).trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return isFinite(n) ? n : null;
}

// The sheet has a title-row block, a sail-area-weighting block, and then the
// real header row (identifiable by having both "Klasse" and "VET 1" cells).
// Boat rows follow it: name, validity flag, then a repeating
// [sail-config label, VET value] pair per rating (up to 3).
function parseHandicapSheet(csvText) {
  const rows = parseCsvText(csvText);
  const headerRowIndex = rows.findIndex((r) => r.includes('Klasse') && r.includes('VET 1'));
  if (headerRowIndex === -1) {
    throw new Error('Could not find the "Klasse" / "VET 1" header row in the handicap sheet');
  }
  const header = rows[headerRowIndex];
  const col = (name) => header.indexOf(name);
  const vetCols = [col('VET 1'), col('VET 2'), col('VET 3')].filter((i) => i !== -1);
  const classCol = col('Klasse');
  const ownerCol = col('Eier');

  const boats = [];
  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[0] || '').trim();
    if (!name) continue;
    const validity = (row[1] || '').trim();
    const vets = vetCols
      .map((vc, idx) => {
        const value = parseNorwegianNumber(row[vc]);
        if (value == null) return null;
        const label = (row[vc - 1] || '').replace(/:\s*$/, '').trim() || `VET ${idx + 1}`;
        return { label, value };
      })
      .filter(Boolean);
    if (!vets.length) continue;
    boats.push({
      name,
      validity,
      class: classCol !== -1 ? (row[classCol] || '').trim() : '',
      owner: ownerCol !== -1 ? (row[ownerCol] || '').trim() : '',
      vets
    });
  }
  return boats;
}

function extractGoogleSheetId(text) {
  const m = text.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// The sheet ID changes year to year, so by default we re-resolve it from the
// SSCA page that links to "this year's" register rather than hardcoding an
// ID that will go stale. A directly-configured Google Sheets URL skips the
// page-scrape and is used as-is.
async function resolveHandicapCsvUrl(sourceUrl) {
  const directId = extractGoogleSheetId(sourceUrl);
  if (directId) {
    return `https://docs.google.com/spreadsheets/d/${directId}/export?format=csv`;
  }
  const res = await fetch(sourceUrl);
  if (!res.ok) {
    throw new Error(`Could not load ${sourceUrl}: HTTP ${res.status}`);
  }
  const html = await res.text();
  const sheetId = extractGoogleSheetId(html);
  if (!sheetId) {
    throw new Error(`No Google Sheets link found on ${sourceUrl}`);
  }
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
}

function makeRaceId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function makeBoatId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function raceSummary(race) {
  const boats = Object.values(race.boats);
  return {
    id: race.id,
    name: race.name,
    createdAt: race.createdAt,
    scheduledStart: race.scheduledStart,
    startTime: race.startTime,
    boatCount: boats.length,
    finishedCount: boats.filter((b) => b.finishTime).length,
    dnfCount: boats.filter((b) => b.dnf).length
  };
}

function emptyCourse() {
  return { startLine: null, marks: [], finishLine: null };
}

// Pre-existing races (saved before these fields existed) are missing them —
// backfill in place so every handler can assume they exist.
function ensureRaceShape(race) {
  if (!race.course) race.course = emptyCourse();
  if (race.selfBoatId === undefined) race.selfBoatId = null;
  if (race.stopTime === undefined) race.stopTime = null;
  if (race.scheduledCallOff === undefined) race.scheduledCallOff = null;
  Object.values(race.boats).forEach((b) => {
    if (!b.track) b.track = [];
    if (b.dnf === undefined) b.dnf = false;
    if (b.dnfPosition === undefined) b.dnfPosition = null;
  });
}

const EARTH_RADIUS_NM = 3440.065;
const MS_TO_KNOTS = 1.9438444924574;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function distanceNm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function midpoint(a, b) {
  return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
}

function validateCoordPoint(p) {
  if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number' || !isFinite(p.lat) || !isFinite(p.lon)) {
    return null;
  }
  if (p.lat < -90 || p.lat > 90 || p.lon < -180 || p.lon > 180) return null;
  const out = { lat: p.lat, lon: p.lon };
  const name = (p.name || '').toString().trim();
  if (name) out.name = name;
  return out;
}

function validateLine(line) {
  if (line === null) return null;
  if (!Array.isArray(line) || line.length !== 2) return undefined; // undefined = invalid, caller rejects
  const a = validateCoordPoint(line[0]);
  const b = validateCoordPoint(line[1]);
  if (!a || !b) return undefined;
  return [a, b];
}

// HH:MM:SS for a duration, or '' when there's nothing to show — matches the
// webapp's fmtDuration, used for the Excel export's Elapsed/Corrected columns.
function formatDurationHms(ms) {
  if (ms == null || ms < 0 || !isFinite(ms)) return '';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// Renders an absolute instant as the wall-clock time it was in the
// exporting browser's own timezone (tzOffsetMinutes = that browser's
// Date.prototype.getTimezoneOffset()) rather than the server's timezone,
// which may well be different — the server can be headless/UTC while the
// person opening the spreadsheet is reading it in their own local time.
function formatLocalTime(utcMs, tzOffsetMinutes) {
  if (utcMs == null) return '';
  const shifted = new Date(utcMs - tzOffsetMinutes * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

function formatLocalDateTime(utcMs, tzOffsetMinutes) {
  if (utcMs == null) return '';
  const shifted = new Date(utcMs - tzOffsetMinutes * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  );
}

module.exports = function (app) {
  const plugin = {};

  plugin.id = 'race-control';
  plugin.name = 'Race Control';
  plugin.description =
    'Elapsed and handicap-corrected (Time-on-Time) race time tracking for named, plannable races, with a webapp UI, per-boat editable TCF, and VET-tall import from SSCA.';

  plugin.schema = {
    type: 'object',
    properties: {
      defaultTcf: {
        type: 'number',
        title: 'Default Time-on-Time correction factor (TCF) applied to newly seen boats',
        default: 1.0
      },
      handicapSourceUrl: {
        type: 'string',
        title:
          'VET-tall page to resolve the current handicap register from (or a direct Google Sheets link to override)',
        default: DEFAULT_HANDICAP_SOURCE_PAGE
      },
      vetEnabled: {
        type: 'boolean',
        title:
          'Use the VET-tall register for autocomplete and per-boat handicap alternatives. When off, every boat is treated as outside VET: TCF is remembered per boat name across races instead.',
        default: false
      }
    }
  };

  // Races are kept by id so several can be planned ahead and reviewed after
  // the fact, rather than a single race getting overwritten by Reset.
  // boatRegistry is a separate, cross-race name->MMSI/TCF memory: once a
  // boat's MMSI or (for boats outside VET) TCF is entered anywhere, it's
  // applied automatically next time that name is used in any race.
  let state = { races: {}, order: [], currentRaceId: null, boatRegistry: {} };
  let dataFile = null;
  const scheduleTimers = new Map(); // raceId -> Timeout, for scheduledStart
  const callOffTimers = new Map(); // raceId -> Timeout, for scheduledCallOff
  let handicapCache = { fetchedAt: 0, boats: [], sourceUrl: null, csvUrl: null };

  function loadState() {
    try {
      const raw = fs.readFileSync(dataFile, 'utf8');
      const loaded = JSON.parse(raw);
      state = {
        races: loaded.races || {},
        order: loaded.order || [],
        currentRaceId: loaded.currentRaceId || null,
        boatRegistry: loaded.boatRegistry || {}
      };
    } catch (e) {
      state = { races: {}, order: [], currentRaceId: null, boatRegistry: {} };
    }
  }

  // Cross-race memory keyed by boat name, merging in whichever fields are
  // given (mmsi and/or tcf) without clobbering the other. tcf is only ever
  // written here for boats outside the VET register — see the callers.
  function upsertBoatRegistry(name, fields) {
    if (!name) return;
    const key = name.trim().toLowerCase();
    const existing = state.boatRegistry[key] || { name: name.trim() };
    existing.name = name.trim();
    if (fields.mmsi) existing.mmsi = String(fields.mmsi).trim();
    if (fields.tcf != null) existing.tcf = fields.tcf;
    state.boatRegistry[key] = existing;
  }

  function getRegistryEntry(name) {
    return state.boatRegistry[(name || '').trim().toLowerCase()] || null;
  }

  function lookupBoatRegistry(name) {
    const entry = getRegistryEntry(name);
    return entry ? entry.mmsi : null;
  }

  // vetEnabled is a plugin config setting (Server -> Plugin Config), not
  // per-race and not editable from the webapp itself. Off by default — a
  // fresh install (or one that's never touched this setting) treats every
  // boat as outside VET until it's explicitly turned on.
  function isVetEnabled() {
    return !!(plugin.options && plugin.options.vetEnabled === true);
  }

  // A boat only counts as "in VET" for registry-TCF purposes while the
  // config setting has VET enabled and the register (whatever's currently
  // cached) actually has a matching name — disabling VET makes every boat
  // "outside VET" for this purpose too, per the setting's whole point.
  function isVetMatch(name) {
    if (!isVetEnabled()) return false;
    const n = (name || '').trim().toLowerCase();
    return handicapCache.boats.some((b) => b.name.toLowerCase() === n);
  }

  function saveState() {
    try {
      fs.writeFileSync(dataFile, JSON.stringify(state, null, 2));
    } catch (e) {
      app.error('race-control: failed to persist state: ' + e.message);
    }
  }

  function getRace(id) {
    return state.races[id] || null;
  }

  function getBoat(race, boatId) {
    return race.boats[boatId] || null;
  }

  function contextForMmsi(mmsi) {
    return `vessels.urn:mrn:imo:mmsi:${mmsi}`;
  }

  // Live snapshot straight from SignalK's in-memory model (no HTTP
  // round-trip) — used both for track recording and the finish estimate.
  function getLivePosition(mmsi) {
    if (!mmsi) return null;
    try {
      const posLeaf = app.getPath(`${contextForMmsi(mmsi)}.navigation.position`);
      const pos = posLeaf && posLeaf.value;
      if (!pos || typeof pos.latitude !== 'number' || typeof pos.longitude !== 'number') return null;
      const sogLeaf = app.getPath(`${contextForMmsi(mmsi)}.navigation.speedOverGround`);
      const sogMs = sogLeaf && typeof sogLeaf.value === 'number' ? sogLeaf.value : null;
      return { lat: pos.latitude, lon: pos.longitude, sogMs };
    } catch (e) {
      return null;
    }
  }

  // Live position if we have one right now, else the last recorded track
  // point, else nothing — used when marking a boat DNF, since by then it
  // may no longer be broadcasting AIS.
  function getLastKnownPosition(boat) {
    const live = getLivePosition(boat.mmsi);
    if (live) return { lat: live.lat, lon: live.lon };
    if (boat.track && boat.track.length) {
      const last = boat.track[boat.track.length - 1];
      return { lat: last.lat, lon: last.lon };
    }
    return null;
  }

  // A mark counts as "rounded" once the boat's recorded track came within
  // this radius of it. ~0.1nm (~185m) — loose enough to tolerate AIS
  // position jitter and the 15s sampling gap (a boat doing 7kn covers about
  // 0.03nm between samples) without needing an exact pass.
  const MARK_ROUNDING_RADIUS_NM = 0.1;

  // Scans a boat's recorded track chronologically, advancing to the next
  // mark each time the track comes within rounding radius of the current
  // one — so it naturally requires marks to be rounded in course order.
  // Automatic (no manual "boat X rounded mark Y" input) by design, at the
  // cost of missing a rounding if a boat cuts far outside the radius.
  function countRoundedMarks(race, boat) {
    const marks = race.course.marks;
    if (!marks.length || !boat.track || !boat.track.length) return 0;
    let markIdx = 0;
    for (const pt of boat.track) {
      if (markIdx >= marks.length) break;
      if (distanceNm(pt, marks[markIdx]) <= MARK_ROUNDING_RADIUS_NM) {
        markIdx++;
      }
    }
    return markIdx;
  }

  // Distance from the boat's current position, around each remaining mark
  // in order, to the finish line — not just a straight line to the finish.
  // Returns null if there's nothing left to route to (no remaining marks and
  // no finish line).
  function remainingCourseDistanceNm(race, boat, currentPos) {
    const roundedCount = countRoundedMarks(race, boat);
    const waypoints = race.course.marks.slice(roundedCount).map((m) => ({ lat: m.lat, lon: m.lon }));
    if (race.course.finishLine) waypoints.push(midpoint(race.course.finishLine[0], race.course.finishLine[1]));
    if (!waypoints.length) return null;
    let total = 0;
    let from = currentPos;
    for (const wp of waypoints) {
      total += distanceNm(from, wp);
      from = wp;
    }
    return { nm: total, marksRemaining: race.course.marks.length - roundedCount };
  }

  // Distance-to-go (current position, around remaining marks in rounding
  // order, to the finish line) divided by current speed over ground.
  // Accurate only as far as the automatic mark-rounding detection above is;
  // if a boat hasn't been recorded rounding a mark yet, that mark (and
  // everything after it) is still counted as ahead of it. Only offered when
  // there's a finish line, a live position, and a non-trivial speed.
  function estimateFinish(race, boat) {
    if (!race.startTime || boat.finishTime || boat.dnf || race.stopTime) return null;
    if (!race.course || !race.course.finishLine) return null;
    const live = getLivePosition(boat.mmsi);
    if (!live || live.sogMs == null || live.sogMs < 0.25) return null;
    const remaining = remainingCourseDistanceNm(race, boat, live);
    if (remaining == null) return null;
    const sogKn = live.sogMs * MS_TO_KNOTS;
    const hoursRemaining = remaining.nm / sogKn;
    const estFinishTime = Date.now() + hoursRemaining * 3600 * 1000;
    const estElapsedMs = estFinishTime - race.startTime;
    const tcf = boat.tcf != null ? boat.tcf : 1.0;
    return {
      remainingNm: Math.round(remaining.nm * 100) / 100,
      marksRemaining: remaining.marksRemaining,
      sogKn: Math.round(sogKn * 10) / 10,
      estFinishTime,
      estElapsedMs,
      estCorrectedMs: estElapsedMs * tcf
    };
  }

  // Attaches a live `estimate` to each unfinished boat without mutating the
  // stored race — it's derived from live data, never persisted.
  function raceWithEstimates(race) {
    const out = JSON.parse(JSON.stringify(race));
    Object.values(out.boats).forEach((b) => {
      b.estimate = estimateFinish(race, race.boats[b.id]);
    });
    return out;
  }

  // Same ranking the webapp's table uses (finished boats by real corrected
  // time, still-racing boats by projected corrected time when available,
  // DNF/unrankable boats last) — shared by the Excel export so its row
  // order and the on-screen order always agree.
  function rankedBoatList(race) {
    const now = race.stopTime || Date.now();
    return Object.values(race.boats)
      .map((boat) => {
        const elapsedMs = !boat.dnf && race.startTime ? (boat.finishTime || now) - race.startTime : null;
        const tcf = boat.tcf != null ? boat.tcf : 1.0;
        const correctedMs = elapsedMs != null ? elapsedMs * tcf : null;
        const estimate = estimateFinish(race, boat);
        const rankMs = boat.dnf ? null : boat.finishTime ? correctedMs : estimate ? estimate.estCorrectedMs : correctedMs;
        return { boat, elapsedMs, correctedMs, estimate, rankMs };
      })
      .sort((a, b) => {
        if (a.rankMs == null && b.rankMs == null) return a.boat.name.localeCompare(b.boat.name);
        if (a.rankMs == null) return 1;
        if (b.rankMs == null) return -1;
        return a.rankMs - b.rankMs;
      });
  }

  function waypointResource(name, pt) {
    return {
      name,
      feature: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pt.lon, pt.lat] },
        properties: {}
      }
    };
  }

  function routeResource(name, points) {
    return {
      name,
      feature: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: points.map((p) => [p.lon, p.lat]) },
        properties: {}
      }
    };
  }

  // Best-effort: publishes the course as SignalK waypoint/route resources so
  // any chart plotter (freeboard-sk etc.) that reads the standard resources
  // API shows it overlaid on a real chart. Silently no-ops if this server
  // has no resources provider registered — core race-control features never
  // depend on this succeeding.
  async function publishCourseResources(race) {
    if (!app.resourcesApi || typeof app.resourcesApi.setResource !== 'function') return;
    try {
      const points = [];
      const put = (id, name, pt) => app.resourcesApi.setResource('waypoints', id, waypointResource(name, pt));
      if (race.course.startLine) {
        await put(`race-${race.id}-start-pin`, `${race.name} — Start (pin)`, race.course.startLine[0]);
        await put(`race-${race.id}-start-committee`, `${race.name} — Start (committee)`, race.course.startLine[1]);
        points.push(race.course.startLine[0], race.course.startLine[1]);
      }
      for (const m of race.course.marks) {
        await put(`race-${race.id}-mark-${m.id}`, `${race.name} — ${m.name}`, m);
        points.push(m);
      }
      if (race.course.finishLine) {
        await put(`race-${race.id}-finish-pin`, `${race.name} — Finish (pin)`, race.course.finishLine[0]);
        await put(`race-${race.id}-finish-committee`, `${race.name} — Finish (committee)`, race.course.finishLine[1]);
        points.push(race.course.finishLine[0], race.course.finishLine[1]);
      }
      if (points.length >= 2) {
        await app.resourcesApi.setResource('routes', `race-${race.id}-course`, routeResource(race.name, points));
      }
    } catch (e) {
      app.debug('race-control: could not publish course to SignalK resources: ' + e.message);
    }
  }

  // Every live (started, not all finished) race's unfinished boats get a
  // position sample appended periodically — the recorded trail is what the
  // webapp's course/replay chart draws.
  function recordTrackSample() {
    let changed = false;
    Object.values(state.races).forEach((race) => {
      if (!race.startTime || race.stopTime) return;
      Object.values(race.boats).forEach((boat) => {
        if (boat.finishTime || boat.dnf || !boat.mmsi) return;
        const live = getLivePosition(boat.mmsi);
        if (!live) return;
        if (!boat.track) boat.track = [];
        boat.track.push({ t: Date.now(), lat: live.lat, lon: live.lon });
        if (boat.track.length > 2000) boat.track.shift();
        changed = true;
      });
    });
    if (changed) saveState();
  }

  function disarmSchedule(raceId) {
    const t = scheduleTimers.get(raceId);
    if (t) {
      clearTimeout(t);
      scheduleTimers.delete(raceId);
    }
  }

  function doStart(race, atTime) {
    disarmSchedule(race.id);
    disarmCallOffSchedule(race.id);
    race.startTime = atTime;
    race.scheduledStart = null;
    race.stopTime = null;
    race.scheduledCallOff = null;
    Object.values(race.boats).forEach((b) => {
      b.finishTime = null;
      b.track = [];
      b.dnf = false;
      b.dnfPosition = null;
    });
    saveState();
  }

  // Re-arms (or clears) the timer that auto-starts a race at its
  // scheduledStart. Called on every state change that touches
  // scheduledStart, and once per race at plugin startup so a schedule set
  // before a server restart still fires.
  function armSchedule(race) {
    disarmSchedule(race.id);
    if (race.scheduledStart && !race.startTime) {
      const delay = race.scheduledStart - Date.now();
      if (delay <= 0) {
        doStart(race, race.scheduledStart);
      } else {
        scheduleTimers.set(
          race.id,
          setTimeout(() => doStart(race, race.scheduledStart), delay)
        );
      }
    }
  }

  function disarmCallOffSchedule(raceId) {
    const t = callOffTimers.get(raceId);
    if (t) {
      clearTimeout(t);
      callOffTimers.delete(raceId);
    }
  }

  // Calling off a race (whether by clicking Stop or via a scheduled
  // call-off firing) freezes the clock and marks every boat that hasn't
  // finished as DNF, capturing its last known position if one's available —
  // finished boats are left alone.
  function doStop(race, atTime) {
    disarmCallOffSchedule(race.id);
    race.stopTime = atTime;
    race.scheduledCallOff = null;
    Object.values(race.boats).forEach((boat) => {
      if (!boat.finishTime && !boat.dnf) {
        boat.dnf = true;
        boat.dnfPosition = getLastKnownPosition(boat);
      }
    });
    saveState();
  }

  // Re-arms (or clears) the timer that auto-calls-off a race at its
  // scheduledCallOff, mirroring armSchedule for the start.
  function armCallOffSchedule(race) {
    disarmCallOffSchedule(race.id);
    if (race.scheduledCallOff && race.startTime && !race.stopTime) {
      const delay = race.scheduledCallOff - Date.now();
      if (delay <= 0) {
        doStop(race, race.scheduledCallOff);
      } else {
        callOffTimers.set(
          race.id,
          setTimeout(() => doStop(race, race.scheduledCallOff), delay)
        );
      }
    }
  }

  async function fetchHandicapBoats(forceRefresh) {
    const sourceUrl = (plugin.options && plugin.options.handicapSourceUrl) || DEFAULT_HANDICAP_SOURCE_PAGE;
    const age = Date.now() - handicapCache.fetchedAt;
    if (!forceRefresh && handicapCache.sourceUrl === sourceUrl && age < HANDICAP_CACHE_TTL_MS) {
      return handicapCache;
    }
    const csvUrl = await resolveHandicapCsvUrl(sourceUrl);
    const res = await fetch(csvUrl);
    if (!res.ok) {
      throw new Error(`Handicap sheet returned HTTP ${res.status}`);
    }
    const csvText = await res.text();
    const boats = parseHandicapSheet(csvText);
    handicapCache = { fetchedAt: Date.now(), boats, sourceUrl, csvUrl };
    return handicapCache;
  }

  let trackTimer = null;

  plugin.start = function (options) {
    plugin.options = options || {};
    dataFile = path.join(app.getDataDirPath(), 'race-state.json');
    loadState();
    Object.values(state.races).forEach((race) => {
      ensureRaceShape(race);
      armSchedule(race);
      armCallOffSchedule(race);
    });
    trackTimer = setInterval(recordTrackSample, 15000);
    app.setPluginStatus('Race control ready');
  };

  plugin.stop = function () {
    scheduleTimers.forEach((t) => clearTimeout(t));
    scheduleTimers.clear();
    callOffTimers.forEach((t) => clearTimeout(t));
    callOffTimers.clear();
    if (trackTimer) {
      clearInterval(trackTimer);
      trackTimer = null;
    }
  };

  plugin.registerWithRouter = function (router) {
    router.get('/races', (req, res) => {
      const races = state.order.map((id) => raceSummary(state.races[id])).filter(Boolean);
      res.json({ currentRaceId: state.currentRaceId, races });
    });

    router.post('/races', (req, res) => {
      const name = ((req.body && req.body.name) || '').trim();
      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }
      const scheduledStart = req.body && req.body.scheduledStart != null ? Number(req.body.scheduledStart) : null;
      const race = {
        id: makeRaceId(),
        name,
        createdAt: Date.now(),
        scheduledStart: isFinite(scheduledStart) ? scheduledStart : null,
        startTime: null,
        stopTime: null,
        scheduledCallOff: null,
        boats: {},
        course: emptyCourse(),
        selfBoatId: null
      };
      state.races[race.id] = race;
      state.order.push(race.id);
      state.currentRaceId = race.id;
      saveState();
      armSchedule(race);
      res.json({ currentRaceId: state.currentRaceId, race });
    });

    router.get('/races/:id', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      ensureRaceShape(race);
      res.json(raceWithEstimates(race));
    });

    // A snapshot of the current standings as a downloadable .xlsx — same
    // rows, same order as the webapp's table. ?tzOffsetMinutes=<n> should be
    // the exporting browser's own Date.prototype.getTimezoneOffset(), so
    // the Finish Time column reads in their local time, not the server's.
    router.get('/races/:id/export.xlsx', async (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      ensureRaceShape(race);
      const tzParsed = Number(req.query.tzOffsetMinutes);
      const tz = isFinite(tzParsed) ? tzParsed : new Date().getTimezoneOffset();

      const ranked = rankedBoatList(race);
      const headers = ['Rank', 'Boat', 'MMSI', 'TCF', 'Elapsed', 'Corrected', 'Finish Time', 'Status'];

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Race Control';
      workbook.created = new Date();
      const sheet = workbook.addWorksheet('Results');

      const titleRow = sheet.addRow([race.name]);
      sheet.mergeCells(titleRow.number, 1, titleRow.number, headers.length);
      titleRow.getCell(1).font = { bold: true, size: 14 };

      const statusLine = race.stopTime
        ? `Called off ${formatLocalDateTime(race.stopTime, tz)}`
        : race.startTime
          ? `Started ${formatLocalDateTime(race.startTime, tz)}`
          : 'Not started';
      const infoRow = sheet.addRow([statusLine]);
      sheet.mergeCells(infoRow.number, 1, infoRow.number, headers.length);
      infoRow.getCell(1).font = { italic: true, color: { argb: 'FF64748B' } };

      sheet.addRow([]);

      const headerRow = sheet.addRow(headers);
      headerRow.font = { bold: true };
      headerRow.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
      });

      ranked.forEach((r, i) => {
        const status = r.boat.dnf ? 'DNF' : r.boat.finishTime ? 'Finished' : race.startTime ? 'Racing' : 'Not started';
        const rankLabel = r.boat.dnf ? 'DNF' : r.rankMs != null ? i + 1 : '';
        sheet.addRow([
          rankLabel,
          r.boat.name,
          r.boat.mmsi || '',
          r.boat.tcf,
          formatDurationHms(r.elapsedMs),
          formatDurationHms(r.correctedMs),
          r.boat.finishTime ? formatLocalTime(r.boat.finishTime, tz) : '',
          status
        ]);
      });

      const widths = [7, 24, 12, 8, 12, 12, 12, 12];
      widths.forEach((w, i) => {
        sheet.getColumn(i + 1).width = w;
      });

      const safeName = (race.name || 'race').replace(/[^a-z0-9\-_]+/gi, '_').slice(0, 60) || 'race';
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}-results.xlsx"`);
      try {
        await workbook.xlsx.write(res);
        res.end();
      } catch (e) {
        app.error('race-control: failed to generate xlsx export: ' + e.message);
        if (!res.headersSent) res.status(500).json({ error: 'Could not generate export' });
      }
    });

    router.post('/races/:id/select', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      state.currentRaceId = race.id;
      saveState();
      res.json({ currentRaceId: state.currentRaceId });
    });

    router.delete('/races/:id', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      disarmSchedule(race.id);
      delete state.races[race.id];
      state.order = state.order.filter((id) => id !== race.id);
      if (state.currentRaceId === race.id) {
        state.currentRaceId = state.order.length ? state.order[state.order.length - 1] : null;
      }
      saveState();
      res.json({ currentRaceId: state.currentRaceId });
    });

    router.post('/races/:id/start', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      doStart(race, Date.now());
      res.json(raceWithEstimates(race));
    });

    router.post('/races/:id/schedule', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      if (race.startTime) {
        return res.status(400).json({ error: 'Race has already started' });
      }
      const t = Number(req.body && req.body.startTime);
      if (!isFinite(t)) {
        return res.status(400).json({ error: 'startTime must be an epoch-millisecond timestamp' });
      }
      race.scheduledStart = t;
      saveState();
      armSchedule(race);
      res.json(raceWithEstimates(race));
    });

    router.post('/races/:id/schedule/cancel', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      race.scheduledStart = null;
      saveState();
      armSchedule(race);
      res.json(raceWithEstimates(race));
    });

    router.post('/races/:id/reset', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      disarmSchedule(race.id);
      disarmCallOffSchedule(race.id);
      race.startTime = null;
      race.scheduledStart = null;
      race.stopTime = null;
      race.scheduledCallOff = null;
      Object.values(race.boats).forEach((b) => {
        b.finishTime = null;
        b.track = [];
        b.dnf = false;
        b.dnfPosition = null;
      });
      saveState();
      res.json(raceWithEstimates(race));
    });

    // Calls off the race right now: the clock freezes (and track recording
    // / finish estimates stop), and every boat that hasn't finished is
    // marked DNF with its last known position — see doStop. Unlike Reset,
    // this doesn't touch boats, finish times, or the course.
    router.post('/races/:id/stop', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      if (!race.startTime) return res.status(400).json({ error: 'Race has not started' });
      if (race.stopTime) return res.status(400).json({ error: 'Race is already stopped' });
      doStop(race, Date.now());
      res.json(raceWithEstimates(race));
    });

    // Discards the stop — not a true pause/resume. The clock jumps straight
    // back to real elapsed time (startTime to now); the time spent stopped
    // is not excluded from anyone's elapsed/corrected time. Every DNF'd boat
    // is un-DNF'd too, since calling the race back on means it's still live
    // (there's no separate tracking of "DNF'd by hand" vs "DNF'd by Stop").
    router.post('/races/:id/resume', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      if (!race.stopTime) return res.status(400).json({ error: 'Race is not stopped' });
      race.stopTime = null;
      Object.values(race.boats).forEach((boat) => {
        if (boat.dnf) {
          boat.dnf = false;
          boat.dnfPosition = null;
        }
      });
      saveState();
      res.json(raceWithEstimates(race));
    });

    // Schedules an automatic call-off (same effect as Stop) at a future
    // time — mirrors /schedule for the start.
    router.post('/races/:id/schedule-call-off', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      if (race.stopTime) return res.status(400).json({ error: 'Race is already stopped' });
      const t = Number(req.body && req.body.time);
      if (!isFinite(t)) {
        return res.status(400).json({ error: 'time must be an epoch-millisecond timestamp' });
      }
      race.scheduledCallOff = t;
      saveState();
      armCallOffSchedule(race);
      res.json(raceWithEstimates(race));
    });

    router.post('/races/:id/schedule-call-off/cancel', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      race.scheduledCallOff = null;
      saveState();
      armCallOffSchedule(race);
      res.json(raceWithEstimates(race));
    });

    // Marks one boat as "self" so the webapp can show live/finished
    // comparisons (gap, or a countdown-to-catch-up) against every other
    // boat. Pass boatId: null to clear it.
    router.put('/races/:id/self', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      const boatId = (req.body && req.body.boatId) || null;
      if (boatId && !getBoat(race, boatId)) return res.status(400).json({ error: 'No such boat' });
      race.selfBoatId = boatId;
      saveState();
      res.json(raceWithEstimates(race));
    });

    // Replaces the whole course in one save (matches the webapp's single
    // "Save Course" form). Pass startLine/finishLine as `null` to clear a
    // line, or a [pointA, pointB] pair to set one; marks is the full
    // ordered replacement list.
    router.put('/races/:id/course', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      const body = req.body || {};
      ensureRaceShape(race);

      let startLine = race.course.startLine;
      if ('startLine' in body) {
        const v = validateLine(body.startLine);
        if (v === undefined) return res.status(400).json({ error: 'startLine must be null or [pointA, pointB]' });
        startLine = v;
      }
      let finishLine = race.course.finishLine;
      if ('finishLine' in body) {
        const v = validateLine(body.finishLine);
        if (v === undefined) return res.status(400).json({ error: 'finishLine must be null or [pointA, pointB]' });
        finishLine = v;
      }
      let marks = race.course.marks;
      if ('marks' in body) {
        if (!Array.isArray(body.marks)) return res.status(400).json({ error: 'marks must be an array' });
        const validated = [];
        for (let i = 0; i < body.marks.length; i++) {
          const p = validateCoordPoint(body.marks[i]);
          if (!p) return res.status(400).json({ error: `mark ${i + 1} has an invalid lat/lon` });
          validated.push({ id: (body.marks[i].id || `m${i}`).toString(), name: p.name || `Mark ${i + 1}`, lat: p.lat, lon: p.lon });
        }
        marks = validated;
      }

      race.course = { startLine, marks, finishLine };
      saveState();
      publishCourseResources(race).catch(() => {});
      res.json(raceWithEstimates(race));
    });

    // Boats are entered explicitly per race (not auto-populated from AIS) so
    // the committee can add/remove exactly who's racing; the webapp still
    // offers AIS and VET-register names as autocomplete suggestions when
    // adding one.
    router.post('/races/:id/boats', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      const name = ((req.body && req.body.name) || '').trim();
      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }
      const givenMmsi = ((req.body && req.body.mmsi) || '').toString().trim();
      const mmsi = givenMmsi || lookupBoatRegistry(name);
      if (mmsi) upsertBoatRegistry(name, { mmsi });
      const defaultTcf = (plugin.options && plugin.options.defaultTcf) || 1.0;
      // A remembered TCF only applies to boats outside VET — a VET-matched
      // boat should be picked fresh from the register's own dropdown rather
      // than silently carrying over a number from wherever it last raced.
      let tcf = defaultTcf;
      if (!isVetMatch(name)) {
        const remembered = getRegistryEntry(name);
        if (remembered && remembered.tcf != null) tcf = remembered.tcf;
      }
      const boat = {
        id: makeBoatId(),
        name,
        mmsi: mmsi || null,
        tcf,
        finishTime: null,
        track: [],
        dnf: false,
        dnfPosition: null
      };
      race.boats[boat.id] = boat;
      saveState();
      res.json(boat);
    });

    router.delete('/races/:id/boats/:boatId', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      if (!getBoat(race, req.params.boatId)) return res.status(404).json({ error: 'No such boat' });
      delete race.boats[req.params.boatId];
      if (race.selfBoatId === req.params.boatId) race.selfBoatId = null;
      saveState();
      res.json({ ok: true });
    });

    // Sets (or, with finishTime: null, clears) a boat's finish time to an
    // arbitrary timestamp, so race committee can correct a mistimed click.
    router.put('/races/:id/boats/:boatId/finishTime', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      const boat = getBoat(race, req.params.boatId);
      if (!boat) return res.status(404).json({ error: 'No such boat' });
      const raw = req.body ? req.body.finishTime : undefined;
      if (raw === null) {
        boat.finishTime = null;
      } else {
        const t = Number(raw);
        if (!isFinite(t) || t <= 0) {
          return res.status(400).json({ error: 'finishTime must be an epoch-millisecond timestamp or null' });
        }
        boat.finishTime = t;
        // A real finish supersedes a DNF (e.g. correcting a call-off that
        // caught a boat that had actually already crossed the line).
        boat.dnf = false;
        boat.dnfPosition = null;
      }
      saveState();
      res.json(boat);
    });

    // Marks (or, with dnf: false, un-marks) one boat DNF by hand, outside of
    // a full race call-off — e.g. a boat retires mid-race. Setting it also
    // clears any finish time and captures the boat's last known position.
    router.put('/races/:id/boats/:boatId/dnf', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      const boat = getBoat(race, req.params.boatId);
      if (!boat) return res.status(404).json({ error: 'No such boat' });
      const dnf = !!(req.body && req.body.dnf);
      if (dnf) {
        boat.dnf = true;
        boat.finishTime = null;
        boat.dnfPosition = getLastKnownPosition(boat);
      } else {
        boat.dnf = false;
        boat.dnfPosition = null;
      }
      saveState();
      res.json(boat);
    });

    router.put('/races/:id/boats/:boatId/mmsi', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      const boat = getBoat(race, req.params.boatId);
      if (!boat) return res.status(404).json({ error: 'No such boat' });
      const mmsi = ((req.body && req.body.mmsi) || '').toString().trim();
      boat.mmsi = mmsi || null;
      if (boat.mmsi) upsertBoatRegistry(boat.name, { mmsi: boat.mmsi });
      saveState();
      res.json(boat);
    });

    router.get('/boat-registry', (req, res) => {
      res.json({ boats: Object.values(state.boatRegistry) });
    });

    // Plugin config setting (Server -> Plugin Config), not per-race and not
    // writable from the webapp — the webapp only reads it to know whether to
    // offer the VET-tall register at all.
    router.get('/vet-enabled', (req, res) => {
      res.json({ enabled: isVetEnabled() });
    });

    router.put('/races/:id/boats/:boatId/tcf', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      const boat = getBoat(race, req.params.boatId);
      if (!boat) return res.status(404).json({ error: 'No such boat' });
      const tcf = Number(req.body && req.body.tcf);
      if (!isFinite(tcf) || tcf <= 0) {
        return res.status(400).json({ error: 'tcf must be a positive number' });
      }
      boat.tcf = tcf;
      // Remembered across races only for boats outside VET — see the note
      // on upsertBoatRegistry/isVetMatch above.
      if (!isVetMatch(boat.name)) upsertBoatRegistry(boat.name, { tcf });
      saveState();
      res.json(boat);
    });

    router.get('/handicap-source', async (req, res) => {
      try {
        const force = req.query.refresh === 'true' || req.query.refresh === '1';
        const data = await fetchHandicapBoats(force);
        res.json(data);
      } catch (e) {
        res.status(502).json({ error: 'Could not load handicap register: ' + e.message });
      }
    });
  };

  return plugin;
};
