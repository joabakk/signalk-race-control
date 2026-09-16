const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

const DEFAULT_HANDICAP_SOURCE_PAGE = 'https://ssca.no/aktiviteter/vet-tall';
const HANDICAP_CACHE_TTL_MS = 60 * 60 * 1000;

// KTK (Klassisk Treseiler Klubb) publishes its own handicap register, KLR,
// as an HTML table embedded directly in a Blogger post tagged "KLR" — the
// label listing page below always shows the most recent post first (with
// its full content, not just an excerpt), so it doubles as "whichever
// season's numbers are current" without needing to track individual post
// URLs across years, the same way the VET-tall page above always links to
// the current sheet. A specific post URL works too, since it has the exact
// same table.
const DEFAULT_KTK_SOURCE_PAGE = 'http://klassisktreseilerklubb.blogspot.com/search/label/KLR';

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

function stripHtmlToText(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .trim();
}

// KTK's KLR table has just two columns (boat name, KLR number) and no label
// text distinguishing multiple entries for the same boat (unlike VET-tall's
// named sail configurations) — a boat with more than one row just gets
// numbered alternatives. The published KLR number isn't a TCF directly:
// corrected time = elapsed × (KLR / 100), so that division happens here,
// once, rather than at every point KLR values get used downstream — same
// as VET-tall's own numbers, which likewise need no conversion once parsed.
function parseKtkHtml(html) {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) {
    throw new Error('Could not find the KLR table on the page');
  }
  const rowMatches = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const boatsByKey = new Map();
  rowMatches.forEach((rowHtml) => {
    const cellMatches = rowHtml.match(/<td[\s\S]*?<\/td>/gi) || [];
    if (cellMatches.length < 2) return;
    const name = stripHtmlToText(cellMatches[0]);
    const rawValue = parseNorwegianNumber(stripHtmlToText(cellMatches[1]));
    if (!name || rawValue == null || rawValue <= 0) return;
    const key = name.toLowerCase();
    const existing = boatsByKey.get(key) || { name, vets: [] };
    // raw is the published KLR number itself (e.g. 166) — kept alongside
    // the converted TCF (1.66) so the dropdown can show the number sailors
    // actually recognize, not just the already-divided multiplier.
    existing.vets.push({ label: '', value: Math.round((rawValue / 100) * 1000) / 1000, raw: rawValue });
    boatsByKey.set(key, existing);
  });
  const boats = Array.from(boatsByKey.values());
  boats.forEach((b) => {
    b.vets.forEach((v, i) => {
      v.label = b.vets.length > 1 ? `KLR ${i + 1}` : 'KLR';
    });
  });
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

// Manage2Sail has no public "list classes for this event" API — the event
// page itself embeds the classes ("regattas" in their terminology) as JSON
// in a window.boostrapedResourceData script tag, and the event's own GUID
// (needed for the entries API below) only appears in a support-form link on
// the same page. Both are scraped from the page's HTML.
function parseManage2SailEventPage(html) {
  const eventIdMatch = html.match(/EventIssue\?eventId=([0-9a-f-]{36})/i);
  if (!eventIdMatch) {
    throw new Error("Could not find this event's id on the page — check the URL is a Manage2Sail event page");
  }
  const dataMatch = html.match(/window\.boostrapedResourceData\s*=\s*(\{.*?\});/s);
  if (!dataMatch) {
    throw new Error('Could not find class data on the page — check the URL is a Manage2Sail event page');
  }
  let data;
  try {
    data = JSON.parse(dataMatch[1]);
  } catch (e) {
    throw new Error('Could not parse class data from the Manage2Sail page');
  }
  const classes = (data.Regatta || []).map((r) => ({ id: r.Id, name: r.Name }));
  return { eventId: eventIdMatch[1], classes };
}

// Many entries (dinghies, small keelboats) have no named boat — the display
// name falls back through BoatName -> SailNumber -> TeamName -> SkipperName.
// SailNumber comes before Team/SkipperName specifically because it
// identifies the boat itself (stable across a re-import even if the
// skipper changes), where a person's name doesn't.
//
// hcp is left as the raw published number here — converting it to a usable
// TCF depends on which handicap system it's actually under (see
// HANDICAP_SYSTEMS / resolveHandicapSystem below), which isn't known until
// the caller has both hcpName and a look at the actual values.
function parseManage2SailEntries(json) {
  const hcpName = json.HcpName || '';
  const entries = [];
  let skipped = 0;
  (json.Entries || []).forEach((e) => {
    const name = ((e.BoatName || e.SailNumber || e.TeamName || e.SkipperName || '') + '').trim();
    const hcp = parseFloat(((e.Hcp || '') + '').replace(',', '.'));
    if (!name || !isFinite(hcp) || hcp <= 0) {
      skipped++;
      return;
    }
    entries.push({ name, hcp, sailNumber: e.SailNumber || '' });
  });
  return { hcpName, entries, skipped };
}

// Handicap systems this plugin knows how to turn into a Time-on-Time TCF
// (corrected = elapsed * TCF, higher = faster). "tcf" is the fallback: the
// published number is assumed to already be usable as-is. Yardstick systems
// work the other way around (lower number = faster boat) and aren't a
// direct multiplier, so they need the conversion below instead.
const HANDICAP_SYSTEMS = [
  { key: 'tcf', label: 'Time-on-Time — use the published number as TCF directly', convert: (hcp) => hcp },
  { key: 'ys', label: 'Yardstick — YS (German/DSV, scale 100): TCF = 100 / number', convert: (hcp) => 100 / hcp },
  { key: 'py', label: 'Portsmouth Yardstick — PY/PN (RYA, scale 1000): TCF = 1000 / number', convert: (hcp) => 1000 / hcp }
];

function findHandicapSystem(key) {
  return HANDICAP_SYSTEMS.find((s) => s.key === key) || null;
}

// hcpName alone doesn't reliably say which system is in play — different
// clubs/countries publish under the same label with very different scales.
// Where the label maps to exactly one system whose scale actually matches
// the observed values, resolve automatically; otherwise report the
// candidates so the caller can ask the user to pick.
function resolveHandicapSystem(hcpName, sampleHcpValues) {
  const name = (hcpName || '').trim().toUpperCase();
  const looksDsvScale = sampleHcpValues.length > 0 && sampleHcpValues.every((v) => v >= 40 && v <= 250);
  const looksRyaScale = sampleHcpValues.length > 0 && sampleHcpValues.every((v) => v >= 400 && v <= 3000);
  if (name === 'YS') {
    if (looksDsvScale && !looksRyaScale) return { resolved: 'ys' };
    if (looksRyaScale && !looksDsvScale) return { resolved: 'py' };
    return { resolved: null, candidates: ['ys', 'py', 'tcf'] };
  }
  if (name === 'PY' || name === 'PN') {
    return { resolved: 'py' };
  }
  // Unrecognized/blank/ORC/IRC/etc. — default to treating it as already TCF.
  return { resolved: 'tcf' };
}

function makeRaceId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function makeBoatId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function makeClassId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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
  if (race.multiDay === undefined) race.multiDay = false;
  if (!race.classes) race.classes = [];
  race.classes.forEach((c) => {
    if (c.startTime === undefined) c.startTime = null;
  });
  Object.values(race.boats).forEach((b) => {
    if (!b.track) b.track = [];
    if (b.dnf === undefined) b.dnf = false;
    if (b.dns === undefined) b.dns = false;
    if (b.dnfPosition === undefined) b.dnfPosition = null;
    if (b.startTime === undefined) b.startTime = null;
    if (b.sailNumber === undefined) b.sailNumber = null;
    if (b.classId === undefined) b.classId = null;
    if (!b.markTimes) b.markTimes = {};
  });
  // A boat's classId can go stale (its class got deleted) — rather than
  // check for that everywhere a class is looked up, just clear it here so
  // every other boat.classId in memory is always either null or a real
  // class.
  const classIds = new Set(race.classes.map((c) => c.id));
  Object.values(race.boats).forEach((b) => {
    if (b.classId && !classIds.has(b.classId)) b.classId = null;
  });
}

function findClass(race, classId) {
  return (race.classes || []).find((c) => c.id === classId) || null;
}

// A boat's own start time (a per-boat correction) wins if set; otherwise
// its class's start time (a staggered/pursuit start by class) if it's in
// one and that class has its own start time set; otherwise the race's
// single start time, same as before either of those existed.
function effectiveStartTime(race, boat) {
  if (boat.startTime != null) return boat.startTime;
  const cls = boat.classId ? findClass(race, boat.classId) : null;
  if (cls && cls.startTime != null) return cls.startTime;
  return race.startTime;
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

// Renders an absolute instant as the wall-clock time it was in the
// exporting browser's own timezone (tzOffsetMinutes = that browser's
// Date.prototype.getTimezoneOffset()) rather than the server's timezone,
// which may well be different — the server can be headless/UTC while the
// person opening the spreadsheet is reading it in their own local time.
function formatLocalDateTime(utcMs, tzOffsetMinutes) {
  if (utcMs == null) return '';
  const shifted = new Date(utcMs - tzOffsetMinutes * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  );
}

// A single self-contained .html file: a trimmed, independent reimplementation
// of the core timing UI (start/stop/resume/reset, add/remove boats, TCF,
// finish times, DNF, self-comparison) that needs no server, no network, and
// no AIS — for a race committee to keep running a race if this plugin's
// server becomes unreachable mid-event. State is saved to the browser's own
// localStorage (keyed by this race's id) so closing and reopening the same
// downloaded file picks up where it left off. Course/chart, AIS boat
// names/positions, estimated finish, and VET-tall import all need the live
// server and are intentionally left out.
function buildOfflineTimerHtml(race, defaultTcf, vetOptions) {
  vetOptions = vetOptions || {};
  const seed = {
    name: race.name,
    startTime: race.startTime,
    stopTime: race.stopTime,
    selfBoatId: race.selfBoatId,
    multiDay: !!race.multiDay,
    defaultTcf: defaultTcf,
    vetEnabled: !!vetOptions.vetEnabled,
    handicapCsvUrl: vetOptions.handicapCsvUrl || null,
    handicapBoats: vetOptions.handicapBoats || [],
    // KTK has no live-refresh counterpart offline (see the route handler) —
    // just this one-time snapshot from export time.
    ktkEnabled: !!vetOptions.ktkEnabled,
    ktkBoats: vetOptions.ktkBoats || [],
    boats: Object.values(race.boats).map((b) => ({
      id: b.id,
      name: b.name,
      sailNumber: b.sailNumber || null,
      tcf: b.tcf != null ? b.tcf : defaultTcf,
      startTime: b.startTime || null,
      finishTime: b.finishTime || null,
      dnf: !!b.dnf,
      dns: !!b.dns
    })),
    storageKey: 'raceControlOffline_v1_' + race.id,
    // Lets a re-download know whether it's actually newer than whatever
    // this browser already has saved locally for the race — see the load
    // logic below.
    exportedAt: Date.now()
  };
  // Embedded inside a <script type="application/json"> tag — race/boat names
  // are user-entered text, so any literal "<" (the only character that could
  // prematurely close the tag, e.g. via "</script>" in a boat name) is
  // escaped. JSON.parse doesn't need this reversed; < is valid JSON.
  const seedJson = JSON.stringify(seed).replace(/</g, '\\u003c');
  // The race name also goes straight into HTML attributes/text below (page
  // title, the iOS home-screen app title) — escaped the normal way for that
  // context, distinct from the JSON escaping above.
  const escapedRaceName = String(race.name || 'Race').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const handicapNotes = [];
  if (vetOptions.vetEnabled) handicapNotes.push('VET-tall handicaps can be refreshed here directly from the internet (see below)');
  if (vetOptions.ktkEnabled) handicapNotes.push("KTK's KLR numbers are included as of download time, but can't be refreshed offline (no direct internet fetch support)");
  const handicapNote = handicapNotes.length
    ? handicapNotes.join(', and ') + '. Importing a whole fleet from Manage2Sail still needs the live plugin server, though.'
    : 'TCF is entered by hand.';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${escapedRaceName} — Offline Timer</title>
<meta name="theme-color" content="#0f172a" />
<!-- Lets "Add to Home Screen" on iOS launch this as a standalone app rather
     than a Safari bookmark — standalone home-screen apps get their own
     persistent storage that isn't subject to Safari's usual after-a-week
     cleanup of unvisited sites, which is what actually makes the saved race
     state stick around between uses. -->
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="${escapedRaceName}" />
<style>
:root {
  --bg: #0f172a; --panel: #1e293b; --border: #334155; --text: #e2e8f0;
  --muted: #94a3b8; --accent: #38bdf8; --good: #22c55e; --bad: #f87171;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); }
header { padding: max(1.25rem, env(safe-area-inset-top)) 1.5rem 1.25rem; border-bottom: 1px solid var(--border); text-align: center; }
h1 { margin: 0 0 0.4rem; font-size: 1.1rem; font-weight: 600; letter-spacing: 0.02em; color: var(--muted); text-transform: uppercase; }
h2 { margin: 0 0 0.75rem; font-size: 1.3rem; }
.offline-note { max-width: 40rem; margin: 0 auto 1rem; font-size: 0.8rem; color: var(--muted); }
.clock { font-size: 3rem; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: 0.05em; color: var(--accent); }
.clock.stopped { color: var(--bad); }
.controls { margin-top: 0.75rem; display: flex; gap: 0.5rem; justify-content: center; }
.race-start-row { margin-top: 0.6rem; display: flex; gap: 0.4rem; justify-content: center; align-items: center; font-size: 0.85rem; color: var(--muted); flex-wrap: wrap; }
.race-start-row input { padding: 0.3rem 0.4rem; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 4px; font-variant-numeric: tabular-nums; }
.race-start-row button { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
.vet-status { display: flex; gap: 0.6rem; justify-content: center; align-items: center; margin-top: 0.4rem; }
.link-btn { background: none; border: none; padding: 0; font-size: 0.8rem; color: var(--accent); text-decoration: underline; cursor: pointer; }
button { font-size: 0.95rem; padding: 0.5rem 1.1rem; border-radius: 6px; border: 1px solid var(--border); background: var(--accent); color: #04202e; font-weight: 600; cursor: pointer; }
button.secondary { background: transparent; color: var(--text); }
button.danger { border-color: var(--bad); color: var(--bad); }
button.confirming { background: var(--bad); color: #2a0a0a; border-color: var(--bad); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.status { min-height: 1.2em; margin-top: 0.5rem; font-size: 0.85rem; color: var(--muted); }
.status.error { color: var(--bad); }
main { padding: 1rem 1.5rem max(2rem, env(safe-area-inset-bottom)); margin: 0 auto; }
.add-boat-row { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
.add-boat-row input[type='text'] { width: 100%; padding: 0.45rem 0.6rem; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; font-size: 0.9rem; }
.add-boat-row input[type='number'] { width: 6rem; padding: 0.45rem 0.6rem; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; font-size: 0.9rem; }
.autocomplete { position: relative; flex: 1; min-width: 12rem; max-width: 20rem; }
.suggestions { position: absolute; top: calc(100% + 2px); left: 0; right: 0; z-index: 10; max-height: 16rem; overflow-y: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); }
.suggestions .suggestion-item { padding: 0.45rem 0.6rem; font-size: 0.85rem; cursor: pointer; color: var(--text); }
.suggestions .suggestion-item mark { background: none; color: var(--accent); font-weight: 700; }
.suggestions .suggestion-item:hover, .suggestions .suggestion-item.active { background: rgba(56, 189, 248, 0.15); }
.table-scroll { overflow-x: auto; }
table { width: 100%; min-width: 44rem; border-collapse: collapse; font-variant-numeric: tabular-nums; }
thead th { text-align: left; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--border); }
tbody td { padding: 0.55rem 0.6rem; border-bottom: 1px solid var(--border); }
.boat-name-col { position: sticky; left: 0; z-index: 1; background: var(--bg); }
thead .boat-name-col { z-index: 2; }
tbody tr.finished td { color: var(--good); }
tbody tr.dnf td { color: var(--muted); }
.dnf-tag { color: var(--bad); font-weight: 700; font-size: 0.85rem; letter-spacing: 0.03em; }
.tcf-input { width: 5.5rem; padding: 0.3rem 0.4rem; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 4px; }
.sail-number-input { width: 5.5rem; padding: 0.3rem 0.4rem; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 4px; }
.tcf-input::-webkit-outer-spin-button, .tcf-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.tcf-input[type='number'] { -moz-appearance: textfield; }
.vet-cell { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; min-width: 11rem; }
.vet-select { max-width: 13rem; padding: 0.3rem 0.4rem; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 4px; font-size: 0.8rem; }
.vet-badge { font-size: 0.7rem; color: var(--muted); }
.vet-badge.warn { color: var(--bad); }
.self-btn { background: none; border: none; padding: 0 0.3rem 0 0; font-size: 1rem; color: var(--muted); cursor: pointer; vertical-align: middle; }
.self-btn.active { color: var(--accent); }
.vs-self { font-variant-numeric: tabular-nums; font-size: 0.85rem; color: var(--muted); }
.vs-self.ahead { color: var(--good); }
.vs-self.behind { color: var(--bad); }
.vs-self .self-tag { font-size: 0.7rem; letter-spacing: 0.04em; color: var(--muted); font-style: italic; }
.finish-cell { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; }
.finish-time-input, .start-time-input { padding: 0.3rem 0.4rem; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 4px; font-variant-numeric: tabular-nums; }
.start-time-input.inherited-value { color: var(--muted); font-style: italic; }
.finish-now-btn, .finish-clear-btn, .finish-dnf-btn, .undo-dnf-btn, .remove-boat-btn { padding: 0.3rem 0.6rem; font-size: 0.8rem; background: transparent; color: var(--text); }
.finish-dnf-btn { border-color: var(--bad); color: var(--bad); }
.dnf-pos { display: block; font-size: 0.7rem; color: var(--muted); }
.empty { color: var(--muted); text-align: center; margin-top: 2rem; }
.footer-actions { margin-top: 1.25rem; display: flex; justify-content: center; }
</style>
</head>
<body>
<header>
  <h1>Race Control — Offline Timer</h1>
  <p class="offline-note">Standalone backup — works with no server connection to this plugin.
    Everything you do here is saved in this browser only (reopen this same downloaded file
    to continue). Boat names/positions from AIS and the course/chart aren't available
    offline. ${handicapNote}</p>
  <h2 id="raceName"></h2>
  <div id="clock" class="clock">00:00:00</div>
  <div class="controls">
    <button id="startBtn">Start Race</button>
    <button id="stopBtn" class="secondary" hidden>Stop</button>
    <button id="resumeBtn" class="secondary" hidden>Resume</button>
    <button id="resetBtn" class="secondary">Reset</button>
  </div>
  <div class="race-start-row">
    <label for="raceStartInput">Race start:</label>
    <input type="time" id="raceStartInput" step="1" />
    <button id="raceStartNowBtn" type="button" class="secondary">Now</button>
    <button id="raceStartClearBtn" type="button" class="secondary">Clear</button>
  </div>
  <div id="vetStatusLine" class="status vet-status" hidden>
    <span id="vetStatusText"></span>
    <button id="vetRefreshBtn" type="button" class="link-btn">Refresh VET register</button>
  </div>
  <div id="statusLine" class="status"></div>
</header>
<main>
  <div class="add-boat-row">
    <div class="autocomplete">
      <input type="text" id="addBoatName" placeholder="Add boat by name…" autocomplete="off" />
      <div id="addBoatSuggestions" class="suggestions" hidden></div>
    </div>
    <input type="number" id="addBoatTcf" step="0.001" min="0.01" title="TCF" />
    <button id="addBoatBtn">Add Boat</button>
  </div>
  <div class="table-scroll">
    <table id="boatsTable">
      <thead>
        <tr>
          <th class="boat-name-col">Boat</th>
          <th>Sail #</th>
          <th>TCF</th>
          <th id="vetAlternativesTh" hidden>Handicap alternatives</th>
          <th>Start time</th>
          <th>Elapsed</th>
          <th>Corrected</th>
          <th>vs Self</th>
          <th>Finish time</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="boatsBody"></tbody>
    </table>
  </div>
  <p id="emptyMsg" class="empty" hidden>No boats yet. Use "Add Boat" above.</p>
  <div class="footer-actions">
    <button id="downloadCsvBtn" class="secondary">Download results as CSV</button>
  </div>
</main>
<script id="seed-data" type="application/json">${seedJson}</script>
<script>
(function () {
  var STORAGE_KEY = null;
  var race = null;
  try {
    var seed = JSON.parse(document.getElementById('seed-data').textContent);
    STORAGE_KEY = seed.storageKey;
    var rawSaved = localStorage.getItem(STORAGE_KEY);
    var saved = rawSaved ? JSON.parse(rawSaved) : null;
    // A saved local copy only wins if it's at least as fresh as this
    // download's own seed — otherwise re-downloading an updated snapshot
    // after managing the race further elsewhere would silently keep
    // showing the older, already-saved copy instead.
    if (saved && (saved.exportedAt || 0) >= seed.exportedAt) {
      race = saved;
    } else {
      race = seed;
      save();
    }
    // vetEnabled/handicapCsvUrl reflect the server's current plugin config,
    // not user-entered race data, so a re-download's seed always wins for
    // those even if a locally-saved copy is otherwise newer. The fetched
    // register itself is kept from local storage when present, so an
    // already-refreshed register isn't thrown away by a re-download.
    race.vetEnabled = !!seed.vetEnabled;
    race.handicapCsvUrl = seed.handicapCsvUrl || null;
    if (!Array.isArray(race.handicapBoats)) race.handicapBoats = seed.handicapBoats || [];
    // KTK has no live refresh offline (see the seed's own comment above), so
    // its snapshot only ever comes from the seed — always take it fresh.
    race.ktkEnabled = !!seed.ktkEnabled;
    race.ktkBoats = seed.ktkBoats || [];
  } catch (e) {
    race = { name: 'Race', startTime: null, stopTime: null, selfBoatId: null, multiDay: false, boats: [], defaultTcf: 1.0, vetEnabled: false, handicapCsvUrl: null, handicapBoats: [], ktkEnabled: false, ktkBoats: [] };
  }

  function save() {
    if (!STORAGE_KEY) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(race)); } catch (e) {}
  }

  function genId() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function findBoat(id) {
    for (var i = 0; i < race.boats.length; i++) if (race.boats[i].id === id) return race.boats[i];
    return null;
  }

  function doStart() {
    race.startTime = Date.now();
    race.stopTime = null;
    race.boats.forEach(function (b) { b.finishTime = null; b.startTime = null; b.dnf = false; b.dns = false; });
    save();
  }
  function doStop() {
    race.stopTime = Date.now();
    race.boats.forEach(function (b) { if (!b.finishTime && !b.dnf && !b.dns) b.dnf = true; });
    save();
  }
  // A race with at least one boat where every boat has either finished or
  // been marked DNF/DNS has nothing left to time — call it off
  // automatically rather than leaving the clock running until someone
  // remembers to.
  function isRaceComplete() {
    if (!race.boats.length) return false;
    return race.boats.every(function (b) { return b.finishTime || b.dnf || b.dns; });
  }
  function maybeAutoStop() {
    if (race.startTime && !race.stopTime && isRaceComplete()) doStop();
  }
  function doResume() {
    if (!race.stopTime) return;
    race.stopTime = null;
    race.boats.forEach(function (b) { b.dnf = false; });
    save();
  }
  function doReset() {
    race.startTime = null;
    race.stopTime = null;
    race.boats.forEach(function (b) { b.finishTime = null; b.startTime = null; b.dnf = false; b.dns = false; });
    save();
  }
  function effectiveStart(boat) {
    return boat.startTime != null ? boat.startTime : race.startTime;
  }

  var statusEl = document.getElementById('statusLine');
  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('error', !!isError);
  }

  var vetStatusLine = document.getElementById('vetStatusLine');
  var vetStatusText = document.getElementById('vetStatusText');
  var vetRefreshBtn = document.getElementById('vetRefreshBtn');
  var vetAlternativesTh = document.getElementById('vetAlternativesTh');
  var addBoatSuggestions = document.getElementById('addBoatSuggestions');
  var handicapVersion = 0;
  function setVetStatus(msg, isError) {
    vetStatusText.textContent = msg || '';
    vetStatusText.classList.toggle('error', !!isError);
  }

  // Mirrors the plugin server's own CSV parsing (index.js: parseCsvText /
  // parseNorwegianNumber / parseHandicapSheet) so this page can refresh the
  // VET-tall register on its own — the sheet export is CORS-friendly and
  // fetchable directly from a browser, unlike the SSCA lookup page or
  // Manage2Sail, which is why only VET-tall (not fleet import) works offline.
  function parseCsvText(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else if (c === '\\r') {
        // ignore
      } else {
        field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  function parseNorwegianNumber(s) {
    if (s == null) return null;
    var t = String(s).trim().replace(',', '.');
    if (t === '') return null;
    var n = Number(t);
    return isFinite(n) ? n : null;
  }
  function parseHandicapSheet(csvText) {
    var rows = parseCsvText(csvText);
    var headerRowIndex = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].indexOf('Klasse') !== -1 && rows[i].indexOf('VET 1') !== -1) { headerRowIndex = i; break; }
    }
    if (headerRowIndex === -1) throw new Error('Could not find the "Klasse" / "VET 1" header row in the handicap sheet');
    var header = rows[headerRowIndex];
    function col(name) { return header.indexOf(name); }
    var vetCols = [col('VET 1'), col('VET 2'), col('VET 3')].filter(function (i) { return i !== -1; });
    var classCol = col('Klasse');
    var ownerCol = col('Eier');
    var boats = [];
    for (var r = headerRowIndex + 1; r < rows.length; r++) {
      var row = rows[r];
      var name = (row[0] || '').trim();
      if (!name) continue;
      var validity = (row[1] || '').trim();
      var vets = vetCols.map(function (vc, idx) {
        var value = parseNorwegianNumber(row[vc]);
        if (value == null) return null;
        var label = (row[vc - 1] || '').replace(/:\\s*$/, '').trim() || ('VET ' + (idx + 1));
        return { label: label, value: value };
      }).filter(Boolean);
      if (!vets.length) continue;
      boats.push({
        name: name,
        validity: validity,
        class: classCol !== -1 ? (row[classCol] || '').trim() : '',
        owner: ownerCol !== -1 ? (row[ownerCol] || '').trim() : '',
        vets: vets
      });
    }
    return boats;
  }

  var nameSuggestionPool = [];
  var suggestionItems = [];
  var suggestionActiveIndex = -1;
  function rebuildAddBoatSuggestions() {
    var seen = {};
    nameSuggestionPool = [];
    race.handicapBoats.concat(race.ktkBoats).forEach(function (b) {
      var key = b.name.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      nameSuggestionPool.push({ name: b.name });
    });
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function hideSuggestions() {
    addBoatSuggestions.hidden = true;
    addBoatSuggestions.innerHTML = '';
    suggestionItems = [];
    suggestionActiveIndex = -1;
  }
  function renderSuggestionActive() {
    Array.prototype.forEach.call(addBoatSuggestions.children, function (el, i) {
      el.classList.toggle('active', i === suggestionActiveIndex);
    });
  }
  function selectSuggestion(item) {
    addBoatName.value = item.name;
    hideSuggestions();
    addBoatName.focus();
  }
  function showSuggestionsFor(query) {
    var q = query.trim().toLowerCase();
    if (!q) { hideSuggestions(); return; }
    var matches = nameSuggestionPool.filter(function (s) { return s.name.toLowerCase().indexOf(q) !== -1; }).slice(0, 20);
    suggestionItems = matches;
    suggestionActiveIndex = -1;
    if (!matches.length) { hideSuggestions(); return; }
    addBoatSuggestions.innerHTML = '';
    matches.forEach(function (item) {
      var div = document.createElement('div');
      div.className = 'suggestion-item';
      var idx = item.name.toLowerCase().indexOf(q);
      if (idx === -1) {
        div.textContent = item.name;
      } else {
        div.innerHTML = escapeHtml(item.name.slice(0, idx)) + '<mark>' + escapeHtml(item.name.slice(idx, idx + q.length)) + '</mark>' + escapeHtml(item.name.slice(idx + q.length));
      }
      div.addEventListener('mousedown', function (e) { e.preventDefault(); selectSuggestion(item); });
      addBoatSuggestions.appendChild(div);
    });
    addBoatSuggestions.hidden = false;
  }

  function loadHandicapRegister(force) {
    if (!race.vetEnabled) return;
    if (!race.handicapCsvUrl) {
      setVetStatus('No VET register configured on the server.', true);
      return;
    }
    setVetStatus('Loading VET register…');
    fetch(race.handicapCsvUrl)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (csvText) {
        race.handicapBoats = parseHandicapSheet(csvText);
        handicapVersion++;
        save();
        rebuildAddBoatSuggestions();
        setVetStatus('VET register: ' + race.handicapBoats.length + ' boats loaded.');
        render();
      })
      .catch(function (e) {
        setVetStatus('Could not load VET register: ' + e.message, true);
      });
  }

  // Rebuilds a row's alternatives <select> from the current register(s) —
  // only called when a register itself (re)loads, not every render tick.
  // Merges VET-tall and KTK when both are enabled and a boat matches both,
  // rather than picking one over the other.
  function refreshVetAlternatives(row, boatName) {
    var name = boatName.trim().toLowerCase();
    var vetEntry = race.vetEnabled ? race.handicapBoats.find(function (h) { return h.name.toLowerCase() === name; }) : null;
    var ktkEntry = race.ktkEnabled ? race.ktkBoats.find(function (h) { return h.name.toLowerCase() === name; }) : null;
    var bothEnabled = race.vetEnabled && race.ktkEnabled;
    var options = [];
    if (vetEntry) {
      vetEntry.vets.forEach(function (v) {
        options.push({ value: v.value, text: (bothEnabled ? 'VET ' : '') + v.label + ': ' + v.value });
      });
    }
    if (ktkEntry) {
      ktkEntry.vets.forEach(function (v) {
        options.push({ value: v.value, text: (bothEnabled ? 'KTK ' : '') + v.label + ': ' + v.raw + ' → ' + v.value });
      });
    }
    row.vetSelect.innerHTML = '';
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = options.length ? 'Pick…' : 'No match';
    row.vetSelect.appendChild(placeholder);
    row.vetSelect.disabled = !options.length;
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = String(o.value);
      opt.textContent = o.text;
      row.vetSelect.appendChild(opt);
    });
    if (vetEntry) {
      var notValid = /ikke/i.test(vetEntry.validity || '');
      row.vetBadge.textContent = vetEntry.validity ? (notValid ? '⚠ ' + vetEntry.validity : vetEntry.validity) : '';
      row.vetBadge.classList.toggle('warn', notValid);
    } else {
      row.vetBadge.textContent = '';
      row.vetBadge.classList.remove('warn');
    }
  }
  function syncVetSelectValue(row, tcf) {
    if (document.activeElement === row.vetSelect) return;
    var match = Array.from(row.vetSelect.options).find(function (o) {
      return o.value !== '' && Math.abs(parseFloat(o.value) - tcf) < 1e-9;
    });
    row.vetSelect.value = match ? match.value : '';
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtDuration(ms) {
    if (ms == null || ms < 0 || !isFinite(ms)) return '--:--:--';
    var s = Math.floor(ms / 1000);
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
  }
  function fmtSigned(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    var s = Math.floor(Math.abs(ms) / 1000);
    return (ms < 0 ? '-' : '+') + pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
  }
  function raceNow() { return race.stopTime || Date.now(); }
  function tsToTimeInputValue(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  // rollover (default true) pushes an earlier-than-reference time to the
  // next day — correct for a finish time, wrong for a start time (a start
  // has no "must be after" constraint; an earlier entry there just means
  // earlier the same day). Callers editing a start time pass rollover: false.
  function timeInputValueToTs(value, baseTs, rollover) {
    if (!value) return null;
    var parts = value.split(':').map(Number);
    var h = parts[0] || 0, m = parts[1] || 0, s = parts[2] || 0;
    var refTs = baseTs != null ? baseTs : race.startTime;
    var base = refTs ? new Date(refTs) : new Date();
    var d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, s, 0);
    var ts = d.getTime();
    if (rollover !== false && refTs && ts < refTs) ts += 24 * 3600 * 1000;
    return ts;
  }
  // For multi-day races: full date+time, no day-rollover guessing needed.
  function tsToDateTimeInputValue(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function dateTimeInputValueToTs(value) {
    if (!value) return null;
    var ts = new Date(value).getTime();
    return isFinite(ts) ? ts : null;
  }

  // Mirrors the server's rankedBoatList (minus the AIS-based live estimate,
  // which isn't available offline): finished boats rank by real corrected
  // time, still-racing boats by corrected-so-far, DNF boats last. A boat
  // with its own start time (staggered/pursuit start, or a correction) uses
  // that instead of the race's single start time.
  function rankedList() {
    var now = raceNow();
    return race.boats
      .map(function (boat) {
        var start = effectiveStart(boat);
        var elapsedMs = !boat.dnf && !boat.dns && start && start <= now ? (boat.finishTime || now) - start : null;
        var tcf = boat.tcf != null ? boat.tcf : 1.0;
        var correctedMs = elapsedMs != null ? elapsedMs * tcf : null;
        var rankMs = boat.dnf || boat.dns ? null : correctedMs;
        return { boat: boat, elapsedMs: elapsedMs, correctedMs: correctedMs, rankMs: rankMs };
      })
      .sort(function (a, b) {
        // Self always leads, whatever else is true.
        var aSelf = a.boat.id === race.selfBoatId;
        var bSelf = b.boat.id === race.selfBoatId;
        if (aSelf !== bSelf) return aSelf ? -1 : 1;
        // DNS sits at the very end regardless of phase — it can be marked
        // before the race even starts (a known no-show), and never really
        // "entered" the race the way even a DNF (which did start) still did.
        if (a.boat.dns !== b.boat.dns) return a.boat.dns ? 1 : -1;
        if (a.boat.dns) return a.boat.name.localeCompare(b.boat.name);
        // Before the race actually starts, nobody has a corrected time to
        // rank by anyway — leave order exactly as race.boats gave it
        // (registration order) rather than reshuffling on every add/remove.
        if (!race.startTime) return 0;
        if (a.rankMs == null && b.rankMs == null) return a.boat.name.localeCompare(b.boat.name);
        if (a.rankMs == null) return 1;
        if (b.rankMs == null) return -1;
        return a.rankMs - b.rankMs;
      });
  }

  // With no boat marked self, falls back to comparing everyone against the
  // current leader instead of leaving the column blank — ranked is already
  // sorted by rank, so the leader (if any is actually ranked yet) is simply
  // the first entry.
  function computeVsSelf(ranked) {
    var map = {};
    var self = null;
    for (var i = 0; i < ranked.length; i++) if (ranked[i].boat.id === race.selfBoatId) self = ranked[i];
    var isLeaderFallback = false;
    if (!self) {
      self = ranked.length && ranked[0].rankMs != null ? ranked[0] : null;
      isLeaderFallback = true;
    }
    if (!self) return map;
    ranked.forEach(function (r) {
      if (r.boat.id === self.boat.id) { map[r.boat.id] = { type: 'self', isLeader: isLeaderFallback }; return; }
      if (self.boat.dnf || self.boat.dns) { map[r.boat.id] = { type: 'none' }; return; }
      if (!self.boat.finishTime && r.boat.finishTime) {
        var thresholdElapsedMs = r.correctedMs / (self.boat.tcf || 1);
        map[r.boat.id] = {
          type: 'countdown',
          remainingMs: thresholdElapsedMs - self.elapsedMs,
          isLeader: isLeaderFallback
        };
        return;
      }
      var selfVal = self.boat.finishTime ? self.correctedMs : self.rankMs;
      var otherVal = r.boat.finishTime ? r.correctedMs : r.rankMs;
      if (selfVal == null || otherVal == null) { map[r.boat.id] = { type: 'none' }; return; }
      map[r.boat.id] = { type: 'gap', gapMs: otherVal - selfVal, isLeader: isLeaderFallback };
    });
    return map;
  }

  function armConfirm(button, idleLabel, confirmLabel, onConfirm) {
    var armed = false, timer = null;
    function disarm() {
      armed = false;
      clearTimeout(timer);
      button.textContent = idleLabel;
      button.classList.remove('confirming');
    }
    button.addEventListener('click', function () {
      if (!armed) {
        armed = true;
        button.textContent = confirmLabel;
        button.classList.add('confirming');
        timer = setTimeout(disarm, 4000);
      } else {
        disarm();
        onConfirm();
      }
    });
  }

  var clockEl = document.getElementById('clock');
  var startBtn = document.getElementById('startBtn');
  var stopBtn = document.getElementById('stopBtn');
  var resumeBtn = document.getElementById('resumeBtn');
  var resetBtn = document.getElementById('resetBtn');
  var raceStartInput = document.getElementById('raceStartInput');
  var raceStartNowBtn = document.getElementById('raceStartNowBtn');
  var raceStartClearBtn = document.getElementById('raceStartClearBtn');
  var raceNameEl = document.getElementById('raceName');
  var boatsBody = document.getElementById('boatsBody');
  var emptyMsg = document.getElementById('emptyMsg');
  var addBoatName = document.getElementById('addBoatName');
  var addBoatTcf = document.getElementById('addBoatTcf');
  var addBoatBtn = document.getElementById('addBoatBtn');
  var downloadCsvBtn = document.getElementById('downloadCsvBtn');

  addBoatTcf.value = race.defaultTcf || 1.0;
  raceStartInput.type = race.multiDay ? 'datetime-local' : 'time';
  raceNameEl.textContent = race.name || 'Race';
  document.title = (race.name || 'Race') + ' — Offline Timer';

  // Sets (or, with null, clears) the race's own start time directly — a
  // correction tool, distinct from Start Race: it never touches boats'
  // finish times, DNF, or their own start-time overrides. Useful for
  // backdating the start after opening this file later than the actual gun
  // (e.g. because the server went down), or fixing a start clicked late.
  function setRaceStartTime(ts) {
    race.startTime = ts;
    save();
    render();
  }
  raceStartInput.addEventListener('change', function () {
    if (!raceStartInput.value) {
      setRaceStartTime(null);
      return;
    }
    var ts = race.multiDay
      ? dateTimeInputValueToTs(raceStartInput.value)
      : timeInputValueToTs(raceStartInput.value, race.startTime || Date.now(), false);
    setRaceStartTime(ts);
  });
  raceStartNowBtn.addEventListener('click', function () { setRaceStartTime(Date.now()); });
  raceStartClearBtn.addEventListener('click', function () { setRaceStartTime(null); });

  var rows = {};
  function buildRow(boatId) {
    var tr = document.createElement('tr');
    var selfBtn = document.createElement('button');
    selfBtn.type = 'button';
    selfBtn.className = 'self-btn';
    selfBtn.title = 'Mark as self, to compare other boats against';
    selfBtn.textContent = '☆';
    selfBtn.addEventListener('click', function () {
      race.selfBoatId = race.selfBoatId === boatId ? null : boatId;
      save();
      render();
    });
    var nameSpan = document.createElement('span');
    var tdName = document.createElement('td');
    tdName.className = 'boat-name-col';
    tdName.append(selfBtn, nameSpan);

    var sailNumberInput = document.createElement('input');
    sailNumberInput.type = 'text';
    sailNumberInput.className = 'sail-number-input';
    sailNumberInput.placeholder = 'Sail #';
    sailNumberInput.addEventListener('change', function () {
      var boat = findBoat(boatId);
      if (!boat) return;
      boat.sailNumber = sailNumberInput.value.trim() || null;
      save();
      render();
    });
    var tdSailNumber = document.createElement('td');
    tdSailNumber.appendChild(sailNumberInput);

    var tcfInput = document.createElement('input');
    tcfInput.type = 'number';
    tcfInput.step = '0.001';
    tcfInput.min = '0.01';
    tcfInput.className = 'tcf-input';
    tcfInput.addEventListener('change', function () {
      var val = parseFloat(tcfInput.value);
      if (isFinite(val) && val > 0) {
        var boat = findBoat(boatId);
        if (boat) { boat.tcf = val; save(); render(); }
      }
    });
    tcfInput.addEventListener('wheel', function (e) { e.preventDefault(); }, { passive: false });
    tcfInput.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.preventDefault();
    });
    var tdTcf = document.createElement('td');
    tdTcf.appendChild(tcfInput);

    var vetSelect = document.createElement('select');
    vetSelect.className = 'vet-select';
    vetSelect.addEventListener('change', function () {
      var val = parseFloat(vetSelect.value);
      var boat = findBoat(boatId);
      if (boat && isFinite(val) && val > 0) {
        boat.tcf = val;
        save();
        render();
      }
      // Left showing the picked alternative (synced from tcf on future
      // renders) rather than reset to the placeholder — see
      // syncVetSelectValue.
    });
    var vetBadge = document.createElement('span');
    vetBadge.className = 'vet-badge';
    var tdVet = document.createElement('td');
    tdVet.className = 'vet-cell';
    tdVet.hidden = !race.vetEnabled && !race.ktkEnabled;
    tdVet.append(vetSelect, vetBadge);

    var startTimeInput = document.createElement('input');
    startTimeInput.type = race.multiDay ? 'datetime-local' : 'time';
    startTimeInput.step = '1';
    startTimeInput.className = 'start-time-input';
    startTimeInput.addEventListener('change', function () {
      var boat = findBoat(boatId);
      if (!boat) return;
      if (!startTimeInput.value) {
        boat.startTime = null;
      } else {
        boat.startTime = race.multiDay
          ? dateTimeInputValueToTs(startTimeInput.value)
          : timeInputValueToTs(startTimeInput.value, race.startTime || Date.now(), false);
      }
      save();
      render();
    });
    var startNowBtn = document.createElement('button');
    startNowBtn.type = 'button';
    startNowBtn.className = 'finish-now-btn';
    startNowBtn.textContent = 'Now';
    startNowBtn.addEventListener('click', function () {
      var boat = findBoat(boatId);
      if (!boat) return;
      boat.startTime = Date.now();
      save();
      render();
    });
    var startClearBtn = document.createElement('button');
    startClearBtn.type = 'button';
    startClearBtn.className = 'finish-clear-btn';
    startClearBtn.textContent = 'Clear';
    startClearBtn.addEventListener('click', function () {
      var boat = findBoat(boatId);
      if (!boat) return;
      boat.startTime = null;
      save();
      render();
    });
    var startWrap = document.createElement('div');
    startWrap.className = 'finish-cell';
    startWrap.append(startTimeInput, startNowBtn, startClearBtn);
    var tdStart = document.createElement('td');
    tdStart.appendChild(startWrap);

    var tdElapsed = document.createElement('td');
    var tdCorrected = document.createElement('td');
    var tdVsSelf = document.createElement('td');
    tdVsSelf.className = 'vs-self';

    var finishTimeInput = document.createElement('input');
    finishTimeInput.type = race.multiDay ? 'datetime-local' : 'time';
    finishTimeInput.step = '1';
    finishTimeInput.className = 'finish-time-input';
    finishTimeInput.addEventListener('change', function () {
      var boat = findBoat(boatId);
      if (!boat) return;
      if (!finishTimeInput.value) {
        boat.finishTime = null;
      } else {
        boat.finishTime = race.multiDay
          ? dateTimeInputValueToTs(finishTimeInput.value)
          : timeInputValueToTs(finishTimeInput.value);
      }
      maybeAutoStop();
      save();
      render();
    });
    var finishNowBtn = document.createElement('button');
    finishNowBtn.type = 'button';
    finishNowBtn.className = 'finish-now-btn';
    finishNowBtn.textContent = 'Now';
    finishNowBtn.addEventListener('click', function () {
      var boat = findBoat(boatId);
      if (!boat) return;
      boat.finishTime = Date.now();
      maybeAutoStop();
      save();
      render();
    });
    var finishClearBtn = document.createElement('button');
    finishClearBtn.type = 'button';
    finishClearBtn.className = 'finish-clear-btn';
    finishClearBtn.textContent = 'Clear';
    finishClearBtn.addEventListener('click', function () {
      var boat = findBoat(boatId);
      if (!boat) return;
      boat.finishTime = null;
      save();
      render();
    });
    var finishDnfBtn = document.createElement('button');
    finishDnfBtn.type = 'button';
    finishDnfBtn.className = 'finish-dnf-btn';
    finishDnfBtn.textContent = 'DNF';
    finishDnfBtn.addEventListener('click', function () {
      var boat = findBoat(boatId);
      if (!boat) return;
      boat.dnf = true;
      maybeAutoStop();
      save();
      render();
    });
    var finishDnsBtn = document.createElement('button');
    finishDnsBtn.type = 'button';
    finishDnsBtn.className = 'finish-dnf-btn';
    finishDnsBtn.textContent = 'DNS';
    finishDnsBtn.title = 'Did not start';
    finishDnsBtn.addEventListener('click', function () {
      var boat = findBoat(boatId);
      if (!boat) return;
      boat.dns = true;
      maybeAutoStop();
      save();
      render();
    });
    var finishNormalWrap = document.createElement('div');
    finishNormalWrap.className = 'finish-cell';
    finishNormalWrap.append(finishTimeInput, finishNowBtn, finishClearBtn, finishDnfBtn, finishDnsBtn);

    var dnfTag = document.createElement('span');
    dnfTag.className = 'dnf-tag';
    dnfTag.textContent = 'DNF';
    var undoDnfBtn = document.createElement('button');
    undoDnfBtn.type = 'button';
    undoDnfBtn.className = 'undo-dnf-btn';
    undoDnfBtn.textContent = 'Undo DNF';
    undoDnfBtn.addEventListener('click', function () {
      var boat = findBoat(boatId);
      if (!boat) return;
      boat.dnf = false;
      save();
      render();
    });
    var dnfWrap = document.createElement('div');
    dnfWrap.className = 'finish-cell';
    dnfWrap.append(dnfTag, undoDnfBtn);

    var dnsTag = document.createElement('span');
    dnsTag.className = 'dnf-tag';
    dnsTag.textContent = 'DNS';
    var undoDnsBtn = document.createElement('button');
    undoDnsBtn.type = 'button';
    undoDnsBtn.className = 'undo-dnf-btn';
    undoDnsBtn.textContent = 'Undo DNS';
    undoDnsBtn.addEventListener('click', function () {
      var boat = findBoat(boatId);
      if (!boat) return;
      boat.dns = false;
      save();
      render();
    });
    var dnsWrap = document.createElement('div');
    dnsWrap.className = 'finish-cell';
    dnsWrap.append(dnsTag, undoDnsBtn);

    var tdFinish = document.createElement('td');
    tdFinish.append(finishNormalWrap, dnfWrap, dnsWrap);

    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'secondary danger remove-boat-btn';
    removeBtn.textContent = 'Remove';
    armConfirm(removeBtn, 'Remove', 'Confirm?', function () {
      // Don't delete rows[boatId] here — render()'s own seenIds cleanup
      // needs that entry to still be present so it can remove(). the <tr>
      // from the DOM, not just forget about it.
      race.boats = race.boats.filter(function (b) { return b.id !== boatId; });
      if (race.selfBoatId === boatId) race.selfBoatId = null;
      maybeAutoStop();
      save();
      render();
    });
    var tdRemove = document.createElement('td');
    tdRemove.appendChild(removeBtn);

    tr.append(tdName, tdSailNumber, tdTcf, tdVet, tdStart, tdElapsed, tdCorrected, tdVsSelf, tdFinish, tdRemove);
    return {
      tr: tr, selfBtn: selfBtn, nameSpan: nameSpan, sailNumberInput: sailNumberInput, tcfInput: tcfInput,
      vetSelect: vetSelect, vetBadge: vetBadge, vetHandicapVersion: -1,
      startTimeInput: startTimeInput, startNowBtn: startNowBtn, startClearBtn: startClearBtn,
      tdElapsed: tdElapsed, tdCorrected: tdCorrected, tdVsSelf: tdVsSelf,
      finishNormalWrap: finishNormalWrap, finishTimeInput: finishTimeInput, dnfWrap: dnfWrap, dnsWrap: dnsWrap
    };
  }

  function render() {
    if (race.startTime) {
      clockEl.textContent = fmtDuration(raceNow() - race.startTime);
      clockEl.classList.toggle('stopped', !!race.stopTime);
    } else {
      clockEl.textContent = '00:00:00';
      clockEl.classList.remove('stopped');
    }
    startBtn.disabled = !!race.startTime;
    startBtn.textContent = race.startTime ? 'Race Started' : 'Start Race';
    stopBtn.hidden = !race.startTime || !!race.stopTime;
    resumeBtn.hidden = !race.stopTime;
    if (document.activeElement !== raceStartInput) {
      raceStartInput.value = race.multiDay ? tsToDateTimeInputValue(race.startTime) : tsToTimeInputValue(race.startTime);
    }

    emptyMsg.hidden = race.boats.length > 0;
    var ranked = rankedList();
    var vsSelfMap = computeVsSelf(ranked);
    var seenIds = {};
    ranked.forEach(function (r) {
      var b = r.boat;
      seenIds[b.id] = true;
      var row = rows[b.id];
      if (!row) { row = buildRow(b.id); rows[b.id] = row; }
      row.tr.classList.toggle('finished', !!b.finishTime);
      row.tr.classList.toggle('dnf', !!b.dnf || !!b.dns);
      row.nameSpan.textContent = b.name;
      var isSelf = b.id === race.selfBoatId;
      row.selfBtn.textContent = isSelf ? '★' : '☆';
      row.selfBtn.classList.toggle('active', isSelf);
      if (document.activeElement !== row.sailNumberInput) row.sailNumberInput.value = b.sailNumber || '';
      if (document.activeElement !== row.tcfInput) row.tcfInput.value = b.tcf;
      if (race.vetEnabled || race.ktkEnabled) {
        if (row.vetHandicapVersion !== handicapVersion && document.activeElement !== row.vetSelect) {
          refreshVetAlternatives(row, b.name);
          row.vetHandicapVersion = handicapVersion;
        }
        syncVetSelectValue(row, b.tcf);
      }
      // See the equivalent block in app.js's render() — a boat with no
      // start time of its own already starts with the fleet, so the
      // input shows the inherited race start time (dimmed) instead of
      // blank, without turning it into a real per-boat override.
      var effectiveStart = b.startTime != null ? b.startTime : race.startTime;
      if (document.activeElement !== row.startTimeInput) {
        row.startTimeInput.value = race.multiDay ? tsToDateTimeInputValue(effectiveStart) : tsToTimeInputValue(effectiveStart);
      }
      row.startTimeInput.classList.toggle('inherited-value', b.startTime == null && race.startTime != null);
      var canStart = !!race.startTime;
      row.startTimeInput.disabled = !canStart;
      row.startNowBtn.disabled = !canStart;
      row.startClearBtn.disabled = !canStart || !b.startTime;
      row.tdElapsed.textContent = fmtDuration(r.elapsedMs);
      row.tdCorrected.textContent = fmtDuration(r.correctedMs);
      var vs = vsSelfMap[b.id];
      row.tdVsSelf.classList.remove('ahead', 'behind');
      if (!vs || vs.type === 'none') {
        row.tdVsSelf.textContent = '—';
      } else if (vs.type === 'self') {
        row.tdVsSelf.innerHTML = vs.isLeader ? '<span class="self-tag">LEADER</span>' : '<span class="self-tag">SELF</span>';
      } else if (vs.type === 'countdown') {
        row.tdVsSelf.textContent = fmtSigned(vs.remainingMs);
        row.tdVsSelf.classList.add(vs.remainingMs < 0 ? 'behind' : 'ahead');
      } else {
        row.tdVsSelf.textContent = fmtSigned(vs.gapMs);
        row.tdVsSelf.classList.add(vs.gapMs < 0 ? 'ahead' : 'behind');
      }
      row.finishNormalWrap.hidden = !!b.dnf || !!b.dns;
      row.dnfWrap.hidden = !b.dnf;
      row.dnsWrap.hidden = !b.dns;
      if (document.activeElement !== row.finishTimeInput) {
        row.finishTimeInput.value = race.multiDay ? tsToDateTimeInputValue(b.finishTime) : tsToTimeInputValue(b.finishTime);
      }
    });
    Object.keys(rows).forEach(function (id) {
      if (!seenIds[id]) { if (rows[id].tr.parentNode) rows[id].tr.remove(); delete rows[id]; }
    });
    // Reorder to match ranking, skipping while the row (or something inside
    // it) has focus so an in-progress edit isn't disrupted mid-keystroke.
    ranked.forEach(function (r, i) {
      var row = rows[r.boat.id];
      if (row.tr.contains(document.activeElement)) return;
      var atIndex = boatsBody.children[i];
      if (atIndex !== row.tr) boatsBody.insertBefore(row.tr, atIndex || null);
    });
  }

  startBtn.addEventListener('click', function () { doStart(); render(); });
  stopBtn.addEventListener('click', function () { doStop(); render(); });
  resumeBtn.addEventListener('click', function () { doResume(); render(); });
  armConfirm(resetBtn, 'Reset', 'Confirm Reset?', function () { doReset(); render(); });

  function addBoat() {
    var name = addBoatName.value.trim();
    if (!name) { setStatus('Enter a boat name to add.', true); addBoatName.focus(); return; }
    var tcf = parseFloat(addBoatTcf.value);
    if (!isFinite(tcf) || tcf <= 0) tcf = race.defaultTcf || 1.0;
    race.boats.push({ id: genId(), name: name, sailNumber: null, tcf: tcf, startTime: null, finishTime: null, dnf: false });
    save();
    addBoatName.value = '';
    addBoatName.focus();
    setStatus('');
    render();
  }
  addBoatBtn.addEventListener('click', function () { hideSuggestions(); addBoat(); });
  addBoatName.addEventListener('input', function () { showSuggestionsFor(addBoatName.value); });
  addBoatName.addEventListener('focus', function () {
    if (addBoatName.value.trim()) showSuggestionsFor(addBoatName.value);
  });
  addBoatName.addEventListener('blur', function () { hideSuggestions(); });
  addBoatName.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' && suggestionItems.length) {
      e.preventDefault();
      suggestionActiveIndex = (suggestionActiveIndex + 1) % suggestionItems.length;
      renderSuggestionActive();
    } else if (e.key === 'ArrowUp' && suggestionItems.length) {
      e.preventDefault();
      suggestionActiveIndex = (suggestionActiveIndex - 1 + suggestionItems.length) % suggestionItems.length;
      renderSuggestionActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestionActiveIndex >= 0 && suggestionItems[suggestionActiveIndex]) {
        selectSuggestion(suggestionItems[suggestionActiveIndex]);
      } else {
        hideSuggestions();
        addBoat();
      }
    } else if (e.key === 'Escape') {
      hideSuggestions();
    }
  });

  downloadCsvBtn.addEventListener('click', function () {
    var fmtWhen = race.multiDay ? tsToDateTimeInputValue : tsToTimeInputValue;
    var rows = [['Rank', 'Boat', 'Sail Number', 'TCF', 'Start Time', 'Elapsed', 'Corrected', 'Finish Time', 'Status']];
    rankedList().forEach(function (r, i) {
      var status = r.boat.dns ? 'DNS' : r.boat.dnf ? 'DNF' : r.boat.finishTime ? 'Finished' : race.startTime ? 'Racing' : 'Not started';
      var rankLabel = r.boat.dns ? 'DNS' : r.boat.dnf ? 'DNF' : r.rankMs != null ? String(i + 1) : '';
      var start = effectiveStart(r.boat);
      rows.push([
        rankLabel, r.boat.name, r.boat.sailNumber || '', r.boat.tcf, start ? fmtWhen(start) : '', fmtDuration(r.elapsedMs), fmtDuration(r.correctedMs),
        r.boat.finishTime ? fmtWhen(r.boat.finishTime) : '', status
      ]);
    });
    var csv = rows.map(function (row) {
      return row.map(function (cell) {
        var s = String(cell == null ? '' : cell);
        return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\\r\\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (race.name || 'race').replace(/[^a-z0-9\\-_]+/gi, '_').slice(0, 60) + '-offline-results.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  vetStatusLine.hidden = !race.vetEnabled;
  vetAlternativesTh.hidden = !race.vetEnabled && !race.ktkEnabled;
  vetRefreshBtn.addEventListener('click', function () { loadHandicapRegister(true); });
  if (race.ktkEnabled) rebuildAddBoatSuggestions();
  if (race.vetEnabled) {
    rebuildAddBoatSuggestions();
    if (race.handicapBoats.length) {
      setVetStatus('VET register: ' + race.handicapBoats.length + ' boats loaded (from last download/refresh).');
    }
    loadHandicapRegister();
  }

  render();
  setInterval(render, 1000);
})();
</script>
</body>
</html>
`;
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
      },
      ktkSourceUrl: {
        type: 'string',
        title:
          "KTK page to fetch the current season's KLR numbers from — either the label listing (whose most recent post is used) or a specific post directly",
        default: DEFAULT_KTK_SOURCE_PAGE
      },
      ktkEnabled: {
        type: 'boolean',
        title:
          "Use KTK's KLR register for autocomplete and per-boat handicap alternatives too, alongside VET-tall if that's also on — a boat listed in both shows alternatives from both. Corrected time from a KLR number is elapsed × (KLR / 100).",
        default: false
      },
      raceImportEnabled: {
        type: 'boolean',
        title:
          'Allow importing a complete fleet (every boat, with TCF) into a race from an external regatta system — currently Manage2Sail. Off by default, since it fetches from a third-party site and bulk-adds boats.',
        default: false
      },
      markRoundingRadiusM: {
        type: 'number',
        title:
          'How close (in meters) an AIS-tracked boat must come to a mark for it to count as rounded, for the estimated finish time and remaining-distance calculations',
        default: 100
      }
    }
  };

  // Races are kept by id so several can be planned ahead and reviewed after
  // the fact, rather than a single race getting overwritten by Reset.
  // boatRegistry is a separate, cross-race name->MMSI/sail number/TCF
  // memory: once a boat's MMSI, sail number, or (for boats outside VET) TCF
  // is entered anywhere, it's applied automatically next time that name is
  // used in any race.
  let state = { races: {}, order: [], currentRaceId: null, boatRegistry: {} };
  let dataFile = null;
  const scheduleTimers = new Map(); // raceId -> Timeout, for scheduledStart
  const callOffTimers = new Map(); // raceId -> Timeout, for scheduledCallOff

  // setTimeout's delay is a 32-bit signed int internally — anything past
  // ~24.8 days silently wraps and fires almost immediately instead of
  // waiting (this bit a race scheduled weeks out: it — and, since its
  // call-off got armed right after, that too — fired within moments of
  // being scheduled, leaving the race already stopped/DNF'd). This chains
  // multiple max-length timeouts instead of one long one, re-checking the
  // actual remaining delay each time it fires so it also self-corrects
  // for clock changes over a long wait; `timers` is keyed by raceId so
  // disarming always clears whichever leg of the chain is currently
  // pending, the same way a single setTimeout's handle would.
  const MAX_TIMEOUT_MS = 2147483647;
  function scheduleAt(timers, raceId, atTime, fn) {
    const delay = Math.min(Math.max(atTime - Date.now(), 0), MAX_TIMEOUT_MS);
    timers.set(
      raceId,
      setTimeout(() => {
        if (Date.now() >= atTime) fn();
        else scheduleAt(timers, raceId, atTime, fn);
      }, delay)
    );
  }
  let handicapCache = { fetchedAt: 0, boats: [], sourceUrl: null, csvUrl: null };
  let ktkCache = { fetchedAt: 0, boats: [], sourceUrl: null };

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
  // given (mmsi, sailNumber, and/or tcf) without clobbering the others. tcf
  // is only ever written here for boats outside the VET register — see the
  // callers.
  function upsertBoatRegistry(name, fields) {
    if (!name) return;
    const key = name.trim().toLowerCase();
    const existing = state.boatRegistry[key] || { name: name.trim() };
    existing.name = name.trim();
    if (fields.mmsi) existing.mmsi = String(fields.mmsi).trim();
    if (fields.sailNumber) existing.sailNumber = String(fields.sailNumber).trim();
    if (fields.tcf != null) existing.tcf = fields.tcf;
    state.boatRegistry[key] = existing;
  }

  function getRegistryEntry(name) {
    return state.boatRegistry[(name || '').trim().toLowerCase()] || null;
  }

  // vetEnabled is a plugin config setting (Server -> Plugin Config), not
  // per-race and not editable from the webapp itself. Off by default — a
  // fresh install (or one that's never touched this setting) treats every
  // boat as outside VET until it's explicitly turned on.
  function isVetEnabled() {
    return !!(plugin.options && plugin.options.vetEnabled === true);
  }

  // Same pattern as vetEnabled, for KTK's KLR register.
  function isKtkEnabled() {
    return !!(plugin.options && plugin.options.ktkEnabled === true);
  }

  // Plugin config setting, same pattern as vetEnabled — off by default, not
  // per-race, not writable from the webapp itself.
  function isRaceImportEnabled() {
    return !!(plugin.options && plugin.options.raceImportEnabled === true);
  }

  // A boat only counts as "in a handicap register" for registry-TCF
  // purposes while that register is enabled and (whatever's currently
  // cached of) it actually has a matching name — disabling a register makes
  // every boat "outside" it for this purpose too, per the setting's whole
  // point. Checks both VET-tall and KTK, since a boat matched by either one
  // should be picked fresh from its own dropdown rather than carrying over
  // a remembered TCF.
  function isHandicapRegisterMatch(name) {
    const n = (name || '').trim().toLowerCase();
    if (isVetEnabled() && handicapCache.boats.some((b) => b.name.toLowerCase() === n)) return true;
    if (isKtkEnabled() && ktkCache.boats.some((b) => b.name.toLowerCase() === n)) return true;
    return false;
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
  // this radius of it — meters, configurable (plugin config,
  // markRoundingRadiusM), converted to nautical miles for distanceNm().
  // 100m by default — loose enough to tolerate AIS position jitter and the
  // 15s sampling gap (a boat doing 7kn covers about 55m between samples)
  // without needing an exact pass.
  function markRoundingRadiusNm() {
    const meters = (plugin.options && plugin.options.markRoundingRadiusM) || 100;
    return meters / 1852;
  }

  // Scans a boat's recorded track chronologically, advancing to the next
  // mark each time the track comes within rounding radius of the current
  // one — so it naturally requires marks to be rounded in course order.
  // Automatic (no manual "boat X rounded mark Y" input) by design, at the
  // cost of missing a rounding if a boat cuts far outside the radius.
  function countAutoRoundedMarks(race, boat) {
    const marks = race.course.marks;
    if (!marks.length || !boat.track || !boat.track.length) return 0;
    const radiusNm = markRoundingRadiusNm();
    let markIdx = 0;
    for (const pt of boat.track) {
      if (markIdx >= marks.length) break;
      if (distanceNm(pt, marks[markIdx]) <= radiusNm) {
        markIdx++;
      }
    }
    return markIdx;
  }

  // A committee member can also record a mark rounding by hand (with its
  // own timestamp) — for a boat with no MMSI/AIS at all, or to correct a
  // rounding the automatic track-based detection above missed. Counted the
  // same "in order" way as the automatic detection: a mark only counts if
  // every mark before it is also recorded, manually or automatically, so a
  // rounding can't be marked out of course order.
  function countManualRoundedMarks(race, boat) {
    const marks = race.course.marks;
    if (!marks.length || !boat.markTimes) return 0;
    let count = 0;
    for (const m of marks) {
      if (boat.markTimes[m.id] == null) break;
      count++;
    }
    return count;
  }

  // The higher of the two — a boat only needs one working way to record a
  // rounding, not both.
  function countRoundedMarks(race, boat) {
    return Math.max(countAutoRoundedMarks(race, boat), countManualRoundedMarks(race, boat));
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
    const start = effectiveStartTime(race, boat);
    if (!start || start > Date.now() || boat.finishTime || boat.dnf || boat.dns || race.stopTime) return null;
    if (!race.course || !race.course.finishLine) return null;
    const live = getLivePosition(boat.mmsi);
    if (!live || live.sogMs == null || live.sogMs < 0.25) return null;
    const remaining = remainingCourseDistanceNm(race, boat, live);
    if (remaining == null) return null;
    const sogKn = live.sogMs * MS_TO_KNOTS;
    const hoursRemaining = remaining.nm / sogKn;
    const estFinishTime = Date.now() + hoursRemaining * 3600 * 1000;
    const estElapsedMs = estFinishTime - start;
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

  // Attaches a live `estimate` and `roundedMarksCount` to each unfinished
  // boat without mutating the stored race — both are derived from live/
  // recorded data, never persisted as such (roundedMarksCount is derived
  // from markTimes, which is persisted; the count itself isn't).
  function raceWithEstimates(race) {
    const out = JSON.parse(JSON.stringify(race));
    Object.values(out.boats).forEach((b) => {
      const boat = race.boats[b.id];
      b.estimate = estimateFinish(race, boat);
      b.roundedMarksCount = countRoundedMarks(race, boat);
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
        const start = effectiveStartTime(race, boat);
        const elapsedMs = !boat.dnf && !boat.dns && start && start <= now ? (boat.finishTime || now) - start : null;
        const tcf = boat.tcf != null ? boat.tcf : 1.0;
        const correctedMs = elapsedMs != null ? elapsedMs * tcf : null;
        const estimate = estimateFinish(race, boat);
        const roundedMarksCount = countRoundedMarks(race, boat);
        const rankMs = boat.dnf || boat.dns ? null : boat.finishTime ? correctedMs : estimate ? estimate.estCorrectedMs : correctedMs;
        return { boat, elapsedMs, correctedMs, estimate, roundedMarksCount, rankMs };
      })
      .sort((a, b) => {
        // DNS sits below everyone else, including DNF — it never even
        // started, so it's not really "in" the race the way a DNF (which
        // did start) still arguably is.
        const aTier = a.boat.dns ? 2 : a.rankMs == null ? 1 : 0;
        const bTier = b.boat.dns ? 2 : b.rankMs == null ? 1 : 0;
        if (aTier !== bTier) return aTier - bTier;
        if (aTier !== 0) return a.boat.name.localeCompare(b.boat.name);
        // Among still-racing boats with no AIS-based ETA to fall back on
        // (elapsed-so-far alone says nothing about how much course is
        // left), a boat recorded further around the course — manually or
        // automatically — ranks ahead regardless of corrected time so far.
        // Boats WITH an estimate already have marks-remaining baked into
        // estCorrectedMs via the distance routing, so this only applies
        // when neither side has one.
        if (!a.boat.finishTime && !b.boat.finishTime && !a.estimate && !b.estimate && a.roundedMarksCount !== b.roundedMarksCount) {
          return b.roundedMarksCount - a.roundedMarksCount;
        }
        return a.rankMs - b.rankMs;
      });
  }

  // SignalK resource ids must be UUIDs (the resources-provider rejects
  // anything else) — this derives one deterministically from a stable seed
  // string, so re-publishing the same course/mark updates the same
  // resource instead of leaving a new one behind every time it's saved.
  function deterministicUuid(seed) {
    const hash = crypto.createHash('sha1').update(seed).digest('hex');
    return (
      hash.slice(0, 8) +
      '-' +
      hash.slice(8, 12) +
      '-4' +
      hash.slice(13, 16) +
      '-' +
      ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) +
      hash.slice(17, 20) +
      '-' +
      hash.slice(20, 32)
    );
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
      const put = (seed, name, pt) => app.resourcesApi.setResource('waypoints', deterministicUuid(seed), waypointResource(name, pt));
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
        await app.resourcesApi.setResource('routes', deterministicUuid(`race-${race.id}-course`), routeResource(race.name, points));
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
        if (boat.finishTime || boat.dnf || boat.dns || !boat.mmsi) return;
        const live = getLivePosition(boat.mmsi);
        if (!live) return;
        if (!boat.track) boat.track = [];
        boat.track.push({ t: Date.now(), lat: live.lat, lon: live.lon, sog: live.sogMs });
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
    Object.values(race.boats).forEach((b) => {
      b.finishTime = null;
      b.startTime = null;
      b.track = [];
      b.dnf = false;
      b.dns = false;
      b.dnfPosition = null;
    });
    saveState();
    // A call-off scheduled before the race started couldn't be armed yet
    // (armCallOffSchedule requires race.startTime) — arm it now instead of
    // discarding it.
    armCallOffSchedule(race);
  }

  // Re-arms (or clears) the timer that auto-starts a race at its
  // scheduledStart. Called on every state change that touches
  // scheduledStart, and once per race at plugin startup so a schedule set
  // before a server restart still fires.
  function armSchedule(race) {
    disarmSchedule(race.id);
    if (race.scheduledStart && !race.startTime) {
      if (race.scheduledStart - Date.now() <= 0) {
        doStart(race, race.scheduledStart);
      } else {
        scheduleAt(scheduleTimers, race.id, race.scheduledStart, () => doStart(race, race.scheduledStart));
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
      if (!boat.finishTime && !boat.dnf && !boat.dns) {
        boat.dnf = true;
        boat.dnfPosition = getLastKnownPosition(boat);
      }
    });
    saveState();
  }

  // A race with at least one boat where every boat has either finished or
  // been marked DNF/DNS has nothing left to time.
  function isRaceComplete(race) {
    const boats = Object.values(race.boats);
    if (!boats.length) return false;
    return boats.every((boat) => boat.finishTime || boat.dnf || boat.dns);
  }

  // Called after anything that could newly complete a race (a finish, a
  // DNF, or removing the one boat still racing) — calls it off
  // automatically rather than leaving the clock running with nothing left
  // to time until someone remembers to click Stop.
  function maybeAutoStop(race) {
    if (race.startTime && !race.stopTime && isRaceComplete(race)) {
      doStop(race, Date.now());
    }
  }

  // Re-arms (or clears) the timer that auto-calls-off a race at its
  // scheduledCallOff, mirroring armSchedule for the start.
  function armCallOffSchedule(race) {
    disarmCallOffSchedule(race.id);
    if (race.scheduledCallOff && race.startTime && !race.stopTime) {
      if (race.scheduledCallOff - Date.now() <= 0) {
        doStop(race, race.scheduledCallOff);
      } else {
        scheduleAt(callOffTimers, race.id, race.scheduledCallOff, () => doStop(race, race.scheduledCallOff));
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

  async function fetchKtkBoats(forceRefresh) {
    const sourceUrl = (plugin.options && plugin.options.ktkSourceUrl) || DEFAULT_KTK_SOURCE_PAGE;
    const age = Date.now() - ktkCache.fetchedAt;
    if (!forceRefresh && ktkCache.sourceUrl === sourceUrl && age < HANDICAP_CACHE_TTL_MS) {
      return ktkCache;
    }
    const res = await fetch(sourceUrl);
    if (!res.ok) {
      throw new Error(`KTK page returned HTTP ${res.status}`);
    }
    const html = await res.text();
    const boats = parseKtkHtml(html);
    ktkCache = { fetchedAt: Date.now(), boats, sourceUrl };
    return ktkCache;
  }

  async function fetchManage2SailClasses(eventUrl) {
    const res = await fetch(eventUrl);
    if (!res.ok) {
      throw new Error(`Could not load ${eventUrl}: HTTP ${res.status}`);
    }
    const html = await res.text();
    return parseManage2SailEventPage(html);
  }

  async function fetchManage2SailEntries(eventId, regattaId) {
    const url = `https://www.manage2sail.com/api/event/${encodeURIComponent(eventId)}/regattaentry?regattaId=${encodeURIComponent(regattaId)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Manage2Sail entries request failed: HTTP ${res.status}`);
    }
    const json = await res.json();
    return parseManage2SailEntries(json);
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
        // Fixed at creation, not editable afterward — switching it mid-race
        // would leave already-entered time-only finish/start values
        // ambiguous about which calendar day they meant.
        multiDay: !!(req.body && req.body.multiDay),
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
      const headers = ['Rank', 'Boat', 'Sail Number', 'MMSI', 'TCF', 'Start Time', 'Finish Time', 'Elapsed', 'Corrected', 'Status'];

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

      // Real Excel date/time values in Start/Finish (shifted the same way
      // formatLocalDateTime above does, to display as the exporting
      // browser's local wall-clock rather than the server's), not just
      // formatted text — so Elapsed and Corrected can be genuine
      // formulas referencing those cells instead of numbers baked in at
      // export time. Recalculates if a start/finish time is corrected
      // directly in the spreadsheet afterward. Left blank (by leaving
      // Finish Time blank) for a boat with no finish time — DNF, DNS, or
      // still racing — rather than showing a snapshot of elapsed-so-far
      // that would just sit there, wrong, once the file is reopened later.
      const dateNumFmt = race.multiDay ? 'yyyy-mm-dd hh:mm:ss' : 'hh:mm:ss';
      const durationNumFmt = '[h]:mm:ss';
      ranked.forEach((r, i) => {
        const status = r.boat.dns
          ? 'DNS'
          : r.boat.dnf
            ? 'DNF'
            : r.boat.finishTime
              ? 'Finished'
              : race.startTime
                ? 'Racing'
                : 'Not started';
        const rankLabel = r.boat.dns ? 'DNS' : r.boat.dnf ? 'DNF' : r.rankMs != null ? i + 1 : '';
        const start = effectiveStartTime(race, r.boat);
        const startDate = start != null ? new Date(start - tz * 60000) : null;
        const finishDate = r.boat.finishTime != null ? new Date(r.boat.finishTime - tz * 60000) : null;
        const rowNum = headerRow.number + 1 + i;
        const row = sheet.addRow([
          rankLabel,
          r.boat.name,
          r.boat.sailNumber || '',
          r.boat.mmsi || '',
          r.boat.tcf,
          startDate,
          finishDate,
          { formula: `IF(OR(F${rowNum}="",G${rowNum}=""),"",G${rowNum}-F${rowNum})` },
          { formula: `IF(H${rowNum}="","",H${rowNum}*E${rowNum})` },
          status
        ]);
        row.getCell(6).numFmt = dateNumFmt;
        row.getCell(7).numFmt = dateNumFmt;
        row.getCell(8).numFmt = durationNumFmt;
        row.getCell(9).numFmt = durationNumFmt;
      });

      const widths = [7, 24, 12, 12, 8, race.multiDay ? 17 : 12, race.multiDay ? 17 : 12, 12, 12, 12];
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

    // A standalone, self-contained backup timer: current boats/TCF/progress
    // baked in, everything else (start/stop, finishes, DNF, self-compare)
    // runs entirely client-side with no server — see buildOfflineTimerHtml.
    router.get('/races/:id/export-offline.html', async (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      ensureRaceShape(race);
      const defaultTcf = (plugin.options && plugin.options.defaultTcf) || 1.0;
      // The offline page can fetch a fresh VET-tall register on its own later
      // (the CSV export is CORS-friendly, unlike the SSCA page or
      // Manage2Sail), but it's seeded with whatever we can get right now so
      // it's useful before the first live refresh too.
      let handicapCsvUrl = null;
      let handicapBoats = [];
      if (isVetEnabled()) {
        try {
          const data = await fetchHandicapBoats();
          handicapCsvUrl = data.csvUrl;
          handicapBoats = data.boats;
        } catch (e) {
          try {
            const sourceUrl = (plugin.options && plugin.options.handicapSourceUrl) || DEFAULT_HANDICAP_SOURCE_PAGE;
            handicapCsvUrl = await resolveHandicapCsvUrl(sourceUrl);
          } catch (e2) {
            // Leave handicapCsvUrl null — the offline page's own refresh will
            // report a clear error until it's tried again with a working
            // connection.
          }
        }
      }
      // KTK's page has no CORS support (unlike the VET-tall CSV export), so
      // unlike handicapBoats above this is a one-time snapshot only — the
      // offline page can't refresh it live itself. Still seeded in, since a
      // snapshot from export time is better than nothing.
      let ktkBoats = [];
      if (isKtkEnabled()) {
        try {
          const data = await fetchKtkBoats();
          ktkBoats = data.boats;
        } catch (e) {
          // Leave ktkBoats empty — same best-effort spirit as the rest of
          // this route.
        }
      }
      const html = buildOfflineTimerHtml(race, defaultTcf, {
        vetEnabled: isVetEnabled(),
        handicapCsvUrl,
        handicapBoats,
        ktkEnabled: isKtkEnabled(),
        ktkBoats
      });
      const safeName = (race.name || 'race').replace(/[^a-z0-9\-_]+/gi, '_').slice(0, 60) || 'race';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}-offline-timer.html"`);
      res.send(html);
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

    // Sets (or, with startTime: null, clears) the race's own start time
    // directly — a correction tool, distinct from Start/Schedule Start: it
    // never touches boats' finish times, DNF, or their own start-time
    // overrides. For backdating a late "Start Race" click, or fixing the
    // recorded start without losing everything else already entered.
    router.put('/races/:id/startTime', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      const raw = req.body ? req.body.startTime : undefined;
      if (raw === null) {
        race.startTime = null;
      } else {
        const t = Number(raw);
        if (!isFinite(t) || t <= 0) {
          return res.status(400).json({ error: 'startTime must be an epoch-millisecond timestamp or null' });
        }
        race.startTime = t;
      }
      saveState();
      armCallOffSchedule(race);
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
      (race.classes || []).forEach((c) => {
        c.startTime = null;
      });
      Object.values(race.boats).forEach((b) => {
        b.finishTime = null;
        b.startTime = null;
        b.track = [];
        b.dnf = false;
        b.dns = false;
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
      const registryEntry = getRegistryEntry(name);
      const givenMmsi = ((req.body && req.body.mmsi) || '').toString().trim();
      const mmsi = givenMmsi || (registryEntry && registryEntry.mmsi) || null;
      if (mmsi) upsertBoatRegistry(name, { mmsi });
      const givenSailNumber = ((req.body && req.body.sailNumber) || '').toString().trim();
      const sailNumber = givenSailNumber || (registryEntry && registryEntry.sailNumber) || null;
      if (sailNumber) upsertBoatRegistry(name, { sailNumber });
      const defaultTcf = (plugin.options && plugin.options.defaultTcf) || 1.0;
      // A remembered TCF only applies to boats outside every enabled
      // register — a matched boat should be picked fresh from the
      // register's own dropdown rather than silently carrying over a
      // number from wherever it last raced.
      let tcf = defaultTcf;
      if (!isHandicapRegisterMatch(name) && registryEntry && registryEntry.tcf != null) {
        tcf = registryEntry.tcf;
      }
      const givenClassId = ((req.body && req.body.classId) || '').toString().trim();
      const classId = givenClassId && findClass(race, givenClassId) ? givenClassId : null;
      const boat = {
        id: makeBoatId(),
        name,
        mmsi: mmsi || null,
        sailNumber,
        tcf,
        finishTime: null,
        startTime: null,
        classId,
        track: [],
        dnf: false,
        dns: false,
        dnfPosition: null,
        markTimes: {}
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
      maybeAutoStop(race);
      saveState();
      res.json({ ok: true });
    });

    // Classes group boats for a staggered start by class (e.g. "Cruisers
    // start at 12:00, Racers at 12:15") — an alternative to setting every
    // boat's own start time by hand. A boat's own start time (if it has
    // one) still wins over its class's, same as it already won over the
    // race's single start time — see effectiveStartTime.
    router.post('/races/:id/classes', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      const name = ((req.body && req.body.name) || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      ensureRaceShape(race);
      const cls = { id: makeClassId(), name, startTime: null };
      race.classes.push(cls);
      saveState();
      res.json(raceWithEstimates(race));
    });

    router.put('/races/:id/classes/:classId', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      ensureRaceShape(race);
      const cls = findClass(race, req.params.classId);
      if (!cls) return res.status(404).json({ error: 'No such class' });
      if ('name' in (req.body || {})) {
        const name = (req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'name cannot be empty' });
        cls.name = name;
      }
      saveState();
      res.json(raceWithEstimates(race));
    });

    // Sets (or, with startTime: null, clears) this class's own start time —
    // same pattern as a boat's own start time.
    router.put('/races/:id/classes/:classId/startTime', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      ensureRaceShape(race);
      const cls = findClass(race, req.params.classId);
      if (!cls) return res.status(404).json({ error: 'No such class' });
      const raw = req.body ? req.body.startTime : undefined;
      if (raw === null) {
        cls.startTime = null;
      } else {
        const t = Number(raw);
        if (!isFinite(t) || t <= 0) {
          return res.status(400).json({ error: 'startTime must be an epoch-millisecond timestamp or null' });
        }
        cls.startTime = t;
      }
      saveState();
      res.json(raceWithEstimates(race));
    });

    router.delete('/races/:id/classes/:classId', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      ensureRaceShape(race);
      if (!findClass(race, req.params.classId)) return res.status(404).json({ error: 'No such class' });
      race.classes = race.classes.filter((c) => c.id !== req.params.classId);
      Object.values(race.boats).forEach((b) => {
        if (b.classId === req.params.classId) b.classId = null;
      });
      saveState();
      res.json(raceWithEstimates(race));
    });

    // Sets (or, with classId: null, clears) a boat's class.
    router.put('/races/:id/boats/:boatId/class', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      const boat = getBoat(race, req.params.boatId);
      if (!boat) return res.status(404).json({ error: 'No such boat' });
      const classId = (req.body || {}).classId;
      if (classId != null && !findClass(race, classId)) {
        return res.status(400).json({ error: 'No such class' });
      }
      boat.classId = classId || null;
      saveState();
      res.json(boat);
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
        // A real finish supersedes a DNF or DNS (e.g. correcting a call-off
        // that caught a boat that had actually already crossed the line).
        boat.dnf = false;
        boat.dns = false;
        boat.dnfPosition = null;
      }
      maybeAutoStop(race);
      saveState();
      res.json(boat);
    });

    // Sets (or, with startTime: null, clears) one boat's own start time,
    // overriding the race's single start time for that boat only — for a
    // staggered/pursuit start, or correcting a boat that didn't actually
    // start with the fleet.
    router.put('/races/:id/boats/:boatId/startTime', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      const boat = getBoat(race, req.params.boatId);
      if (!boat) return res.status(404).json({ error: 'No such boat' });
      const raw = req.body ? req.body.startTime : undefined;
      if (raw === null) {
        boat.startTime = null;
      } else {
        const t = Number(raw);
        if (!isFinite(t) || t <= 0) {
          return res.status(400).json({ error: 'startTime must be an epoch-millisecond timestamp or null' });
        }
        boat.startTime = t;
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
        boat.dns = false;
        boat.finishTime = null;
        boat.dnfPosition = getLastKnownPosition(boat);
      } else {
        boat.dnf = false;
        boat.dnfPosition = null;
      }
      maybeAutoStop(race);
      saveState();
      res.json(boat);
    });

    // Marks (or, with dns: false, un-marks) one boat DNS by hand — it never
    // started the race at all, as distinct from DNF (started but didn't
    // finish). Setting it also clears any finish time/DNF, since a boat
    // can't be more than one of finished/DNF/DNS at once.
    router.put('/races/:id/boats/:boatId/dns', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      const boat = getBoat(race, req.params.boatId);
      if (!boat) return res.status(404).json({ error: 'No such boat' });
      const dns = !!(req.body && req.body.dns);
      if (dns) {
        boat.dns = true;
        boat.dnf = false;
        boat.finishTime = null;
        boat.dnfPosition = null;
      } else {
        boat.dns = false;
      }
      maybeAutoStop(race);
      saveState();
      res.json(boat);
    });

    // Manual mark-rounding: a committee member records (or clears) the
    // moment a boat rounded a specific mark, independent of the automatic
    // AIS track-based detection — for a boat with no MMSI/AIS at all, or to
    // correct a rounding the automatic detection missed. See
    // countManualRoundedMarks/countRoundedMarks for how the two combine.
    router.put('/races/:id/boats/:boatId/markTimes/:markId', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      const boat = getBoat(race, req.params.boatId);
      if (!boat) return res.status(404).json({ error: 'No such boat' });
      const mark = race.course.marks.find((m) => m.id === req.params.markId);
      if (!mark) return res.status(404).json({ error: 'No such mark' });
      if (!boat.track) boat.track = [];
      // Drop any earlier manually-added point for this exact mark first,
      // whether we're about to replace it or just clearing — tagged with
      // markId so this can never touch a genuine AIS-recorded sample.
      boat.track = boat.track.filter((pt) => pt.markId !== mark.id);
      const raw = req.body ? req.body.time : undefined;
      if (raw === null) {
        delete boat.markTimes[mark.id];
      } else {
        const t = Number(raw);
        if (!isFinite(t) || t <= 0) {
          return res.status(400).json({ error: 'time must be an epoch-millisecond timestamp or null' });
        }
        boat.markTimes[mark.id] = t;
        // Record where the boat was at that moment too — its live position
        // if we have one (accurate, and consistent with its recorded AIS
        // track), otherwise the mark's own position as a reasonable stand-
        // in (rounding a mark means being at it). Either way this is what
        // lets a manually-recorded rounding show up on the replay chart,
        // even for a boat with no AIS at all.
        const live = getLivePosition(boat.mmsi);
        const pos = live || { lat: mark.lat, lon: mark.lon };
        boat.track.push({ t, lat: pos.lat, lon: pos.lon, markId: mark.id });
        boat.track.sort((a, b) => a.t - b.t);
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

    router.put('/races/:id/boats/:boatId/sailNumber', (req, res) => {
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      const boat = getBoat(race, req.params.boatId);
      if (!boat) return res.status(404).json({ error: 'No such boat' });
      const sailNumber = ((req.body && req.body.sailNumber) || '').toString().trim();
      boat.sailNumber = sailNumber || null;
      if (boat.sailNumber) upsertBoatRegistry(boat.name, { sailNumber: boat.sailNumber });
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

    // Same pattern as vet-enabled, for KTK's KLR register.
    router.get('/ktk-enabled', (req, res) => {
      res.json({ enabled: isKtkEnabled() });
    });

    // Lets the course editor offer existing SignalK waypoints (e.g. ones
    // already placed on a chart plotter) as start/mark/finish positions,
    // instead of only typing lat/lon by hand. Best-effort, same spirit as
    // publishCourseResources — silently returns none if this server has no
    // resources provider registered, rather than failing the whole course
    // editor over it.
    router.get('/waypoints', async (req, res) => {
      if (!app.resourcesApi || typeof app.resourcesApi.listResources !== 'function') {
        return res.json({ waypoints: [] });
      }
      try {
        const data = await app.resourcesApi.listResources('waypoints', {});
        const waypoints = Object.keys(data || {})
          .map((id) => {
            const r = data[id] || {};
            const coords = r.feature && r.feature.geometry && r.feature.geometry.coordinates;
            if (!Array.isArray(coords) || coords.length < 2) return null;
            return { id, name: r.name || id, lon: coords[0], lat: coords[1] };
          })
          .filter(Boolean);
        res.json({ waypoints });
      } catch (e) {
        res.json({ waypoints: [] });
      }
    });

    // Background chart tiles for the webapp's course/replay map — same
    // "best-effort, never fails the caller" spirit as /waypoints. Only
    // tilelayer-type chart resources are usable here (a plain XYZ tile URL
    // template); WMS/WMTS/mapstyleJSON/S-57 sources need more than a tile
    // layer to render and are left for a future version. The webapp falls
    // back to public OpenStreetMap/OpenSeaMap tiles when this returns none,
    // same as freeboard-sk itself does with no chart provider installed.
    router.get('/charts', async (req, res) => {
      if (!app.resourcesApi || typeof app.resourcesApi.listResources !== 'function') {
        return res.json({ charts: [] });
      }
      try {
        const data = await app.resourcesApi.listResources('charts', {});
        const charts = Object.keys(data || {})
          .map((id) => {
            const c = data[id] || {};
            if (c.type !== 'tilelayer' || !c.url) return null;
            return { id, name: c.name || id, url: c.url, minzoom: c.minzoom, maxzoom: c.maxzoom, bounds: c.bounds };
          })
          .filter(Boolean);
        res.json({ charts });
      } catch (e) {
        res.json({ charts: [] });
      }
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
      // Remembered across races only for boats outside every enabled
      // register — see the note on upsertBoatRegistry/isHandicapRegisterMatch
      // above.
      if (!isHandicapRegisterMatch(boat.name)) upsertBoatRegistry(boat.name, { tcf });
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

    router.get('/ktk-source', async (req, res) => {
      try {
        const force = req.query.refresh === 'true' || req.query.refresh === '1';
        const data = await fetchKtkBoats(force);
        res.json(data);
      } catch (e) {
        res.status(502).json({ error: 'Could not load KTK register: ' + e.message });
      }
    });

    // Plugin config setting (Server -> Plugin Config), same pattern as
    // vet-enabled — the webapp only reads it to know whether to show the
    // import section at all.
    router.get('/race-import-enabled', (req, res) => {
      res.json({ enabled: isRaceImportEnabled() });
    });

    // Resolves a Manage2Sail event URL to its classes, so the webapp can
    // offer a picker before importing anything.
    router.get('/import/manage2sail/classes', async (req, res) => {
      if (!isRaceImportEnabled()) return res.status(403).json({ error: 'Race import is disabled in the plugin settings' });
      const eventUrl = ((req.query.eventUrl || '') + '').trim();
      if (!eventUrl) return res.status(400).json({ error: 'eventUrl is required' });
      try {
        const { eventId, classes } = await fetchManage2SailClasses(eventUrl);
        res.json({ eventId, classes });
      } catch (e) {
        res.status(502).json({ error: 'Could not read classes from Manage2Sail: ' + e.message });
      }
    });

    // The handicap systems this plugin can convert to a usable TCF — the
    // webapp uses this to label the disambiguation picker when a class's
    // system can't be resolved automatically (see resolveHandicapSystem).
    router.get('/import/manage2sail/handicap-systems', (req, res) => {
      if (!isRaceImportEnabled()) return res.status(403).json({ error: 'Race import is disabled in the plugin settings' });
      res.json({ systems: HANDICAP_SYSTEMS.map((s) => ({ key: s.key, label: s.label })) });
    });

    // Imports every entry from the given class(es) of a Manage2Sail event as
    // boats in this race — a new boat per entry (name falls back from
    // BoatName to TeamName/SkipperName). The published Hcp number is
    // converted to TCF via whichever handicap system the class turns out to
    // use (see resolveHandicapSystem) — pass systemOverrides: {classId: key}
    // to pick one explicitly for a class flagged in needsSystemChoice on a
    // prior call, rather than re-guessing. Re-importing updates TCF on
    // boats already added by name rather than duplicating them.
    router.post('/races/:id/import/manage2sail', async (req, res) => {
      if (!isRaceImportEnabled()) return res.status(403).json({ error: 'Race import is disabled in the plugin settings' });
      const race = getRace(req.params.id);
      if (!race) return res.status(404).json({ error: 'No such race' });
      const eventId = ((req.body && req.body.eventId) || '').toString().trim();
      const classIds = Array.isArray(req.body && req.body.classIds) ? req.body.classIds : [];
      const systemOverrides = (req.body && req.body.systemOverrides) || {};
      if (!eventId || !classIds.length) {
        return res.status(400).json({ error: 'eventId and at least one classId are required' });
      }
      const existingByName = new Map(Object.values(race.boats).map((b) => [b.name.trim().toLowerCase(), b]));
      let added = 0;
      let updated = 0;
      let skipped = 0;
      const conversions = [];
      const needsSystemChoice = [];
      try {
        for (const regattaId of classIds) {
          const { hcpName, entries, skipped: classSkipped } = await fetchManage2SailEntries(eventId, regattaId);
          skipped += classSkipped;
          if (!entries.length) continue;
          const overrideKey = systemOverrides[regattaId];
          let systemKey = overrideKey && findHandicapSystem(overrideKey) ? overrideKey : null;
          if (!systemKey) {
            const resolution = resolveHandicapSystem(
              hcpName,
              entries.map((e) => e.hcp)
            );
            if (!resolution.resolved) {
              needsSystemChoice.push({ classId: regattaId, hcpName, candidates: resolution.candidates });
              continue;
            }
            systemKey = resolution.resolved;
          }
          const system = findHandicapSystem(systemKey);
          conversions.push({ classId: regattaId, hcpName, system: systemKey });
          entries.forEach((entry) => {
            const tcf = Math.round(system.convert(entry.hcp) * 1000) / 1000;
            const key = entry.name.toLowerCase();
            const existing = existingByName.get(key);
            if (existing) {
              existing.tcf = tcf;
              existing.sailNumber = entry.sailNumber || existing.sailNumber;
              updated++;
            } else {
              const boat = {
                id: makeBoatId(),
                name: entry.name,
                mmsi: null,
                sailNumber: entry.sailNumber || null,
                tcf,
                finishTime: null,
                startTime: null,
                track: [],
                dnf: false,
                dns: false,
                dnfPosition: null,
                markTimes: {}
              };
              race.boats[boat.id] = boat;
              existingByName.set(key, boat);
              added++;
            }
          });
        }
      } catch (e) {
        return res.status(502).json({ error: 'Could not import from Manage2Sail: ' + e.message });
      }
      saveState();
      res.json({ race: raceWithEstimates(race), added, updated, skipped, conversions, needsSystemChoice });
    });
  };

  return plugin;
};
