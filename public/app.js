(function () {
  const API = '/plugins/race-control';
  const SK_API = '/signalk/v1/api';

  let races = []; // race summaries from GET /races
  let activeRaceId = null;
  let raceState = null; // full race object for activeRaceId, or null
  let vesselSuggestions = []; // [{name, mmsi}] from AIS/self, for the add-boat autocomplete
  let boatRegistry = []; // [{name, mmsi}] cross-race memory persisted server-side
  let nameSuggestionPool = []; // [{name, mmsi}] combined VET-register + registry + vessel names
  let suggestionItems = []; // currently-shown filtered suggestions
  let suggestionActiveIndex = -1;
  let handicapBoats = [];
  let handicapVersion = 0; // bumped each successful VET-register (or KTK) load
  let vetEnabled = false; // plugin config setting (Server -> Plugin Config), read-only here; off by default
  let ktkBoats = []; // [{name, vets: [{label, value}]}] from KTK's KLR register — same shape as handicapBoats
  let ktkEnabled = false; // plugin config setting, same pattern as vetEnabled
  let raceImportEnabled = false; // plugin config setting, same pattern as vetEnabled
  let importEventId = null; // Manage2Sail event id from the last successful "Find Classes" lookup
  let importClasses = []; // [{id, name}] from that same lookup
  let importSystemOverrides = {}; // classId -> handicap system key, from the disambiguation picker
  let importHandicapSystems = null; // [{key, label}], fetched lazily on first ambiguity
  let startLineRefs = null; // [pointRefs, pointRefs] or null
  let finishLineRefs = null;
  let markRefs = []; // [pointRefs, ...]
  let classRowRefs = new Map(); // classId -> row refs, built once and updated in place (same pattern as the boat table's own rows)
  let lastCourseFormRaceId = undefined; // tracks which race the course form reflects
  let replayLive = true;
  let replayTime = Date.now();
  let replayPlaying = false;
  let replaySpeed = 10; // 1x-60x, simulated seconds of replay time per real second
  let replayPlayTimer = null;
  let replayPlayLastTick = null;
  let waypoints = []; // [{id, name, lat, lon}] from SignalK resources, for the course editor's "Pick a waypoint" dropdown
  // Every named OpenSeaMap seamark (buoy/beacon/light/mark) Overpass has
  // returned for this chart session, keyed loosely by the map area(s)
  // already fetched — see ensureSeamarkCache. Both the name autocomplete
  // and the pick-on-map snap read from this instead of each firing their
  // own live Overpass query, so panning/zooming the chart once covers
  // both for as long as the session lasts (marks don't move).
  let seamarkCache = []; // [{name, lat, lon, source: 'osm'}]
  let seamarkCacheBounds = null; // L.LatLngBounds already covered by seamarkCache
  let seamarkCacheFetch = null; // in-flight ensureSeamarkCache promise, so a rapid pan/zoom doesn't fire overlapping queries
  let chartMap = null; // Leaflet map, created lazily once the chart section is first expanded
  let chartLayerGroup = null; // holds everything renderChart() redraws, cleared and rebuilt each call
  let chartActiveRaceId; // which race's bounds were last auto-fit, so switching races re-fits once
  let chartFitDone = false;
  let lastChartBoundsPts = []; // course/waypoint/track points from the latest render, for the one-time initial auto-fit
  let lastCourseOnlyBoundsPts = []; // just this race's own start/finish/marks, for the recenter button
  let mapPickTarget = null; // { latInput, lonInput, btn, onPositionChanged } while armed, else null

  const raceSelect = document.getElementById('raceSelect');
  const newRaceBtn = document.getElementById('newRaceBtn');
  const deleteRaceBtn = document.getElementById('deleteRaceBtn');
  const exportBtn = document.getElementById('exportBtn');
  const exportOfflineBtn = document.getElementById('exportOfflineBtn');
  const newRaceForm = document.getElementById('newRaceForm');
  const newRaceNameInput = document.getElementById('newRaceName');
  const newRaceMultiDayInput = document.getElementById('newRaceMultiDay');
  const createRaceBtn = document.getElementById('createRaceBtn');
  const cancelNewRaceBtn = document.getElementById('cancelNewRaceBtn');
  const raceArea = document.getElementById('raceArea');
  const clockEl = document.getElementById('clock');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const resumeBtn = document.getElementById('resumeBtn');
  const resetBtn = document.getElementById('resetBtn');
  const raceStartInput = document.getElementById('raceStartInput');
  const raceStartNowBtn = document.getElementById('raceStartNowBtn');
  const raceStartClearBtn = document.getElementById('raceStartClearBtn');
  const scheduleInput = document.getElementById('scheduleInput');
  const scheduleBtn = document.getElementById('scheduleBtn');
  const cancelScheduleBtn = document.getElementById('cancelScheduleBtn');
  const callOffInput = document.getElementById('callOffInput');
  const scheduleCallOffBtn = document.getElementById('scheduleCallOffBtn');
  const cancelCallOffBtn = document.getElementById('cancelCallOffBtn');
  const statusEl = document.getElementById('statusLine');
  const vetStatusLine = document.getElementById('vetStatusLine');
  const vetStatusText = document.getElementById('vetStatusText');
  const vetRefreshBtn = document.getElementById('vetRefreshBtn');
  const vetAlternativesTh = document.getElementById('vetAlternativesTh');
  const ktkStatusLine = document.getElementById('ktkStatusLine');
  const ktkStatusText = document.getElementById('ktkStatusText');
  const ktkRefreshBtn = document.getElementById('ktkRefreshBtn');
  const addBoatRow = document.getElementById('addBoatRow');
  const addBoatName = document.getElementById('addBoatName');
  const addBoatClass = document.getElementById('addBoatClass');
  const addBoatBtn = document.getElementById('addBoatBtn');
  const classSection = document.getElementById('classSection');
  const classToggleBtn = document.getElementById('classToggleBtn');
  const classBody = document.getElementById('classBody');
  const classRowsEl = document.getElementById('classRows');
  const addClassName = document.getElementById('addClassName');
  const addClassBtn = document.getElementById('addClassBtn');
  const boatsTable = document.getElementById('boatsTable');
  const boatsBody = document.getElementById('boatsBody');
  const emptyMsg = document.getElementById('emptyMsg');
  const noRacesMsg = document.getElementById('noRacesMsg');
  const addBoatSuggestions = document.getElementById('addBoatSuggestions');
  const courseSection = document.getElementById('courseSection');
  const courseToggleBtn = document.getElementById('courseToggleBtn');
  const courseBody = document.getElementById('courseBody');
  const positionsToggleBtn = document.getElementById('positionsToggleBtn');
  const positionsBody = document.getElementById('positionsBody');
  const startLineRowsEl = document.getElementById('startLineRows');
  const finishLineRowsEl = document.getElementById('finishLineRows');
  const marksRowsEl = document.getElementById('marksRows');
  const addMarkBtn = document.getElementById('addMarkBtn');
  const saveCourseBtn = document.getElementById('saveCourseBtn');
  const courseStatusText = document.getElementById('courseStatusText');
  const courseChart = document.getElementById('courseChart');
  const chartEmptyMsg = document.getElementById('chartEmptyMsg');
  const replayControls = document.getElementById('replayControls');
  const replaySlider = document.getElementById('replaySlider');
  const replayTimeLabel = document.getElementById('replayTimeLabel');
  const replayPlayBtn = document.getElementById('replayPlayBtn');
  const replaySpeedSlider = document.getElementById('replaySpeedSlider');
  const replaySpeedLabel = document.getElementById('replaySpeedLabel');
  const replayLiveBtn = document.getElementById('replayLiveBtn');
  const startTimerSection = document.getElementById('startTimerSection');
  const startTimerToggleBtn = document.getElementById('startTimerToggleBtn');
  const startTimerBody = document.getElementById('startTimerBody');
  const startCountdownValue = document.getElementById('startCountdownValue');
  const startDtlValue = document.getElementById('startDtlValue');
  const startEtaValue = document.getElementById('startEtaValue');
  const startBurnValue = document.getElementById('startBurnValue');
  const startTimerNote = document.getElementById('startTimerNote');
  const windShiftBar = document.getElementById('windShiftBar');
  const windShiftValue = document.getElementById('windShiftValue');
  const windShiftTack = document.getElementById('windShiftTack');
  const windShiftTwd = document.getElementById('windShiftTwd');
  const raceImportSection = document.getElementById('raceImportSection');
  const raceImportToggleBtn = document.getElementById('raceImportToggleBtn');
  const raceImportBody = document.getElementById('raceImportBody');
  const importEventUrl = document.getElementById('importEventUrl');
  const importFindClassesBtn = document.getElementById('importFindClassesBtn');
  const importClassesList = document.getElementById('importClassesList');
  const importSystemChoices = document.getElementById('importSystemChoices');
  const importBoatsBtn = document.getElementById('importBoatsBtn');
  const importStatusText = document.getElementById('importStatusText');

  function unwrapValue(x) {
    if (x && typeof x === 'object' && 'value' in x) return x.value;
    return x;
  }

  function fmtDuration(ms) {
    if (ms == null || ms < 0 || !isFinite(ms)) return '--:--:--';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  // Same as fmtDuration but signed, for "vs self" comparisons where a
  // negative value (behind) is a normal, meaningful result rather than
  // "not available yet".
  function formatSignedDuration(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    const totalSec = Math.floor(Math.abs(ms) / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return (ms < 0 ? '-' : '+') + `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  // The race clock's "now" — frozen at stopTime while a race is stopped, so
  // elapsed/corrected times stop advancing without needing every call site
  // to know about the stop state.
  function raceNow() {
    return (raceState && raceState.stopTime) || Date.now();
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  // HH:MM:SS of the given timestamp, for the per-boat finish <input type=time>.
  function tsToTimeInputValue(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  // Combines a "HH:MM:SS" wall-clock value with a reference date to get an
  // absolute timestamp. baseTs defaults to the race's start time, or today
  // if the race hasn't started yet — only meaningful for single-day races; a
  // multi-day race uses full date+time inputs instead (see
  // tsToDateTimeInputValue / dateTimeInputValueToTs) so there's never more
  // than one day's ambiguity to resolve here.
  //
  // rollover (default true) pushes the result to the next calendar day when
  // the entered time is earlier than the reference — correct for a finish
  // time, which must come after the start it's measured from. A start time
  // (the race's own, or one boat's individual override) has no such "must
  // be after" constraint — an earlier clock reading there just means
  // earlier the same day (e.g. correcting/backdating it, or a pursuit start
  // where a boat starts before the race's nominal start) — so callers
  // editing a start time must pass rollover: false.
  function timeInputValueToTs(value, baseTs, rollover) {
    if (!value) return null;
    const parts = value.split(':').map(Number);
    const [h, m, s] = [parts[0] || 0, parts[1] || 0, parts[2] || 0];
    const refTs = baseTs != null ? baseTs : raceState && raceState.startTime;
    const base = refTs ? new Date(refTs) : new Date();
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, s, 0);
    let ts = d.getTime();
    if (rollover !== false && refTs && ts < refTs) {
      ts += 24 * 3600 * 1000;
    }
    return ts;
  }

  // YYYY-MM-DDTHH:mm:ss of the given timestamp in local time, for the
  // per-boat finish/start <input type=datetime-local> used by multi-day
  // races — datetime-local always means "local time" with no timezone
  // component, so no explicit offset math is needed here.
  function tsToDateTimeInputValue(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return (
      `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
      `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    );
  }

  function dateTimeInputValueToTs(value) {
    if (!value) return null;
    const ts = new Date(value).getTime();
    return isFinite(ts) ? ts : null;
  }

  async function fetchJSON(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch (e) {
        // ignore
      }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('error', !!isError);
  }

  function setVetStatus(msg, isError) {
    vetStatusText.textContent = msg || '';
    vetStatusText.classList.toggle('error', !!isError);
  }

  function setKtkStatus(msg, isError) {
    ktkStatusText.textContent = msg || '';
    ktkStatusText.classList.toggle('error', !!isError);
  }

  // Vessels are only used as autocomplete suggestions when adding a boat
  // (name + MMSI hint) — a race's boat list is otherwise entered explicitly,
  // not auto-populated from AIS.
  async function loadVessels() {
    try {
      const all = await fetchJSON(`${SK_API}/vessels`);
      const suggestions = [];
      Object.keys(all || {}).forEach((context) => {
        const v = all[context] || {};
        const rawName = unwrapValue(v.name);
        const rawMmsi = unwrapValue(v.mmsi);
        if (rawName && String(rawName).trim()) {
          suggestions.push({ name: String(rawName).trim(), mmsi: rawMmsi || '' });
        }
      });
      vesselSuggestions = suggestions;
      rebuildNameSuggestionPool();
    } catch (e) {
      setStatus('Could not load boat list from SignalK: ' + e.message, true);
    }
  }

  // Merges three sources into one suggestion list, keyed by name: the VET
  // register (names only), the cross-race boat registry (name + remembered
  // MMSI), and live AIS/self vessels (name + current MMSI, freshest so it
  // wins last). Later sources overwrite an earlier entry's MMSI when they
  // have one, but never blank out an MMSI an earlier source already found.
  function rebuildNameSuggestionPool() {
    const byName = new Map();
    function upsert(name, mmsi) {
      const key = name.toLowerCase();
      const existing = byName.get(key);
      if (existing) {
        if (mmsi) existing.mmsi = mmsi;
      } else {
        byName.set(key, { name, mmsi: mmsi || '' });
      }
    }
    if (vetEnabled) handicapBoats.forEach((b) => upsert(b.name, ''));
    if (ktkEnabled) ktkBoats.forEach((b) => upsert(b.name, ''));
    boatRegistry.forEach((b) => upsert(b.name, b.mmsi));
    vesselSuggestions.forEach((v) => upsert(v.name, v.mmsi));
    nameSuggestionPool = Array.from(byName.values());
  }

  async function loadBoatRegistry() {
    try {
      const data = await fetchJSON(`${API}/boat-registry`);
      boatRegistry = data.boats || [];
      rebuildNameSuggestionPool();
    } catch (e) {
      // Non-fatal — MMSI auto-fill from history just won't be available.
    }
  }

  function findMmsiByName(name) {
    const n = name.trim().toLowerCase();
    const hit = nameSuggestionPool.find((s) => s.name.toLowerCase() === n && s.mmsi);
    return hit ? hit.mmsi : null;
  }

  // Custom dropdown instead of a native <datalist>, because datalist only
  // matches from the start of the value in most browsers — this matches
  // anywhere in the name (e.g. "21" or "solli" both find "RS 21 Solli").
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function hideSuggestions() {
    addBoatSuggestions.hidden = true;
    addBoatSuggestions.innerHTML = '';
    suggestionItems = [];
    suggestionActiveIndex = -1;
  }

  function renderSuggestionActive() {
    Array.from(addBoatSuggestions.children).forEach((el, i) => {
      el.classList.toggle('active', i === suggestionActiveIndex);
    });
  }

  function selectSuggestion(item) {
    addBoatName.value = item.name;
    hideSuggestions();
    addBoatName.focus();
  }

  function showSuggestionsFor(query) {
    const q = query.trim().toLowerCase();
    if (!q) {
      hideSuggestions();
      return;
    }
    const matches = nameSuggestionPool.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 20);
    suggestionItems = matches;
    suggestionActiveIndex = -1;
    if (!matches.length) {
      hideSuggestions();
      return;
    }
    addBoatSuggestions.innerHTML = '';
    matches.forEach((item) => {
      const div = document.createElement('div');
      div.className = 'suggestion-item';
      const idx = item.name.toLowerCase().indexOf(q);
      if (idx === -1) {
        div.textContent = item.name;
      } else {
        div.innerHTML =
          escapeHtml(item.name.slice(0, idx)) +
          '<mark>' +
          escapeHtml(item.name.slice(idx, idx + q.length)) +
          '</mark>' +
          escapeHtml(item.name.slice(idx + q.length));
      }
      // mousedown (not click) fires before the input's blur, so the
      // dropdown doesn't close itself out from under the click.
      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectSuggestion(item);
      });
      addBoatSuggestions.appendChild(div);
    });
    addBoatSuggestions.hidden = false;
  }

  // Whether the VET-tall register is used at all is a plugin config setting
  // (Server -> Plugin Config), not something the webapp can change — this
  // just reads it once at startup to decide whether to fetch/offer it.
  async function loadVetEnabled() {
    try {
      const data = await fetchJSON(`${API}/vet-enabled`);
      vetEnabled = data.enabled === true;
    } catch (e) {
      vetEnabled = false;
    }
    // When disabled, every trace of VET is removed from the webapp rather
    // than shown as a disabled/placeholder state — the status line (register
    // status text + refresh link) disappears entirely. The "Handicap
    // alternatives" column is shared with KTK, so it's only hidden once
    // both are off — see loadKtkEnabled.
    vetStatusLine.hidden = !vetEnabled;
    vetAlternativesTh.hidden = !vetEnabled && !ktkEnabled;
  }

  // Same pattern as loadVetEnabled, for KTK's KLR register.
  async function loadKtkEnabled() {
    try {
      const data = await fetchJSON(`${API}/ktk-enabled`);
      ktkEnabled = data.enabled === true;
    } catch (e) {
      ktkEnabled = false;
    }
    ktkStatusLine.hidden = !ktkEnabled;
    vetAlternativesTh.hidden = !vetEnabled && !ktkEnabled;
  }

  // Same pattern as loadVetEnabled — when disabled, the whole import
  // section is removed rather than shown disabled.
  async function loadRaceImportEnabled() {
    try {
      const data = await fetchJSON(`${API}/race-import-enabled`);
      raceImportEnabled = data.enabled === true;
    } catch (e) {
      raceImportEnabled = false;
    }
  }

  // Best-effort, like the underlying resourcesApi calls it wraps — an empty
  // list (no resources provider registered, or the request fails) just
  // means the course editor's "Pick a waypoint" dropdowns have nothing to
  // offer, not a failure worth surfacing.
  async function loadWaypoints() {
    try {
      const data = await fetchJSON(`${API}/waypoints`);
      waypoints = data.waypoints || [];
    } catch (e) {
      waypoints = [];
    }
  }

  async function loadHandicapRegister(force) {
    if (!vetEnabled) return;
    try {
      setVetStatus('Loading VET register…');
      const data = await fetchJSON(`${API}/handicap-source${force ? '?refresh=true' : ''}`);
      handicapBoats = data.boats || [];
      handicapVersion++;
      rebuildNameSuggestionPool();
      setVetStatus(`VET register: ${handicapBoats.length} boats loaded.`);
    } catch (e) {
      setVetStatus('Could not load VET register: ' + e.message, true);
    }
  }

  async function loadKtkRegister(force) {
    if (!ktkEnabled) return;
    try {
      setKtkStatus('Loading KTK register…');
      const data = await fetchJSON(`${API}/ktk-source${force ? '?refresh=true' : ''}`);
      ktkBoats = data.boats || [];
      handicapVersion++;
      rebuildNameSuggestionPool();
      setKtkStatus(`KTK register: ${ktkBoats.length} boats loaded.`);
    } catch (e) {
      setKtkStatus('Could not load KTK register: ' + e.message, true);
    }
  }

  async function loadRacesList() {
    try {
      const data = await fetchJSON(`${API}/races`);
      races = data.races || [];
      if (!activeRaceId || !races.some((r) => r.id === activeRaceId)) {
        activeRaceId = data.currentRaceId && races.some((r) => r.id === data.currentRaceId) ? data.currentRaceId : races.length ? races[races.length - 1].id : null;
      }
      setStatus('');
    } catch (e) {
      setStatus('Could not reach race-control plugin: ' + e.message, true);
    }
  }

  async function loadRaceState() {
    if (!activeRaceId) {
      raceState = null;
    } else {
      try {
        raceState = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}`);
      } catch (e) {
        raceState = null;
        setStatus('Could not load race: ' + e.message, true);
      }
    }
    // Only rebuild the course form when we've actually switched to a
    // different race (or none) — never on a background poll of the same
    // race, so it can't interrupt someone mid-edit.
    const id = raceState ? raceState.id : null;
    if (id !== lastCourseFormRaceId) {
      loadCourseFormFromRace();
      setCourseStatus('');
      lastCourseFormRaceId = id;
      // A running replay is specific to whichever race's track it was
      // playing through — switching races (or to none) leaves it with
      // nothing sensible to keep advancing into.
      stopReplayPlayback();
      replayLive = true;
    }
  }

  // Native prompt()/confirm() dialogs are unreliable in embedded SignalK
  // webviews (chartplotters, Kip, tablet browsers) and in automated
  // testing — they can silently no-op instead of showing anything. All
  // "are you sure" / "name it" interactions use in-page UI instead.
  function openNewRaceForm() {
    newRaceForm.hidden = false;
    newRaceNameInput.value = '';
    newRaceMultiDayInput.checked = false;
    newRaceNameInput.focus();
  }

  function closeNewRaceForm() {
    newRaceForm.hidden = true;
  }

  async function submitNewRace() {
    const name = newRaceNameInput.value.trim();
    if (!name) {
      setStatus('Race name cannot be empty.', true);
      newRaceNameInput.focus();
      return;
    }
    try {
      const data = await fetchJSON(`${API}/races`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, multiDay: newRaceMultiDayInput.checked })
      });
      activeRaceId = data.race.id;
      closeNewRaceForm();
      await loadRacesList();
      await loadRaceState();
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function performDeleteRace() {
    if (!activeRaceId || !raceState) return;
    try {
      await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}`, { method: 'DELETE' });
      activeRaceId = null;
      await loadRacesList();
      await loadRaceState();
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  // Content-Disposition: attachment on the export response means a plain
  // top-level navigation downloads the file without actually leaving this
  // page — no need for a temporary <a> element or window.open.
  function exportRace() {
    if (!activeRaceId) return;
    const tzOffsetMinutes = new Date().getTimezoneOffset();
    window.location.href = `${API}/races/${encodeURIComponent(activeRaceId)}/export.xlsx?tzOffsetMinutes=${tzOffsetMinutes}`;
  }

  function exportOfflineTimer() {
    if (!activeRaceId) return;
    window.location.href = `${API}/races/${encodeURIComponent(activeRaceId)}/export-offline.html`;
  }

  // Click once to arm, click again within a few seconds to confirm — an
  // in-page substitute for window.confirm() (see note above).
  function armConfirm(button, idleLabel, confirmLabel, onConfirm) {
    let armed = false;
    let timer = null;
    function disarm() {
      armed = false;
      clearTimeout(timer);
      button.textContent = idleLabel;
      button.classList.remove('confirming');
    }
    button.addEventListener('click', () => {
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

  async function selectRace(id) {
    activeRaceId = id;
    fetchJSON(`${API}/races/${encodeURIComponent(id)}/select`, { method: 'POST' }).catch(() => {});
    await loadRaceState();
    render();
  }

  async function startRace() {
    if (!activeRaceId) return;
    try {
      raceState = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/start`, { method: 'POST' });
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function performResetRace() {
    if (!activeRaceId) return;
    try {
      raceState = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/reset`, { method: 'POST' });
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  // Sets (or, with null, clears) the race's own start time directly — a
  // correction tool, distinct from Start Race: it never touches boats'
  // finish times, DNF, or their own start-time overrides. For backdating a
  // late "Start Race" click, or fixing the recorded start without losing
  // anything else already entered.
  async function setRaceStartTime(ts) {
    if (!activeRaceId) return;
    try {
      raceState = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/startTime`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startTime: ts })
      });
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function stopRace() {
    if (!activeRaceId) return;
    try {
      raceState = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/stop`, { method: 'POST' });
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function resumeRace() {
    if (!activeRaceId) return;
    try {
      raceState = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/resume`, { method: 'POST' });
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function scheduleCallOff() {
    if (!activeRaceId) return;
    if (!callOffInput.value) {
      setStatus('Pick a date/time to schedule the call-off.', true);
      return;
    }
    // A single-day race only needs a time — "today" (rolling to tomorrow
    // if that time's already passed, since this is scheduling something
    // ahead) is the only sensible date for a call-off anyway.
    const ts = raceState && raceState.multiDay ? dateTimeInputValueToTs(callOffInput.value) : timeInputValueToTs(callOffInput.value, Date.now(), true);
    if (!isFinite(ts)) {
      setStatus('Invalid call-off time.', true);
      return;
    }
    try {
      raceState = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/schedule-call-off`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time: ts })
      });
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function cancelCallOffSchedule() {
    if (!activeRaceId) return;
    try {
      raceState = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/schedule-call-off/cancel`, {
        method: 'POST'
      });
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function setDnf(boatId, dnf) {
    if (!activeRaceId) return;
    try {
      const boat = await fetchJSON(
        `${API}/races/${encodeURIComponent(activeRaceId)}/boats/${encodeURIComponent(boatId)}/dnf`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dnf })
        }
      );
      raceState.boats[boatId] = boat;
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  // Did Not Start — distinct from DNF (started but didn't finish).
  async function setDns(boatId, dns) {
    if (!activeRaceId) return;
    try {
      const boat = await fetchJSON(
        `${API}/races/${encodeURIComponent(activeRaceId)}/boats/${encodeURIComponent(boatId)}/dns`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dns })
        }
      );
      raceState.boats[boatId] = boat;
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function toggleSelf(boatId) {
    if (!activeRaceId || !raceState) return;
    const nextSelf = raceState.selfBoatId === boatId ? null : boatId;
    try {
      raceState = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/self`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boatId: nextSelf })
      });
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function scheduleRace() {
    if (!activeRaceId) return;
    if (!scheduleInput.value) {
      setStatus('Pick a date/time to schedule the start.', true);
      return;
    }
    // Unlike the call-off, a scheduled start is often set well ahead of
    // race day itself (e.g. scheduling Saturday's start on Wednesday) —
    // always needs a real date, regardless of whether the race itself is
    // single- or multi-day.
    const ts = dateTimeInputValueToTs(scheduleInput.value);
    if (!isFinite(ts)) {
      setStatus('Invalid scheduled start time.', true);
      return;
    }
    try {
      raceState = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startTime: ts })
      });
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function cancelSchedule() {
    if (!activeRaceId) return;
    try {
      raceState = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/schedule/cancel`, {
        method: 'POST'
      });
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function addBoat() {
    if (!activeRaceId) return;
    const name = addBoatName.value.trim();
    if (!name) {
      setStatus('Enter a boat name to add.', true);
      addBoatName.focus();
      return;
    }
    // MMSI is looked up silently (from AIS or a previous race's entry for
    // this name) rather than typed at add time — it's only ever hand-edited
    // per boat afterward, in the table row.
    const mmsi = findMmsiByName(name);
    const classId = addBoatClass.value || null;
    try {
      const boat = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/boats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mmsi, classId })
      });
      raceState.boats[boat.id] = boat;
      addBoatName.value = '';
      addBoatName.focus();
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function addClass() {
    if (!activeRaceId) return;
    const name = addClassName.value.trim();
    if (!name) {
      setStatus('Enter a class name to add.', true);
      addClassName.focus();
      return;
    }
    try {
      raceState = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/classes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      addClassName.value = '';
      addClassName.focus();
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function renameClass(classId, name) {
    if (!activeRaceId) return;
    try {
      raceState = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/classes/${encodeURIComponent(classId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function setClassStartTime(classId, ts) {
    if (!activeRaceId) return;
    try {
      raceState = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/classes/${encodeURIComponent(classId)}/startTime`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startTime: ts })
      });
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function removeClass(classId) {
    if (!activeRaceId) return;
    try {
      raceState = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/classes/${encodeURIComponent(classId)}`, {
        method: 'DELETE'
      });
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function setBoatClass(boatId, classId) {
    if (!activeRaceId) return;
    try {
      const boat = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/boats/${encodeURIComponent(boatId)}/class`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classId: classId || null })
      });
      raceState.boats[boatId] = boat;
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  // One row per class: name (rename on change), its own start time (Now/
  // Clear, same pattern as a boat's own start-time override — a boat's
  // own override still wins over its class's, same as it already won over
  // the race's single start time), and a remove button. Built once per
  // class and updated in place (like the boat table's own rows) so typing
  // a rename isn't interrupted by the next render.
  function buildClassRow(cls) {
    const row = document.createElement('div');
    row.className = 'class-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'class-name-input';
    nameInput.value = cls.name;
    nameInput.addEventListener('change', () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.value = cls.name;
        return;
      }
      renameClass(cls.id, name);
    });

    const startTimeInput = document.createElement('input');
    startTimeInput.type = raceState && raceState.multiDay ? 'datetime-local' : 'time';
    startTimeInput.step = '1';
    startTimeInput.className = 'class-start-input';
    startTimeInput.addEventListener('change', () => {
      if (!startTimeInput.value) {
        setClassStartTime(cls.id, null);
        return;
      }
      const ts =
        raceState && raceState.multiDay
          ? dateTimeInputValueToTs(startTimeInput.value)
          : timeInputValueToTs(startTimeInput.value, (raceState && raceState.startTime) || Date.now(), false);
      setClassStartTime(cls.id, ts);
    });

    const nowBtn = document.createElement('button');
    nowBtn.type = 'button';
    nowBtn.className = 'secondary';
    nowBtn.textContent = 'Now';
    nowBtn.addEventListener('click', () => setClassStartTime(cls.id, Date.now()));

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'secondary';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => setClassStartTime(cls.id, null));

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'secondary danger';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove class';
    removeBtn.addEventListener('click', () => {
      if (confirm(`Remove class "${cls.name}"? Boats in it go back to no class.`)) removeClass(cls.id);
    });

    row.append(nameInput, startTimeInput, nowBtn, clearBtn, removeBtn);
    return { row, nameInput, startTimeInput, nowBtn, clearBtn, removeBtn };
  }

  function renderClassRows() {
    const classes = (raceState && raceState.classes) || [];
    const seenIds = new Set();
    classes.forEach((cls) => {
      seenIds.add(cls.id);
      let refs = classRowRefs.get(cls.id);
      if (!refs) {
        refs = buildClassRow(cls);
        classRowRefs.set(cls.id, refs);
        classRowsEl.appendChild(refs.row);
      }
      if (document.activeElement !== refs.nameInput) refs.nameInput.value = cls.name;
      refs.startTimeInput.type = raceState.multiDay ? 'datetime-local' : 'time';
      if (document.activeElement !== refs.startTimeInput) {
        refs.startTimeInput.value = raceState.multiDay ? tsToDateTimeInputValue(cls.startTime) : tsToTimeInputValue(cls.startTime);
      }
      const canSetClassStart = !!raceState.startTime;
      refs.startTimeInput.disabled = !canSetClassStart;
      refs.nowBtn.disabled = !canSetClassStart;
      refs.clearBtn.disabled = !canSetClassStart || !cls.startTime;
    });
    Array.from(classRowRefs.keys()).forEach((id) => {
      if (!seenIds.has(id)) {
        const refs = classRowRefs.get(id);
        if (refs.row.parentNode) refs.row.remove();
        classRowRefs.delete(id);
      }
    });
  }

  // Keeps the add-boat and per-boat class dropdowns in sync with
  // raceState.classes — rebuilt whenever the class list itself changes,
  // not every render, so an open dropdown isn't yanked shut mid-use.
  let lastClassOptionsSignature = null;
  function classSelectOptionsHtml() {
    const classes = (raceState && raceState.classes) || [];
    return '<option value="">No class</option>' + classes.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
  }
  function refreshClassOptionsIfChanged() {
    const classes = (raceState && raceState.classes) || [];
    const signature = classes.map((c) => c.id + ':' + c.name).join('|');
    if (signature === lastClassOptionsSignature) return;
    lastClassOptionsSignature = signature;
    const html = classSelectOptionsHtml();
    if (document.activeElement !== addBoatClass) addBoatClass.innerHTML = html;
    rows.forEach((row) => {
      if (row.classSelect && document.activeElement !== row.classSelect) {
        const current = row.classSelect.value;
        row.classSelect.innerHTML = html;
        row.classSelect.value = current;
      }
    });
  }

  // Idempotent: if the boat is already gone server-side (a double-click
  // firing twice, or another device/tab removing it first — the race
  // committee often has more than one person editing the same race), a 404
  // here means the desired end state is already reached, not a failure.
  async function removeBoat(boatId) {
    if (!activeRaceId) return true;
    try {
      await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/boats/${encodeURIComponent(boatId)}`, {
        method: 'DELETE'
      });
    } catch (e) {
      if (e.status !== 404) {
        setStatus(e.message, true);
        return false;
      }
    }
    // Don't rows.delete(boatId) here — render()'s own stale-row cleanup
    // (the `seen` pass below) needs that entry to still be present so it can
    // actually remove the <tr> from the DOM, not just forget about it and
    // leave a ghost row behind.
    if (raceState && raceState.boats) delete raceState.boats[boatId];
    render();
    return true;
  }

  async function setFinishTime(boatId, ts) {
    if (!activeRaceId) return;
    try {
      const boat = await fetchJSON(
        `${API}/races/${encodeURIComponent(activeRaceId)}/boats/${encodeURIComponent(boatId)}/finishTime`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ finishTime: ts })
        }
      );
      raceState.boats[boatId] = boat;
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function setStartTime(boatId, ts) {
    if (!activeRaceId) return;
    try {
      const boat = await fetchJSON(
        `${API}/races/${encodeURIComponent(activeRaceId)}/boats/${encodeURIComponent(boatId)}/startTime`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ startTime: ts })
        }
      );
      raceState.boats[boatId] = boat;
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  // Records (or, with ts: null, clears) a boat's own manually-entered
  // rounding time for one specific mark — independent of the automatic
  // AIS-track-based detection, for a boat with no MMSI/AIS at all or to
  // correct a rounding the automatic detection missed.
  async function setMarkTime(boatId, markId, ts) {
    if (!activeRaceId) return;
    try {
      const boat = await fetchJSON(
        `${API}/races/${encodeURIComponent(activeRaceId)}/boats/${encodeURIComponent(boatId)}/markTimes/${encodeURIComponent(markId)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ time: ts })
        }
      );
      raceState.boats[boatId] = boat;
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function setMmsi(boatId, mmsi) {
    if (!activeRaceId) return;
    try {
      const boat = await fetchJSON(
        `${API}/races/${encodeURIComponent(activeRaceId)}/boats/${encodeURIComponent(boatId)}/mmsi`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mmsi })
        }
      );
      raceState.boats[boatId] = boat;
      if (boat.mmsi) loadBoatRegistry();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function setSailNumber(boatId, sailNumber) {
    if (!activeRaceId) return;
    try {
      const boat = await fetchJSON(
        `${API}/races/${encodeURIComponent(activeRaceId)}/boats/${encodeURIComponent(boatId)}/sailNumber`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sailNumber })
        }
      );
      raceState.boats[boatId] = boat;
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function setTcf(boatId, tcf) {
    if (!activeRaceId) return;
    try {
      const boat = await fetchJSON(
        `${API}/races/${encodeURIComponent(activeRaceId)}/boats/${encodeURIComponent(boatId)}/tcf`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tcf })
        }
      );
      raceState.boats[boatId] = boat;
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  // ---- Course editor -------------------------------------------------

  function setCourseStatus(msg, isError) {
    courseStatusText.textContent = msg || '';
    courseStatusText.classList.toggle('error', !!isError);
  }

  async function fetchSelfPosition() {
    try {
      const leaf = await fetchJSON(`${SK_API}/vessels/self/navigation/position`);
      const v = leaf && leaf.value;
      if (v && typeof v.latitude === 'number' && typeof v.longitude === 'number') {
        return { lat: v.latitude, lon: v.longitude };
      }
    } catch (e) {
      // fall through
    }
    return null;
  }

  // ---- Start timer ------------------------------------------------------
  // Countdown to the scheduled start + a live "distance/ETA to the start
  // line, time to burn" instrument for this vessel — the same thing a
  // start-line transit timer app shows, computed from this vessel's own
  // live position/speed (not any other boat's).

  let selfNav = null; // {lat, lon, sogMs, windDirTrueRad, headingRad} | null, refreshed on its own poll — see below

  function normalizeRad(a) {
    const twoPi = Math.PI * 2;
    return ((a % twoPi) + twoPi) % twoPi;
  }

  async function fetchSelfNav() {
    try {
      const [posLeaf, sogLeaf, headingLeaf, cogLeaf, windDirLeaf, windAngleGroundLeaf, windAngleWaterLeaf] = await Promise.all([
        fetchJSON(`${SK_API}/vessels/self/navigation/position`).catch(() => null),
        fetchJSON(`${SK_API}/vessels/self/navigation/speedOverGround`).catch(() => null),
        fetchJSON(`${SK_API}/vessels/self/navigation/headingTrue`).catch(() => null),
        fetchJSON(`${SK_API}/vessels/self/navigation/courseOverGroundTrue`).catch(() => null),
        fetchJSON(`${SK_API}/vessels/self/environment/wind/directionTrue`).catch(() => null),
        fetchJSON(`${SK_API}/vessels/self/environment/wind/angleTrueGround`).catch(() => null),
        fetchJSON(`${SK_API}/vessels/self/environment/wind/angleTrueWater`).catch(() => null)
      ]);
      const v = posLeaf && posLeaf.value;
      if (!v || typeof v.latitude !== 'number' || typeof v.longitude !== 'number') return null;
      const sogMs = sogLeaf && typeof sogLeaf.value === 'number' ? sogLeaf.value : null;
      // True wind direction, absolute (radians, 0 = north) — prefer a
      // sensor/instrument that already computed it; otherwise derive it
      // from a true wind ANGLE (relative to the bow) plus heading (or, if
      // no compass, course over ground as a rough stand-in). null — not
      // just a missing layline — if none of these are available, per
      // SignalK's own "best-effort, never a failure" convention elsewhere
      // in this app.
      let windDirTrueRad = null;
      const heading = headingLeaf && typeof headingLeaf.value === 'number' ? headingLeaf.value : cogLeaf && typeof cogLeaf.value === 'number' ? cogLeaf.value : null;
      if (windDirLeaf && typeof windDirLeaf.value === 'number') {
        windDirTrueRad = normalizeRad(windDirLeaf.value);
      } else if (heading != null) {
        const angle = windAngleGroundLeaf && typeof windAngleGroundLeaf.value === 'number' ? windAngleGroundLeaf.value : windAngleWaterLeaf && typeof windAngleWaterLeaf.value === 'number' ? windAngleWaterLeaf.value : null;
        if (angle != null) windDirTrueRad = normalizeRad(heading + angle);
      }
      return { lat: v.latitude, lon: v.longitude, sogMs, windDirTrueRad, headingRad: heading };
    } catch (e) {
      return null;
    }
  }

  const MS_TO_KNOTS = 1.9438444924574;
  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }
  function toDeg(rad) {
    return (rad * 180) / Math.PI;
  }

  const EARTH_RADIUS_M = 6371000;
  // Destination point a given bearing/distance from a start point (great-
  // circle "direct" geodesic problem) — used to draw laylines a fixed
  // sailing distance out from the boat's own position, same spherical
  // approximation as everywhere else on this chart.
  function destinationPoint(pt, bearingRad, distanceM) {
    const delta = distanceM / EARTH_RADIUS_M;
    const phi1 = toRad(pt.lat);
    const lambda1 = toRad(pt.lon);
    const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(bearingRad));
    const lambda2 = lambda1 + Math.atan2(Math.sin(bearingRad) * Math.sin(delta) * Math.cos(phi1), Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));
    return { lat: toDeg(phi2), lon: toDeg(lambda2) };
  }

  // ---- Wind shift / tack-or-hold --------------------------------------
  // A lift/header indicator: is the current true wind direction shifted
  // toward this vessel's advantage on whichever tack it's on right now
  // (favors holding), or away from it (favors tacking onto the shift)?
  // Tracks a short rolling average of true wind direction as the
  // "baseline" — the same live SignalK feed the laylines use — since a
  // helm sailing closehauled keeps adjusting course to hold a steady angle
  // to the wind, so watching the boat's own heading wouldn't show a shift
  // that's already been steered around; watching the wind's own bearing
  // trend does.
  const WIND_HISTORY_WINDOW_MS = 3 * 60 * 1000; // rolling baseline span
  const WIND_HISTORY_MIN_SPAN_MS = 30 * 1000; // need at least this much history before calling a shift
  const WIND_SHIFT_DEADBAND_DEG = 4; // smaller than this reads as "steady", not a real shift
  let windHistory = []; // [{t, rad}], trimmed to WIND_HISTORY_WINDOW_MS

  function normalizeSignedRad(a) {
    const twoPi = Math.PI * 2;
    let r = a % twoPi;
    if (r > Math.PI) r -= twoPi;
    if (r < -Math.PI) r += twoPi;
    return r;
  }

  // Angles wrap, so a plain arithmetic mean is wrong near the wrap point —
  // average the unit vectors instead (standard circular mean).
  function circularMeanRad(radians) {
    let sumSin = 0;
    let sumCos = 0;
    radians.forEach((r) => {
      sumSin += Math.sin(r);
      sumCos += Math.cos(r);
    });
    return Math.atan2(sumSin, sumCos);
  }

  // null until there's a moving self position, a true wind direction, a
  // heading to determine tack from, and enough rolling history to call a
  // baseline — same "if available, silently not otherwise" spirit as the
  // laylines above.
  function computeWindShift() {
    if (!selfNav || selfNav.windDirTrueRad == null || selfNav.headingRad == null) return null;
    if (!windHistory.length) return null;
    const span = windHistory[windHistory.length - 1].t - windHistory[0].t;
    if (span < WIND_HISTORY_MIN_SPAN_MS) return null;
    const baselineRad = circularMeanRad(windHistory.map((s) => s.rad));
    const shiftRad = normalizeSignedRad(selfNav.windDirTrueRad - baselineRad);
    const shiftDeg = toDeg(shiftRad);
    // Wind source to the right of the bow (positive) = starboard tack.
    const tack = normalizeSignedRad(selfNav.windDirTrueRad - selfNav.headingRad) > 0 ? 'starboard' : 'port';
    let verdict = 'steady';
    if (Math.abs(shiftDeg) >= WIND_SHIFT_DEADBAND_DEG) {
      const isLift = tack === 'starboard' ? shiftDeg > 0 : shiftDeg < 0;
      verdict = isLift ? 'lift' : 'header';
    }
    return { tack, verdict, shiftDeg, twdDeg: (toDeg(selfNav.windDirTrueRad) + 360) % 360 };
  }

  function renderWindShift() {
    const result = computeWindShift();
    windShiftBar.hidden = !result;
    if (!result) return;
    windShiftTack.textContent = result.tack === 'starboard' ? 'Starboard' : 'Port';
    windShiftTwd.textContent = `${Math.round(result.twdDeg)}°`;
    windShiftValue.className = 'start-timer-value';
    if (result.verdict === 'steady') {
      windShiftValue.textContent = 'Steady';
    } else {
      windShiftValue.textContent = `${result.verdict === 'lift' ? 'Lift' : 'Header'} ${result.shiftDeg >= 0 ? '+' : ''}${Math.round(result.shiftDeg)}°`;
      windShiftValue.classList.add(result.verdict);
    }
  }

  // Perpendicular distance from a point to the start-line segment (or to
  // its nearest end, if the point doesn't fall between the two ends) — a
  // flat-earth approximation local to the line, which is fine at the scale
  // of a start line and a boat's approach to it (same simplifying
  // assumption the course chart's own projection already makes).
  function distanceToSegmentNm(p, a, b) {
    const meanLat = (a.lat + b.lat + p.lat) / 3;
    const cosLat = Math.cos(toRad(meanLat)) || 1;
    const NM_PER_DEG_LAT = 60;
    const toXY = (pt) => ({ x: pt.lon * cosLat * NM_PER_DEG_LAT, y: pt.lat * NM_PER_DEG_LAT });
    const P = toXY(p);
    const A = toXY(a);
    const B = toXY(b);
    const abx = B.x - A.x;
    const aby = B.y - A.y;
    const lenSq = abx * abx + aby * aby;
    let t = lenSq > 0 ? ((P.x - A.x) * abx + (P.y - A.y) * aby) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = A.x + abx * t;
    const cy = A.y + aby * t;
    const dx = P.x - cx;
    const dy = P.y - cy;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function fmtSignedDuration(ms) {
    const sign = ms < 0 ? '-' : '+';
    const s = Math.round(Math.abs(ms) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return sign + (h ? `${h}:${String(m).padStart(2, '0')}` : m) + ':' + String(sec).padStart(2, '0');
  }

  // Shown whenever there's a start line to approach and the race hasn't
  // actually started yet (pre-start is moot once it has) — refreshes every
  // tick from the last-polled selfNav, independent of whether that poll
  // itself just ran.
  function renderStartTimer() {
    const hasStartLine = !!(raceState && raceState.course && raceState.course.startLine);
    startTimerSection.hidden = !raceState || !hasStartLine || !!raceState.startTime;
    if (startTimerSection.hidden || startTimerBody.hidden) return;

    const target = raceState.scheduledStart;
    if (!target) {
      startCountdownValue.textContent = '--:--:--';
      startDtlValue.textContent = '--';
      startEtaValue.textContent = '--:--:--';
      startBurnValue.textContent = '--';
      startBurnValue.className = 'start-timer-value';
      startTimerNote.textContent = 'Set a scheduled start time above to see the countdown and burn time here.';
      return;
    }
    const now = Date.now();
    const toStartMs = target - now;
    startCountdownValue.textContent = fmtDuration(Math.max(0, toStartMs));

    if (!selfNav) {
      startDtlValue.textContent = '--';
      startEtaValue.textContent = '--:--:--';
      startBurnValue.textContent = '--';
      startBurnValue.className = 'start-timer-value';
      startTimerNote.textContent = "Waiting for this vessel's own position from SignalK.";
      return;
    }
    const [a, b] = raceState.course.startLine;
    const dtlNm = distanceToSegmentNm(selfNav, a, b);
    startDtlValue.textContent = `${dtlNm.toFixed(2)}nm`;

    if (selfNav.sogMs == null || selfNav.sogMs < 0.25) {
      startEtaValue.textContent = '--:--:--';
      startBurnValue.textContent = '--';
      startBurnValue.className = 'start-timer-value';
      startTimerNote.textContent = 'Waiting for this vessel to be making way (SOG) to estimate ETA and burn time.';
      return;
    }
    const sogKn = selfNav.sogMs * MS_TO_KNOTS;
    const etaMs = (dtlNm / sogKn) * 3600 * 1000;
    startEtaValue.textContent = new Date(now + etaMs).toLocaleTimeString();

    const burnMs = toStartMs - etaMs;
    startBurnValue.textContent = fmtSignedDuration(burnMs);
    startBurnValue.className = 'start-timer-value ' + (burnMs >= 0 ? 'early' : 'late');
    startTimerNote.textContent =
      burnMs >= 0
        ? "Positive: time to spare before the gun at this speed — you'll arrive at the line before it, so you have time to burn."
        : "Negative: you're behind schedule to reach the line at this speed before the gun.";
  }

  // Generic substring-match autocomplete, wiring `input` to `dropdown` (a
  // hidden .suggestions element already sitting next to it in the DOM) —
  // same matching/keyboard-nav behavior as the boat-name autocomplete
  // above, but with its own closure-local item/selection state so several
  // instances (one per course point row) can coexist without stepping on
  // each other the way sharing the boat autocomplete's module-level state
  // would.
  // getExtra (optional) — async (query) => [{name, lat, lon, source}] —
  // supplements getPool's synchronous, immediate matches with a slower
  // source merged in once it resolves (used for the course-point rows'
  // live OpenStreetMap search; see searchOsmPlaces). Debounced on its own
  // so the instant local matches aren't held up waiting for it, and
  // request-numbered so a slow older lookup can't clobber a newer one.
  function attachAutocomplete(input, dropdown, getPool, onSelect, getExtra) {
    let items = [];
    let activeIndex = -1;
    let extraRequestId = 0;
    let extraDebounceTimer = null;

    function hide() {
      dropdown.hidden = true;
      dropdown.innerHTML = '';
      items = [];
      activeIndex = -1;
      clearTimeout(extraDebounceTimer);
    }
    function renderActive() {
      Array.from(dropdown.children).forEach((el, i) => el.classList.toggle('active', i === activeIndex));
    }
    function select(item) {
      onSelect(item);
      hide();
    }
    function renderMatches(matches, q) {
      items = matches;
      activeIndex = -1;
      if (!matches.length) {
        hide();
        return;
      }
      dropdown.innerHTML = '';
      matches.forEach((item) => {
        const div = document.createElement('div');
        div.className = 'suggestion-item';
        const idx = item.name.toLowerCase().indexOf(q);
        if (idx === -1) {
          div.textContent = item.name;
        } else {
          div.innerHTML =
            escapeHtml(item.name.slice(0, idx)) +
            '<mark>' +
            escapeHtml(item.name.slice(idx, idx + q.length)) +
            '</mark>' +
            escapeHtml(item.name.slice(idx + q.length));
        }
        if (item.source === 'osm') div.innerHTML += '<span class="suggestion-source">OpenSeaMap</span>';
        // mousedown (not click) fires before the input's blur, same reason
        // as the boat-name suggestions above.
        div.addEventListener('mousedown', (e) => {
          e.preventDefault();
          select(item);
        });
        dropdown.appendChild(div);
      });
      dropdown.hidden = false;
    }
    function showFor(query) {
      const q = query.trim().toLowerCase();
      clearTimeout(extraDebounceTimer);
      if (!q) {
        hide();
        return;
      }
      const localMatches = getPool()
        .filter((it) => it.name.toLowerCase().includes(q))
        .slice(0, 20);
      renderMatches(localMatches, q);
      if (!getExtra) return;
      extraDebounceTimer = setTimeout(() => {
        const requestId = ++extraRequestId;
        getExtra(query)
          .then((extraItems) => {
            if (requestId !== extraRequestId || !extraItems || !extraItems.length) return;
            const seen = new Set(localMatches.map((m) => m.name.toLowerCase()));
            const merged = localMatches.concat(extraItems.filter((it) => !seen.has(it.name.toLowerCase()))).slice(0, 20);
            renderMatches(merged, q);
          })
          .catch(() => {});
      }, 400);
    }

    input.addEventListener('input', () => showFor(input.value));
    input.addEventListener('focus', () => {
      if (input.value.trim()) showFor(input.value);
    });
    input.addEventListener('blur', () => hide());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && items.length) {
        e.preventDefault();
        activeIndex = (activeIndex + 1) % items.length;
        renderActive();
      } else if (e.key === 'ArrowUp' && items.length) {
        e.preventDefault();
        activeIndex = (activeIndex - 1 + items.length) % items.length;
        renderActive();
      } else if (e.key === 'Enter' && activeIndex >= 0 && items[activeIndex]) {
        e.preventDefault();
        select(items[activeIndex]);
      } else if (e.key === 'Escape') {
        hide();
      }
    });
  }

  // Best-effort: searches OpenSeaMap's own underlying data — OSM's
  // seamark:* tags, the same data its tiles are rendered from, queried
  // via the Overpass API — for named navigation aids (buoys, beacons,
  // lights, marks) in a given area. Used to stock seamarkCache (see
  // ensureSeamarkCache), which backs both the course editor's name
  // autocomplete and the pick-on-map snap. Silently returns nothing on
  // any failure or timeout, same spirit as the reverse-geocode name
  // suggestion.
  // Goes through this plugin's own server (see the /overpass route)
  // rather than calling a public Overpass mirror directly from here: the
  // mirror with real, complete seamark data (overpass-api.de) sends no
  // CORS headers, so a browser fetch to it is blocked outright — a
  // server-to-server request isn't subject to CORS at all. The server
  // also handles falling back across mirrors, so this stays a single
  // same-origin call.
  async function queryOverpass(overpassQuery) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90000);
      let res;
      try {
        res = await fetch(`${API}/overpass?data=${encodeURIComponent(overpassQuery)}`, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return [];
      const data = await res.json();
      return data && Array.isArray(data.elements) ? data.elements : [];
    } catch (e) {
      return [];
    }
  }

  function seamarkElementsToResults(elements) {
    const seen = new Set();
    const results = [];
    elements.forEach((el) => {
      const name = el.tags && (el.tags['seamark:name'] || el.tags.name);
      if (!name || typeof el.lat !== 'number' || seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());
      results.push({ name, lat: el.lat, lon: el.lon, source: 'osm' });
    });
    return results;
  }

  // Fetches every named seamark Overpass knows about in (a generously
  // padded version of) the given area, once, and folds them into
  // seamarkCache — skipping the round-trip entirely once an area's
  // already covered, so panning/zooming the chart a little doesn't
  // refetch, and a slow/unreachable Overpass mirror only has to be
  // waited on once per area rather than on every keystroke or click.
  async function ensureSeamarkCache(bounds) {
    if (seamarkCacheBounds && seamarkCacheBounds.contains(bounds)) return;
    if (seamarkCacheFetch) {
      await seamarkCacheFetch;
      if (seamarkCacheBounds && seamarkCacheBounds.contains(bounds)) return;
    }
    const padded = bounds.pad(0.5);
    // The actual Overpass query is clamped to a sane max span around the
    // padded area's center — a chart zoomed out to show a whole region
    // (easy to end up at after an auto-fit spanning far-apart boat tracks)
    // would otherwise turn this into a practically unbounded query, whose
    // out-body cap then gets consumed by whatever Overpass returns first
    // rather than the marks actually near what's being searched/picked.
    // seamarkCacheBounds still tracks the full (unclamped) padded area
    // below so a wide view isn't re-queried on every subsequent call.
    const MAX_SPAN_DEG = 1; // ~110km of latitude — generous for any single race course
    const center = padded.getCenter();
    const latSpan = Math.min(padded.getNorth() - padded.getSouth(), MAX_SPAN_DEG);
    const lonSpan = Math.min(padded.getEast() - padded.getWest(), MAX_SPAN_DEG);
    const queryBounds = L.latLngBounds(
      [center.lat - latSpan / 2, center.lng - lonSpan / 2],
      [center.lat + latSpan / 2, center.lng + lonSpan / 2]
    );
    const bbox = `${queryBounds.getSouth()},${queryBounds.getWest()},${queryBounds.getNorth()},${queryBounds.getEast()}`;
    const overpassQuery = `[out:json][timeout:15];node["seamark:type"](${bbox});out body 1000;`;
    seamarkCacheFetch = queryOverpass(overpassQuery);
    let elements;
    try {
      elements = await seamarkCacheFetch;
    } finally {
      seamarkCacheFetch = null;
    }
    const seen = new Set(seamarkCache.map((s) => `${s.name.toLowerCase()}|${s.lat}|${s.lon}`));
    seamarkElementsToResults(elements).forEach((r) => {
      const key = `${r.name.toLowerCase()}|${r.lat}|${r.lon}`;
      if (seen.has(key)) return;
      seen.add(key);
      seamarkCache.push(r);
    });
    seamarkCacheBounds = seamarkCacheBounds ? seamarkCacheBounds.extend(padded) : padded;
  }

  async function searchOsmPlaces(query) {
    const q = query.trim();
    if (!q || !chartMap) return [];
    await ensureSeamarkCache(chartMap.getBounds());
    const needle = q.toLowerCase();
    return seamarkCache.filter((s) => s.name.toLowerCase().includes(needle)).slice(0, 8);
  }

  // Used right after a map click: is there a real charted navigation aid
  // within snapping distance of wherever was clicked? A click is rarely
  // pixel-perfect on the actual mark, so offering to snap to the nearest
  // one (rather than silently using the imprecise raw click) means the
  // recorded position is exactly right when there's something real there
  // to be exact about.
  const SNAP_RADIUS_M = 30;
  async function findNearbySeamark(lat, lon) {
    if (!chartMap) return null;
    const clickPt = L.latLng(lat, lon);
    await ensureSeamarkCache(L.latLngBounds(clickPt, clickPt).extend(chartMap.getBounds()));
    const candidates = seamarkCache.filter((s) => distanceMeters(lat, lon, s.lat, s.lon) <= SNAP_RADIUS_M);
    if (!candidates.length) return null;
    candidates.sort((a, b) => distanceMeters(lat, lon, a.lat, a.lon) - distanceMeters(lat, lon, b.lat, b.lon));
    return candidates[0];
  }

  function distanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // One name+lat+lon+position-button row, shared by start line, finish
  // line, and mark entry. The name field autocompletes against existing
  // SignalK waypoints (e.g. ones already placed on a chart plotter) —
  // picking one fills in lat/lon (and the name) from it, so a position
  // doesn't have to be typed by hand if a waypoint for it already exists.
  // The one button toggles with whether this row already has a position:
  // "Pick on map" while empty (arm it, then click the chart below to fill
  // lat/lon from wherever was clicked), "Use my position" once it has one
  // (a quick way to re-centre it on wherever you are right now instead).
  // Mark rows' own map-picking gating (see updateMarkPickGating) is
  // recomputed on every position-setting action here, on any row, since a
  // start line change is typically what unlocks it.
  function buildPointRow(point) {
    const row = document.createElement('tr');
    row.className = 'course-point-row';

    const nameWrap = document.createElement('div');
    nameWrap.className = 'autocomplete course-name-autocomplete';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'course-name-input';
    nameInput.placeholder = 'Name (optional)';
    nameInput.autocomplete = 'off';
    nameInput.value = (point && point.name) || '';

    const nameSuggestions = document.createElement('div');
    nameSuggestions.className = 'suggestions';
    nameSuggestions.hidden = true;
    nameWrap.append(nameInput, nameSuggestions);

    const latInput = document.createElement('input');
    latInput.type = 'number';
    latInput.step = 'any';
    latInput.className = 'course-coord-input';
    latInput.placeholder = 'Lat';
    latInput.value = point ? point.lat : '';

    const lonInput = document.createElement('input');
    lonInput.type = 'number';
    lonInput.step = 'any';
    lonInput.className = 'course-coord-input';
    lonInput.placeholder = 'Lon';
    lonInput.value = point ? point.lon : '';

    const posBtn = document.createElement('button');
    posBtn.type = 'button';
    posBtn.className = 'secondary pick-on-map-btn';

    function hasPosition() {
      return latInput.value !== '' && lonInput.value !== '';
    }
    function updatePosBtnLabel() {
      posBtn.textContent = hasPosition() ? 'Use my position' : 'Pick on map';
    }
    // Cheap enough to run on every keystroke — label state and mark
    // gating both just check whether lat/lon are non-empty.
    function notifyPositionChanged() {
      updatePosBtnLabel();
      updateMarkPickGating();
    }
    // The heavier, best-effort name suggestion only makes sense after a
    // real discrete action (a map click, a self-position fetch) — not on
    // every keystroke while someone's still typing lat/lon by hand.
    // suggestName can be held off (map click passes false up front) so the
    // button/gating feedback lands instantly while a slower seamark lookup
    // is still deciding whether a real buoy name should win instead.
    function handlePositionSet(suggestName = true) {
      notifyPositionChanged();
      if (suggestName) maybeSuggestNameFromPosition(nameInput, latInput.value, lonInput.value);
    }

    latInput.addEventListener('input', notifyPositionChanged);
    lonInput.addEventListener('input', notifyPositionChanged);

    posBtn.addEventListener('click', async () => {
      if (!hasPosition()) {
        if (mapPickTarget && mapPickTarget.btn === posBtn) {
          cancelMapPick();
        } else {
          armMapPick(latInput, lonInput, nameInput, posBtn, nameInput.placeholder || 'this point', handlePositionSet);
        }
        return;
      }
      const pos = await fetchSelfPosition();
      if (pos) {
        latInput.value = pos.lat;
        lonInput.value = pos.lon;
        handlePositionSet();
      } else {
        setCourseStatus('Could not read a current position from SignalK.', true);
      }
    });

    attachAutocomplete(
      nameInput,
      nameSuggestions,
      () => waypoints.concat(seamarkCache),
      (wp) => {
        nameInput.value = wp.name;
        latInput.value = wp.lat;
        lonInput.value = wp.lon;
        notifyPositionChanged();
      },
      searchOsmPlaces
    );

    updatePosBtnLabel();
    const nameCell = document.createElement('td');
    nameCell.className = 'course-name-cell';
    nameCell.appendChild(nameWrap);
    const latCell = document.createElement('td');
    latCell.appendChild(latInput);
    const lonCell = document.createElement('td');
    lonCell.appendChild(lonInput);
    const posCell = document.createElement('td');
    posCell.appendChild(posBtn);
    row.append(nameCell, latCell, lonCell, posCell);
    return { row, nameInput, latInput, lonInput, pickBtn: posBtn, hasPosition };
  }

  // Best-effort: suggests a name for an unnamed point from OpenStreetMap's
  // reverse geocoding once a position is actually set (by map click or
  // self-position — not while still typing lat/lon by hand), so a
  // start/finish pin or a rounding mark doesn't have to be named from
  // scratch when there's a real charted place right there (a headland, a
  // skerry, a harbour). Never overwrites a name already typed or already
  // filled in from picking a waypoint; silently does nothing on any
  // failure, same spirit as the VET/KTK/waypoint lookups elsewhere.
  async function maybeSuggestNameFromPosition(nameInput, lat, lon) {
    if (nameInput.value.trim()) return;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=0`);
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.name && !nameInput.value.trim()) nameInput.value = data.name;
    } catch (e) {
      // best-effort only
    }
  }

  // Arms "pick on map" mode: the next click on the chart fills this row's
  // lat/lon from wherever was clicked. Clicking the same button again, a
  // different row's pick button, or Escape all cancel it.
  function armMapPick(latInput, lonInput, nameInput, btn, label, onPositionChanged) {
    cancelMapPick();
    mapPickTarget = { latInput, lonInput, nameInput, btn, onPositionChanged };
    btn.classList.add('active');
    courseChart.classList.add('picking');
    setCourseStatus(`Click the map below to place "${label}".`);
  }

  function cancelMapPick() {
    if (!mapPickTarget) return;
    mapPickTarget.btn.classList.remove('active');
    mapPickTarget = null;
    courseChart.classList.remove('picking');
    setCourseStatus('');
  }

  // Marks need somewhere on the map worth clicking into — before the start
  // line has a position, the chart has nothing to anchor its zoom to and
  // is still showing the whole world (see chartFitDone). This only ever
  // gates the "Pick on map" state of a mark's button, never "Use my
  // position" — once a mark already has its own position (typed by hand,
  // or picked from a waypoint), re-centring it on self is always fine
  // regardless of the start line.
  function startLineHasPosition() {
    return !!(startLineRefs && startLineRefs.some((r) => r.latInput.value !== '' && r.lonInput.value !== ''));
  }

  function updateMarkPickGating() {
    const startOk = startLineHasPosition();
    markRefs.forEach((r) => {
      if (!r.pickBtn) return;
      const gated = !r.hasPosition() && !startOk;
      r.pickBtn.disabled = gated;
      r.pickBtn.title = gated ? 'Set the start line first — the map needs a position to zoom to before you can pick one for a mark.' : '';
    });
  }

  function renderMarkRows() {
    marksRowsEl.innerHTML = '';
    markRefs.forEach((refs, i) => {
      refs.nameInput.placeholder = `Mark ${i + 1} name`;
      marksRowsEl.appendChild(refs.row);
    });
  }

  function buildMarkRow(mark) {
    const refs = buildPointRow(mark);
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'secondary';
    upBtn.textContent = '↑';
    upBtn.addEventListener('click', () => {
      const idx = markRefs.indexOf(refs);
      if (idx > 0) {
        [markRefs[idx - 1], markRefs[idx]] = [markRefs[idx], markRefs[idx - 1]];
        renderMarkRows();
      }
    });
    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'secondary';
    downBtn.textContent = '↓';
    downBtn.addEventListener('click', () => {
      const idx = markRefs.indexOf(refs);
      if (idx !== -1 && idx < markRefs.length - 1) {
        [markRefs[idx + 1], markRefs[idx]] = [markRefs[idx], markRefs[idx + 1]];
        renderMarkRows();
      }
    });
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'secondary danger';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      const idx = markRefs.indexOf(refs);
      if (idx !== -1) {
        markRefs.splice(idx, 1);
        renderMarkRows();
      }
    });
    const actionsCell = document.createElement('td');
    actionsCell.className = 'course-actions-cell';
    actionsCell.append(upBtn, downBtn, removeBtn);
    refs.row.appendChild(actionsCell);
    return refs;
  }

  // Repopulates the course form from raceState.course — only called on race
  // switch/load and after a successful save, never on the 1s/5s polling
  // ticks, so it can't interrupt someone mid-edit (same reasoning as the
  // boat-row focus guards above, just at the level of "which race is this
  // form even showing").
  function loadCourseFormFromRace() {
    const c = (raceState && raceState.course) || { startLine: null, marks: [], finishLine: null };

    cancelMapPick();
    startLineRefs = [buildPointRow(c.startLine ? c.startLine[0] : null), buildPointRow(c.startLine ? c.startLine[1] : null)];
    startLineRefs[0].nameInput.placeholder = 'Pin end name';
    startLineRefs[1].nameInput.placeholder = 'Committee boat end name';
    startLineRowsEl.innerHTML = '';
    startLineRefs.forEach((r) => startLineRowsEl.appendChild(r.row));

    finishLineRefs = [buildPointRow(c.finishLine ? c.finishLine[0] : null), buildPointRow(c.finishLine ? c.finishLine[1] : null)];
    finishLineRefs[0].nameInput.placeholder = 'Pin end name';
    finishLineRefs[1].nameInput.placeholder = 'Committee boat end name';
    finishLineRowsEl.innerHTML = '';
    finishLineRefs.forEach((r) => finishLineRowsEl.appendChild(r.row));

    markRefs = (c.marks || []).map((m) => buildMarkRow(m));
    renderMarkRows();
    updateMarkPickGating();

    // A race that already has a saved course doesn't need its position
    // tables open by default — the chart below is the useful part once
    // there's nothing left to fill in. Collapsed on load for an
    // already-configured race, and again right after a save (this same
    // function runs then too); an empty course stays expanded since
    // there's nothing yet to hide and editing is the whole point.
    const hasCourse = !!(c.startLine || c.finishLine || (c.marks && c.marks.length));
    positionsBody.hidden = hasCourse;
    positionsToggleBtn.textContent = (positionsBody.hidden ? '▸' : '▾') + ' Positions';
  }

  function pointFromRefs(refs) {
    const lat = parseFloat(refs.latInput.value);
    const lon = parseFloat(refs.lonInput.value);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    const name = refs.nameInput.value.trim();
    return name ? { lat, lon, name } : { lat, lon };
  }

  async function saveCourse() {
    if (!activeRaceId) return;
    const startA = pointFromRefs(startLineRefs[0]);
    const startB = pointFromRefs(startLineRefs[1]);
    const finishA = pointFromRefs(finishLineRefs[0]);
    const finishB = pointFromRefs(finishLineRefs[1]);
    if ((startA && !startB) || (!startA && startB)) {
      setCourseStatus('Enter both ends of the start line, or leave both blank.', true);
      return;
    }
    if ((finishA && !finishB) || (!finishA && finishB)) {
      setCourseStatus('Enter both ends of the finish line, or leave both blank.', true);
      return;
    }
    const marks = [];
    for (let i = 0; i < markRefs.length; i++) {
      const p = pointFromRefs(markRefs[i]);
      if (!p) {
        setCourseStatus(`Mark ${i + 1} needs both a lat and a lon.`, true);
        return;
      }
      marks.push(Object.assign({ id: `m${i}` }, p));
    }
    try {
      raceState = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/course`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startLine: startA && startB ? [startA, startB] : null,
          finishLine: finishA && finishB ? [finishA, finishB] : null,
          marks
        })
      });
      setCourseStatus('Course saved.');
      loadCourseFormFromRace();
      renderChart();
    } catch (e) {
      setCourseStatus(e.message, true);
    }
  }

  // ---- Manage2Sail import ----------------------------------------------

  function setImportStatus(msg, isError) {
    importStatusText.textContent = msg || '';
    importStatusText.classList.toggle('error', !!isError);
  }

  async function findImportClasses() {
    const url = importEventUrl.value.trim();
    if (!url) {
      setImportStatus('Paste a Manage2Sail event URL first.', true);
      return;
    }
    importBoatsBtn.hidden = true;
    importClassesList.innerHTML = '';
    importSystemChoices.innerHTML = '';
    importSystemOverrides = {};
    importEventId = null;
    importClasses = [];
    setImportStatus('Looking up classes…');
    try {
      const data = await fetchJSON(`${API}/import/manage2sail/classes?eventUrl=${encodeURIComponent(url)}`);
      importEventId = data.eventId;
      importClasses = data.classes || [];
      if (!importClasses.length) {
        setImportStatus('No classes found on that event.', true);
        return;
      }
      importClassesList.innerHTML = '';
      importClasses.forEach((c) => {
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = c.id;
        label.append(cb, document.createTextNode(c.name));
        importClassesList.appendChild(label);
      });
      importBoatsBtn.hidden = false;
      setImportStatus(`Found ${importClasses.length} class${importClasses.length === 1 ? '' : 'es'} — pick which to import.`);
    } catch (e) {
      setImportStatus(e.message, true);
    }
  }

  async function loadImportHandicapSystems() {
    if (importHandicapSystems) return importHandicapSystems;
    try {
      const data = await fetchJSON(`${API}/import/manage2sail/handicap-systems`);
      importHandicapSystems = data.systems || [];
    } catch (e) {
      importHandicapSystems = [];
    }
    return importHandicapSystems;
  }

  function importClassName(classId) {
    const c = importClasses.find((cl) => cl.id === classId);
    return c ? c.name : classId;
  }

  function importSystemLabel(key) {
    const s = (importHandicapSystems || []).find((sys) => sys.key === key);
    return s ? s.label : key;
  }

  // A class ends up here only when its handicap system couldn't be resolved
  // automatically (e.g. "YS" whose values don't clearly match either the
  // German or RYA Yardstick scale) — one picker per such class, defaulting
  // to its first candidate so a re-click of Import works even if the user
  // doesn't touch the dropdown, but they should actually check it's right.
  async function renderSystemChoices(needsSystemChoice) {
    importSystemChoices.innerHTML = '';
    if (!needsSystemChoice.length) return;
    await loadImportHandicapSystems();
    needsSystemChoice.forEach((item) => {
      if (importSystemOverrides[item.classId] == null) {
        importSystemOverrides[item.classId] = item.candidates[0];
      }
      const row = document.createElement('div');
      row.className = 'import-system-choice-row';
      const label = document.createElement('span');
      label.textContent = `${importClassName(item.classId)} (published as "${item.hcpName}") — which handicap system is this?`;
      const select = document.createElement('select');
      item.candidates.forEach((key) => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = importSystemLabel(key);
        select.appendChild(opt);
      });
      select.value = importSystemOverrides[item.classId];
      select.addEventListener('change', () => {
        importSystemOverrides[item.classId] = select.value;
      });
      row.append(label, select);
      importSystemChoices.appendChild(row);
    });
  }

  async function importSelectedBoats() {
    if (!activeRaceId || !importEventId) return;
    const classIds = Array.from(importClassesList.querySelectorAll('input[type=checkbox]:checked')).map((cb) => cb.value);
    if (!classIds.length) {
      setImportStatus('Select at least one class to import.', true);
      return;
    }
    setImportStatus('Importing…');
    try {
      const data = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/import/manage2sail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: importEventId, classIds, systemOverrides: importSystemOverrides })
      });
      raceState = data.race;
      render();
      const needsChoice = data.needsSystemChoice || [];
      if (needsChoice.length) {
        await renderSystemChoices(needsChoice);
        const names = needsChoice.map((c) => importClassName(c.classId)).join(', ');
        setImportStatus(
          `Added ${data.added}, updated ${data.updated}. Pick a handicap system below for ${names}, then click Import again.`,
          true
        );
        return;
      }
      importSystemChoices.innerHTML = '';
      importSystemOverrides = {};
      const skippedNote = data.skipped ? `, skipped ${data.skipped}` : '';
      await loadImportHandicapSystems();
      const conversionNote = (data.conversions || [])
        .map((c) => `${importClassName(c.classId)}: ${importSystemLabel(c.system)}`)
        .join('; ');
      setImportStatus(`Added ${data.added}, updated ${data.updated}${skippedNote}.${conversionNote ? ' ' + conversionNote : ''}`);
    } catch (e) {
      setImportStatus(e.message, true);
    }
  }

  // ---- Course / track chart -------------------------------------------

  const CHART_PALETTE = ['#38bdf8', '#fbbf24', '#f472b6', '#a78bfa', '#34d399', '#fb923c', '#60a5fa', '#facc15'];

  function ll(pt) {
    return [pt.lat, pt.lon];
  }

  function midpoint(a, b) {
    return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
  }

  // Created lazily, the first time the chart actually has somewhere to
  // render into — Leaflet can't size a map inside a still-hidden container,
  // and the course section starts collapsed.
  // Shared by the initial auto-fit (once per race, see chartFitDone — over
  // the course, other known waypoints, and boat tracks, everything the
  // chart draws) and the recenter button (any time, on demand, but scoped
  // to just this race's own start/finish/marks — see lastCourseOnlyBoundsPts
  // — so it's a stable "back to the course" reset that doesn't keep
  // shifting as boats move, unlike the initial fit).
  function fitChartToBounds(map, pts) {
    if (!pts.length) return;
    if (pts.length === 1) {
      map.setView(ll(pts[0]), 15);
    } else {
      map.fitBounds(pts.map(ll), { padding: [30, 30] });
    }
  }

  const RecenterControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      const link = L.DomUtil.create('a', 'recenter-btn', container);
      link.href = '#';
      link.title = "Re-center on this race's course";
      link.setAttribute('role', 'button');
      link.setAttribute('aria-label', "Re-center on this race's course");
      link.innerHTML = '&#9678;';
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(link, 'click', L.DomEvent.stop).on(link, 'click', async () => {
        if (lastCourseOnlyBoundsPts.length) {
          fitChartToBounds(chartMap, lastCourseOnlyBoundsPts);
          return;
        }
        // Nothing set yet to recenter on — fall back to wherever this
        // vessel actually is, rather than doing nothing.
        const pos = await fetchSelfPosition();
        if (pos) chartMap.setView([pos.lat, pos.lon], 15);
      });
      return container;
    }
  });

  function ensureChartMap() {
    if (chartMap || typeof L === 'undefined') return chartMap;
    // Scroll-wheel zoom starts off — the chart now runs almost full width,
    // so scrolling the page past it would otherwise get captured as
    // zooming instead. Clicking the map turns it on for as long as the
    // mouse stays over it (a normal Leaflet map's own default); moving off
    // turns it back off, so scrolling past the map again afterward still
    // just scrolls the page.
    chartMap = L.map(courseChart, { attributionControl: true, scrollWheelZoom: false }).setView([0, 0], 2);
    chartMap.on('click', () => chartMap.scrollWheelZoom.enable());
    courseChart.addEventListener('mouseleave', () => chartMap.scrollWheelZoom.disable());
    new RecenterControl().addTo(chartMap);
    chartLayerGroup = L.layerGroup().addTo(chartMap);
    addChartBaseLayers(chartMap);
    // Keeps seamarkCache warm for whatever area the chart actually settles
    // on — the initial course auto-fit, the recenter button, or a manual
    // pan/zoom — so the name autocomplete and pick-on-map snap are usually
    // served from cache by the time they're needed instead of waiting on
    // Overpass right then. Skipped at the very wide starting view (and any
    // zoom that wide) since that'd mean fetching half an ocean.
    chartMap.on('moveend', () => {
      if (chartMap.getZoom() < 8) return;
      ensureSeamarkCache(chartMap.getBounds()).catch(() => {});
    });
    chartMap.on('click', async (e) => {
      if (!mapPickTarget) return;
      const target = mapPickTarget;
      const clickedLat = e.latlng.lat;
      const clickedLon = e.latlng.lng;
      target.latInput.value = clickedLat.toFixed(6);
      target.lonInput.value = clickedLon.toFixed(6);
      cancelMapPick();
      // Instant feedback (button label, mark-pick gating) right away —
      // the name suggestion alone waits on the seamark lookup below, so a
      // slow/unreachable Overpass mirror never makes the click itself
      // look like it did nothing.
      if (target.onPositionChanged) target.onPositionChanged(false);

      // A click is rarely pixel-perfect on the actual mark — if there's a
      // real charted navigation aid right where this one landed, ask
      // before quietly using the imprecise raw click instead. Checked
      // before suggesting any name so a genuine buoy's own OpenSeaMap
      // name always wins the name field, rather than racing a slower
      // Overpass lookup against a faster Nominatim one.
      const nearby = await findNearbySeamark(clickedLat, clickedLon);
      if (nearby && confirm(`Snap to nearby mark "${nearby.name}"?`)) {
        target.latInput.value = nearby.lat.toFixed(6);
        target.lonInput.value = nearby.lon.toFixed(6);
        if (target.nameInput && !target.nameInput.value.trim()) target.nameInput.value = nearby.name;
        if (target.onPositionChanged) target.onPositionChanged(false);
      } else if (target.onPositionChanged) {
        target.onPositionChanged(true);
      }
    });
    return chartMap;
  }

  // Prefers whatever tile-based chart resource(s) this SignalK server has
  // registered (e.g. a locally cached raster chart) — same as freeboard-sk
  // itself would use. Falls back to public OpenStreetMap tiles when none
  // is configured, which is also freeboard-sk's own fallback with no
  // chart provider installed. When more than one chart is registered
  // they're offered as alternative base layers (only one shown at a time,
  // picked via the layer control) rather than stacked on top of each
  // other — stacking silently buried whichever chart happened to load
  // last under whatever loaded after it, e.g. a plain street map with no
  // navigation aids covering an actual nautical chart underneath it.
  // OpenSeaMap's navigation-aids overlay (buoys, lights, marks) is always
  // offered too, on top of whichever base is active, since a registered
  // chart isn't guaranteed to already include them the way Kartverket's
  // does.
  async function addChartBaseLayers(map) {
    let tileCharts = [];
    try {
      const data = await fetchJSON(`${API}/charts`);
      tileCharts = data.charts || [];
    } catch (e) {
      tileCharts = [];
    }
    const baseLayers = {};
    let defaultKey = null;
    if (tileCharts.length) {
      tileCharts.forEach((c) => {
        const opts = { maxZoom: c.maxzoom || 19, minZoom: c.minzoom || 0, attribution: c.name || '' };
        if (Array.isArray(c.bounds) && c.bounds.length === 4) {
          opts.bounds = [
            [c.bounds[1], c.bounds[0]],
            [c.bounds[3], c.bounds[2]]
          ];
        }
        const key = c.name || c.id;
        baseLayers[key] = L.tileLayer(c.url, opts);
        // Eniro's plain map (not "Eniro sjø", and not Kartverket/Hitta,
        // which both render very dark) is the easiest one to actually
        // read at a glance — preferred as the default when it's
        // registered, same as any other order these come back in.
        if ((c.id || '').toLowerCase() === 'eniro') defaultKey = key;
      });
    } else {
      baseLayers['OpenStreetMap'] = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      });
    }
    baseLayers[defaultKey || Object.keys(baseLayers)[0]].addTo(map);

    const overlays = {
      'Navigation aids (OpenSeaMap)': L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openseamap.org">OpenSeaMap</a>'
      }).addTo(map)
    };

    if (Object.keys(baseLayers).length > 1 || Object.keys(overlays).length) {
      L.control.layers(baseLayers, overlays, { collapsed: true }).addTo(map);
    }
  }

  function renderChart() {
    if (courseBody.hidden) return; // nothing to size a map into yet
    const map = ensureChartMap();
    if (!map) return; // Leaflet didn't load (offline, blocked) — rest of the app is unaffected
    chartLayerGroup.clearLayers();

    if (chartActiveRaceId !== activeRaceId) {
      chartActiveRaceId = activeRaceId;
      chartFitDone = false;
    }

    if (!raceState) {
      chartEmptyMsg.hidden = false;
      replayControls.hidden = true;
      return;
    }

    const course = raceState.course || { startLine: null, marks: [], finishLine: null };
    const boatsWithTrack = Object.values(raceState.boats || {}).filter((b) => b.track && b.track.length);
    // Waypoints this same race already published back as its own start/
    // finish/marks (see publishCourseResources server-side) would otherwise
    // double up here — once as a plain waypoint pin, once as the actual
    // course element — so they're left out of the generic waypoint layer.
    const ownPrefix = `${raceState.name} — `;
    const otherWaypoints = waypoints.filter((w) => !w.name || !w.name.startsWith(ownPrefix));

    const courseOnlyPts = [];
    if (course.startLine) courseOnlyPts.push(...course.startLine);
    if (course.finishLine) courseOnlyPts.push(...course.finishLine);
    courseOnlyPts.push(...course.marks);
    lastCourseOnlyBoundsPts = courseOnlyPts;

    const boundsPts = courseOnlyPts.slice();
    otherWaypoints.forEach((w) => boundsPts.push(w));
    boatsWithTrack.forEach((b) => boundsPts.push(...b.track));
    chartEmptyMsg.hidden = boundsPts.length > 0;
    lastChartBoundsPts = boundsPts;

    otherWaypoints.forEach((w) => {
      L.circleMarker(ll(w), { radius: 4, weight: 1, color: 'var(--muted)', fillColor: 'var(--panel)', fillOpacity: 0.6 })
        .bindTooltip(`<span style="color:var(--muted)">${escapeHtml(w.name)}</span>`, { permanent: true, direction: 'top', offset: [0, -6], className: 'waypoint-label' })
        .addTo(chartLayerGroup);
    });

    const coursePts = [];
    if (course.startLine) coursePts.push(midpoint(course.startLine[0], course.startLine[1]));
    course.marks.forEach((m) => coursePts.push(m));
    if (course.finishLine) coursePts.push(midpoint(course.finishLine[0], course.finishLine[1]));
    if (coursePts.length >= 2) {
      L.polyline(coursePts.map(ll), { color: 'var(--muted)', weight: 1.5, dashArray: '4,4' }).addTo(chartLayerGroup);
    }

    if (course.startLine) {
      L.polyline(course.startLine.map(ll), { color: 'var(--good)', weight: 2 })
        .bindTooltip('<span style="color:var(--good)">Start</span>', { permanent: true, direction: 'center', className: 'mark-label' })
        .addTo(chartLayerGroup);
    }
    if (course.finishLine) {
      L.polyline(course.finishLine.map(ll), { color: 'var(--accent)', weight: 2 })
        .bindTooltip('<span style="color:var(--accent)">Finish</span>', { permanent: true, direction: 'center', className: 'mark-label' })
        .addTo(chartLayerGroup);
    }
    course.marks.forEach((m, i) => {
      L.circleMarker(ll(m), { radius: 5, weight: 1.5, color: 'var(--text)', fillColor: 'var(--bg)', fillOpacity: 1 })
        .bindTooltip(`<span style="color:var(--text)">${escapeHtml(m.name || String(i + 1))}</span>`, { permanent: true, direction: 'top', offset: [0, -8], className: 'mark-label' })
        .addTo(chartLayerGroup);
    });

    // Laylines for this vessel — where a further 10 minutes on each
    // close-hauled tack would put it, from wherever it is right now. Shown
    // only when there's actually a true wind direction and a moving SOG to
    // draw them from (not just a position); silently absent otherwise,
    // same "if available" spirit as the rest of this app's SignalK-fed
    // instruments. LAYLINE_TACK_ANGLE_DEG is a generic close-hauled
    // assumption, not this boat's own polar data — good enough for a rough
    // visual, not a precise VMG angle.
    const LAYLINE_TACK_ANGLE_DEG = 40;
    const LAYLINE_DURATION_S = 10 * 60;
    if (selfNav && selfNav.windDirTrueRad != null && selfNav.sogMs != null && selfNav.sogMs >= 0.25) {
      const distanceM = selfNav.sogMs * LAYLINE_DURATION_S;
      const tackAngleRad = toRad(LAYLINE_TACK_ANGLE_DEG);
      [selfNav.windDirTrueRad + tackAngleRad, selfNav.windDirTrueRad - tackAngleRad].forEach((bearingRad) => {
        const end = destinationPoint(selfNav, normalizeRad(bearingRad), distanceM);
        L.polyline([ll(selfNav), ll(end)], { color: 'var(--accent)', weight: 1.5, dashArray: '2,6' })
          .bindTooltip('<span style="color:var(--accent)">10min layline</span>', { sticky: true, className: 'mark-label' })
          .addTo(chartLayerGroup);
      });
    }

    let minT = Infinity;
    let maxT = -Infinity;
    boatsWithTrack.forEach((b) => {
      b.track.forEach((pt) => {
        if (pt.t < minT) minT = pt.t;
        if (pt.t > maxT) maxT = pt.t;
      });
    });
    const cutoff = replayLive ? Infinity : replayTime;

    // A boat's track is a series of discrete observations (an AIS sample
    // roughly every 15s, or a single point at a manually-recorded mark
    // rounding) — the path between them is drawn as a straight line, but
    // that's an assumption, not a fact. Two things make that assumption
    // visible instead of silently implied: a small dot at every actual
    // observation, and — for the moving "current position" marker — linear
    // interpolation between the two observations straddling the replay
    // time, drawn as a hollow ring instead of a solid dot so it reads as
    // estimated, not observed. Only interpolated across a reasonably tight
    // gap; beyond that (AIS dropped out, or a mark rounding recorded far
    // from any real fix) a straight line would just fabricate a plausible-
    // looking but likely wrong path, so it falls back to the last real
    // observation instead, same as before this existed.
    const MAX_INTERP_GAP_MS = 5 * 60 * 1000;

    // A speed pickup between consecutive samples (gust, better trim,
    // planing) is more useful marked right on the trace than buried in a
    // separate speed graph. Drawn in the boat's own colour (like the rest of
    // its trace) rather than a fixed one, since a shared colour would clash
    // with whichever boat's own palette entry happens to match it; the ring
    // shape (unfilled, sized by how much faster) is what sets it apart from
    // the regular sample dots and the solid current-position dot.
    const SPEED_INCREASE_MS = 1.0; // m/s (~1.9 kn) between ~15s samples

    boatsWithTrack.forEach((b, idx) => {
      const color = CHART_PALETTE[idx % CHART_PALETTE.length];
      const pts = b.track.filter((pt) => pt.t <= cutoff);
      if (!pts.length) return;
      L.polyline(pts.map(ll), { color, weight: 1.5, opacity: 0.85 }).addTo(chartLayerGroup);
      pts.forEach((pt) => {
        L.circleMarker(ll(pt), { radius: 2, weight: 0, color, fillColor: color, fillOpacity: 0.7 }).addTo(chartLayerGroup);
      });
      for (let i = 1; i < pts.length; i++) {
        const prevPt = pts[i - 1];
        const pt = pts[i];
        if (typeof prevPt.sog !== 'number' || typeof pt.sog !== 'number') continue;
        const delta = pt.sog - prevPt.sog;
        if (delta < SPEED_INCREASE_MS) continue;
        const r = Math.min(4 + delta * 2, 10);
        L.circleMarker(ll(pt), { radius: r, weight: 2, color, fill: false })
          .bindTooltip(`${escapeHtml(b.name)}: sped up to ${(pt.sog * 1.94384).toFixed(1)} kn`)
          .addTo(chartLayerGroup);
      }

      const prev = pts[pts.length - 1];
      let current = prev;
      let interpolated = false;
      if (!replayLive && prev.t < cutoff) {
        const next = b.track.find((pt) => pt.t > cutoff);
        if (next && next.t - prev.t <= MAX_INTERP_GAP_MS) {
          const frac = (cutoff - prev.t) / (next.t - prev.t);
          current = { lat: prev.lat + (next.lat - prev.lat) * frac, lon: prev.lon + (next.lon - prev.lon) * frac };
          interpolated = true;
        }
      }
      const curOpts = interpolated
        ? { radius: 4, color, weight: 1.5, dashArray: '2,1.5', fillColor: color, fillOpacity: 0.35 }
        : { radius: 4, color, weight: 0, fillColor: color, fillOpacity: 1 };
      L.circleMarker(ll(current), curOpts)
        .bindTooltip(`<span style="color:${color}">${escapeHtml(b.name)}</span>`, { permanent: true, direction: 'right', offset: [7, 0], className: 'boat-label' })
        .addTo(chartLayerGroup);
    });

    if (!chartFitDone && boundsPts.length) {
      fitChartToBounds(map, boundsPts);
      chartFitDone = true;
    }

    replayControls.hidden = boatsWithTrack.length === 0 || !isFinite(minT);
    if (!replayControls.hidden && document.activeElement !== replaySlider) {
      replaySlider.min = String(minT);
      replaySlider.max = String(maxT);
      if (replayLive) {
        replaySlider.value = String(maxT);
        replayTimeLabel.textContent = 'Live';
      } else {
        replaySlider.value = String(Math.min(Math.max(replayTime, minT), maxT));
        replayTimeLabel.textContent = new Date(replayTime).toLocaleTimeString();
      }
    }
  }

  // A boat's own start time (a per-boat correction) wins if set; otherwise
  // its class's start time (a staggered/pursuit start by class) if it's in
  // one and that class has its own start time set; otherwise the race's
  // single start time — mirrors index.js's effectiveStartTime exactly.
  function effectiveStartTime(boat) {
    if (boat.startTime != null) return boat.startTime;
    const cls = boat.classId && raceState.classes ? raceState.classes.find((c) => c.id === boat.classId) : null;
    if (cls && cls.startTime != null) return cls.startTime;
    return raceState.startTime;
  }

  function boatList() {
    if (!raceState) return [];
    const now = raceNow();
    return Object.values(raceState.boats || {})
      .map((b) => {
        const start = effectiveStartTime(b);
        // A DNF boat is out of the race — no ticking clock, no rank (sorts
        // to the bottom, same as any other boat with nothing to rank by).
        // A start time still in the future (e.g. a later pursuit-start
        // group) means this boat hasn't actually started yet either.
        const elapsedMs = !b.dnf && !b.dns && start && start <= now ? (b.finishTime || now) - start : null;
        const tcf = b.tcf != null ? b.tcf : 1.0;
        const correctedMs = elapsedMs != null ? elapsedMs * tcf : null;
        const estimate = b.estimate || null;
        // Finished boats rank on their real corrected time; still-racing
        // boats rank on the projected corrected time when the server could
        // estimate one (course + live position/speed available), otherwise
        // fall back to elapsed-so-far like before.
        const rankMs = b.dnf || b.dns ? null : b.finishTime ? correctedMs : estimate ? estimate.estCorrectedMs : correctedMs;
        return {
          boatId: b.id,
          name: b.name,
          sailNumber: b.sailNumber || '',
          mmsi: b.mmsi || '',
          tcf,
          startTime: b.startTime,
          classId: b.classId || null,
          finishTime: b.finishTime,
          dnf: !!b.dnf,
          dns: !!b.dns,
          dnfPosition: b.dnfPosition || null,
          markTimes: b.markTimes || {},
          roundedMarksCount: b.roundedMarksCount || 0,
          elapsedMs,
          correctedMs,
          estimate,
          rankMs
        };
      })
      .sort((a, b) => {
        // Self always leads, whatever else is true — it's the boat whoever
        // is looking at this screen cares about finding without hunting
        // for it.
        const aSelf = a.boatId === raceState.selfBoatId;
        const bSelf = b.boatId === raceState.selfBoatId;
        if (aSelf !== bSelf) return aSelf ? -1 : 1;
        // DNS sits at the very end regardless of phase — it can be marked
        // before the race even starts (a known no-show), and never really
        // "entered" the race the way even a DNF (which did start) still
        // did.
        if (a.dns !== b.dns) return a.dns ? 1 : -1;
        if (a.dns) return a.name.localeCompare(b.name);
        // Before the race actually starts, nobody has a corrected time to
        // rank by anyway — sorting by name (or anything else derived) just
        // reshuffled the rows confusingly every time a boat was added or
        // removed. Rely on sort's stability and leave order exactly as
        // Object.values(raceState.boats) gave it (i.e. registration order)
        // until there's an actual race to rank.
        if (!raceState.startTime) return 0;
        if (a.rankMs == null && b.rankMs == null) return a.name.localeCompare(b.name);
        if (a.rankMs == null) return 1;
        if (b.rankMs == null) return -1;
        // Mirrors the server's rankedBoatList: with no AIS-based ETA to
        // fall back on, a boat recorded further around the course (by
        // either automatic AIS detection or a manually recorded rounding)
        // ranks ahead regardless of corrected time so far.
        if (!a.finishTime && !b.finishTime && !a.estimate && !b.estimate && a.roundedMarksCount !== b.roundedMarksCount) {
          return b.roundedMarksCount - a.roundedMarksCount;
        }
        return a.rankMs - b.rankMs;
      });
  }

  // Compares every boat to whichever one is marked "self". Two shapes:
  //  - "countdown": self is still racing and the other boat has already
  //    finished, so the other's corrected time is a fixed target — this is
  //    how much longer self can take (in elapsed time) and still finish
  //    with a lower corrected time. Ticks down every render; goes negative
  //    once self can no longer catch up even by finishing instantly.
  //  - "gap": both values are pinned (self finished) or both still moving
  //    (neither finished) — just the current corrected-time gap, positive
  //    when self is ahead.
  // With no boat marked self, falls back to comparing everyone against the
  // current leader instead of leaving the column blank — boats is already
  // sorted by rank, so the leader (if any is actually ranked yet) is simply
  // the first entry.
  function computeVsSelf(boats, selfBoatId) {
    const map = new Map();
    let self = boats.find((b) => b.boatId === selfBoatId);
    let isLeaderFallback = false;
    if (!self) {
      self = boats.length && boats[0].rankMs != null ? boats[0] : null;
      isLeaderFallback = true;
    }
    if (!self) return map;
    boats.forEach((b) => {
      if (b.boatId === self.boatId) {
        map.set(b.boatId, { type: 'self', isLeader: isLeaderFallback });
        return;
      }
      if (self.dnf || self.dns) {
        // Self is out of the race — no meaningful comparison to make.
        map.set(b.boatId, { type: 'none' });
        return;
      }
      if (!self.finishTime && b.finishTime) {
        const thresholdElapsedMs = b.correctedMs / (self.tcf || 1);
        map.set(b.boatId, {
          type: 'countdown',
          remainingMs: thresholdElapsedMs - self.elapsedMs,
          isLeader: isLeaderFallback
        });
        return;
      }
      const selfVal = self.finishTime ? self.correctedMs : self.rankMs;
      const otherVal = b.finishTime ? b.correctedMs : b.rankMs;
      if (selfVal == null || otherVal == null) {
        map.set(b.boatId, { type: 'none' });
        return;
      }
      map.set(b.boatId, { type: 'gap', gapMs: otherVal - selfVal, isLeader: isLeaderFallback });
    });
    return map;
  }

  // Row DOM nodes are created once per boat and reused across renders, so an
  // in-progress edit (TCF, finish time) is never blown away by the
  // once-a-second clock tick that redraws elapsed/corrected time.
  const rows = new Map(); // boatId -> row refs

  function buildRow(boatId) {
    const tr = document.createElement('tr');

    const selfBtn = document.createElement('button');
    selfBtn.type = 'button';
    selfBtn.className = 'self-btn';
    selfBtn.title = 'Mark as self, to compare other boats against';
    selfBtn.textContent = '☆';
    selfBtn.addEventListener('click', () => toggleSelf(boatId));

    const nameSpan = document.createElement('span');
    nameSpan.className = 'boat-name-text';

    const tdName = document.createElement('td');
    tdName.className = 'boat-name-col';
    tdName.append(selfBtn, nameSpan);

    const sailNumberInput = document.createElement('input');
    sailNumberInput.type = 'text';
    sailNumberInput.className = 'sail-number-input';
    sailNumberInput.placeholder = 'Sail #';
    sailNumberInput.addEventListener('change', () => setSailNumber(boatId, sailNumberInput.value.trim()));
    const tdSailNumber = document.createElement('td');
    tdSailNumber.appendChild(sailNumberInput);

    const mmsiInput = document.createElement('input');
    mmsiInput.type = 'text';
    mmsiInput.className = 'mmsi-input';
    mmsiInput.placeholder = 'MMSI';
    mmsiInput.addEventListener('change', () => setMmsi(boatId, mmsiInput.value.trim()));
    const tdMmsi = document.createElement('td');
    tdMmsi.appendChild(mmsiInput);

    const tcfInput = document.createElement('input');
    tcfInput.type = 'number';
    tcfInput.step = '0.001';
    tcfInput.min = '0.01';
    tcfInput.className = 'tcf-input';
    tcfInput.addEventListener('change', () => {
      const val = parseFloat(tcfInput.value);
      if (isFinite(val) && val > 0) setTcf(boatId, val);
    });
    // Handicap edits must be deliberate text entry — block the number
    // input's scroll-wheel and up/down-arrow increment/decrement so a
    // stray scroll or arrow key can't silently nudge a boat's TCF.
    tcfInput.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
      },
      { passive: false }
    );
    tcfInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.preventDefault();
    });
    const tdTcf = document.createElement('td');
    tdTcf.appendChild(tcfInput);

    // Alternatives specific to this boat's name (populated once the VET
    // register is loaded/matched — see refreshVetAlternatives), so picking
    // one applies that exact number without retyping.
    const vetSelect = document.createElement('select');
    vetSelect.className = 'vet-select';
    vetSelect.addEventListener('change', () => {
      const val = parseFloat(vetSelect.value);
      if (isFinite(val) && val > 0) {
        tcfInput.value = val;
        setTcf(boatId, val);
      }
      // Left showing the picked alternative (synced from tcf on future
      // renders) rather than reset to the placeholder — see
      // syncVetSelectValue.
    });
    const vetBadge = document.createElement('span');
    vetBadge.className = 'vet-badge';
    const tdVet = document.createElement('td');
    tdVet.className = 'vet-cell';
    tdVet.hidden = !vetEnabled && !ktkEnabled;
    tdVet.append(vetSelect, vetBadge);

    // Which class (if any) this boat belongs to — a class's own start time
    // (set in the Classes section) is what this boat's own start time
    // falls back to before falling back to the race's single start time.
    const classSelect = document.createElement('select');
    classSelect.className = 'class-select';
    classSelect.innerHTML = classSelectOptionsHtml();
    classSelect.addEventListener('change', () => setBoatClass(boatId, classSelect.value));
    const tdClass = document.createElement('td');
    tdClass.hidden = !raceState || !raceState.classes || !raceState.classes.length;
    tdClass.appendChild(classSelect);

    // A boat's own start time, for a staggered/pursuit start or to correct
    // a boat that didn't actually start with the fleet — overrides the
    // race's single start time for this boat only. Blank means "use the
    // race's start time", same as before this existed.
    const startTimeInput = document.createElement('input');
    startTimeInput.type = raceState && raceState.multiDay ? 'datetime-local' : 'time';
    startTimeInput.step = '1';
    startTimeInput.className = 'start-time-input';
    startTimeInput.addEventListener('change', () => {
      if (!startTimeInput.value) {
        setStartTime(boatId, null);
        return;
      }
      const ts =
        raceState && raceState.multiDay
          ? dateTimeInputValueToTs(startTimeInput.value)
          : timeInputValueToTs(startTimeInput.value, (raceState && raceState.startTime) || Date.now(), false);
      setStartTime(boatId, ts);
    });
    const startNowBtn = document.createElement('button');
    startNowBtn.type = 'button';
    startNowBtn.className = 'finish-now-btn';
    startNowBtn.textContent = 'Now';
    startNowBtn.addEventListener('click', () => setStartTime(boatId, Date.now()));
    const startClearBtn = document.createElement('button');
    startClearBtn.type = 'button';
    startClearBtn.className = 'finish-clear-btn';
    startClearBtn.textContent = 'Clear';
    startClearBtn.addEventListener('click', () => setStartTime(boatId, null));
    const startWrap = document.createElement('div');
    startWrap.className = 'finish-cell';
    startWrap.append(startTimeInput, startNowBtn, startClearBtn);
    const tdStart = document.createElement('td');
    tdStart.appendChild(startWrap);

    const tdElapsed = document.createElement('td');
    const tdCorrected = document.createElement('td');
    // One small pill button per course mark, in rounding order — click an
    // unrounded one to record "rounded now", click a rounded one to clear
    // it. Rebuilt only when the course's marks actually change (see
    // render()), not every tick. Independent of the automatic AIS
    // track-based rounding detection; either one counts (see the server's
    // countRoundedMarks) — this is the manual alternative, for a boat with
    // no MMSI/AIS at all or to correct a rounding the detection missed.
    const tdMarks = document.createElement('td');
    tdMarks.className = 'marks-cell';
    const tdEstFinish = document.createElement('td');
    tdEstFinish.className = 'est-finish';
    const tdVsSelf = document.createElement('td');
    tdVsSelf.className = 'vs-self';

    const finishTimeInput = document.createElement('input');
    finishTimeInput.type = raceState && raceState.multiDay ? 'datetime-local' : 'time';
    finishTimeInput.step = '1';
    finishTimeInput.className = 'finish-time-input';
    finishTimeInput.addEventListener('change', () => {
      if (!finishTimeInput.value) {
        setFinishTime(boatId, null);
        return;
      }
      const ts =
        raceState && raceState.multiDay
          ? dateTimeInputValueToTs(finishTimeInput.value)
          : timeInputValueToTs(finishTimeInput.value);
      setFinishTime(boatId, ts);
    });

    const finishNowBtn = document.createElement('button');
    finishNowBtn.type = 'button';
    finishNowBtn.className = 'finish-now-btn';
    finishNowBtn.textContent = 'Now';
    finishNowBtn.addEventListener('click', () => setFinishTime(boatId, Date.now()));

    const finishClearBtn = document.createElement('button');
    finishClearBtn.type = 'button';
    finishClearBtn.className = 'finish-clear-btn';
    finishClearBtn.textContent = 'Clear';
    finishClearBtn.addEventListener('click', () => setFinishTime(boatId, null));

    const finishDnfBtn = document.createElement('button');
    finishDnfBtn.type = 'button';
    finishDnfBtn.className = 'finish-dnf-btn';
    finishDnfBtn.textContent = 'DNF';
    finishDnfBtn.addEventListener('click', () => setDnf(boatId, true));

    const finishDnsBtn = document.createElement('button');
    finishDnsBtn.type = 'button';
    finishDnsBtn.className = 'finish-dnf-btn';
    finishDnsBtn.textContent = 'DNS';
    finishDnsBtn.title = 'Did not start';
    finishDnsBtn.addEventListener('click', () => setDns(boatId, true));

    const finishNormalWrap = document.createElement('div');
    finishNormalWrap.className = 'finish-cell';
    finishNormalWrap.append(finishTimeInput, finishNowBtn, finishClearBtn, finishDnfBtn, finishDnsBtn);

    const dnfTag = document.createElement('span');
    dnfTag.className = 'dnf-tag';
    dnfTag.textContent = 'DNF';
    const dnfPosSpan = document.createElement('span');
    dnfPosSpan.className = 'dnf-pos';
    const undoDnfBtn = document.createElement('button');
    undoDnfBtn.type = 'button';
    undoDnfBtn.className = 'undo-dnf-btn';
    undoDnfBtn.textContent = 'Undo DNF';
    undoDnfBtn.addEventListener('click', () => setDnf(boatId, false));
    const dnfWrap = document.createElement('div');
    dnfWrap.className = 'finish-cell';
    dnfWrap.append(dnfTag, dnfPosSpan, undoDnfBtn);

    const dnsTag = document.createElement('span');
    dnsTag.className = 'dnf-tag';
    dnsTag.textContent = 'DNS';
    const undoDnsBtn = document.createElement('button');
    undoDnsBtn.type = 'button';
    undoDnsBtn.className = 'undo-dnf-btn';
    undoDnsBtn.textContent = 'Undo DNS';
    undoDnsBtn.addEventListener('click', () => setDns(boatId, false));
    const dnsWrap = document.createElement('div');
    dnsWrap.className = 'finish-cell';
    dnsWrap.append(dnsTag, undoDnsBtn);

    const tdFinish = document.createElement('td');
    tdFinish.append(finishNormalWrap, dnfWrap, dnsWrap);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'secondary danger remove-boat-btn';
    removeBtn.textContent = 'Remove';
    armConfirm(removeBtn, 'Remove', 'Confirm?', async () => {
      removeBtn.disabled = true;
      const removed = await removeBoat(boatId);
      // On success the row (and this button) is gone from the DOM already;
      // only re-enable if it's still here, i.e. a real failure occurred.
      if (!removed) removeBtn.disabled = false;
    });
    const tdRemove = document.createElement('td');
    tdRemove.appendChild(removeBtn);

    tr.append(tdName, tdSailNumber, tdMmsi, tdTcf, tdVet, tdClass, tdStart, tdElapsed, tdCorrected, tdMarks, tdEstFinish, tdVsSelf, tdFinish, tdRemove);

    return {
      tr,
      selfBtn,
      nameSpan,
      tdMarks,
      marksSignature: undefined,
      marksPills: [],
      tdEstFinish,
      tdVsSelf,
      sailNumberInput,
      mmsiInput,
      tcfInput,
      vetSelect,
      vetBadge,
      tdClass,
      classSelect,
      startTimeInput,
      startNowBtn,
      startClearBtn,
      tdElapsed,
      tdCorrected,
      finishNormalWrap,
      finishTimeInput,
      finishNowBtn,
      finishClearBtn,
      finishDnfBtn,
      finishDnsBtn,
      dnfWrap,
      dnfPosSpan,
      dnsWrap,
      vetHandicapVersion: -1
    };
  }

  // Rebuilds a row's handicap-alternatives <select> from the current
  // register(s) — only called when a register itself (re)loads, not every
  // render tick, so an open dropdown or mid-pick isn't disrupted every
  // second. Never called at all while both vetEnabled and ktkEnabled are
  // false (see the call site) — the "Handicap alternatives" column is
  // hidden entirely in that case. Merges VET-tall and KTK when both are
  // enabled and a boat matches both, rather than picking one over the
  // other.
  function refreshVetAlternatives(row, boatName) {
    const name = boatName.trim().toLowerCase();
    const vetEntry = vetEnabled ? handicapBoats.find((h) => h.name.toLowerCase() === name) : null;
    const ktkEntry = ktkEnabled ? ktkBoats.find((h) => h.name.toLowerCase() === name) : null;
    const bothEnabled = vetEnabled && ktkEnabled;
    const options = [];
    if (vetEntry) {
      vetEntry.vets.forEach((v) => options.push({ value: v.value, text: `${bothEnabled ? 'VET ' : ''}${v.label}: ${v.value}` }));
    }
    if (ktkEntry) {
      ktkEntry.vets.forEach((v) =>
        options.push({ value: v.value, text: `${bothEnabled ? 'KTK ' : ''}${v.label}: ${v.raw} → ${v.value}` })
      );
    }
    row.vetSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = options.length ? 'Pick…' : 'No match';
    row.vetSelect.appendChild(placeholder);
    row.vetSelect.disabled = !options.length;
    options.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = String(o.value);
      opt.textContent = o.text;
      row.vetSelect.appendChild(opt);
    });
    if (vetEntry) {
      const notValid = /ikke/i.test(vetEntry.validity || '');
      row.vetBadge.textContent = vetEntry.validity ? (notValid ? '⚠ ' + vetEntry.validity : vetEntry.validity) : '';
      row.vetBadge.classList.toggle('warn', notValid);
    } else {
      row.vetBadge.textContent = '';
      row.vetBadge.classList.remove('warn');
    }
  }

  // Keeps the select showing whichever alternative is actually in effect
  // (matching the boat's current TCF) rather than resetting to the
  // placeholder after a pick — falls back to the placeholder if the TCF was
  // typed by hand and doesn't match any listed alternative.
  function syncVetSelectValue(row, tcf) {
    if (document.activeElement === row.vetSelect) return;
    const match = Array.from(row.vetSelect.options).find(
      (o) => o.value !== '' && Math.abs(parseFloat(o.value) - tcf) < 1e-9
    );
    row.vetSelect.value = match ? match.value : '';
  }

  function renderRaceSelect() {
    const prevFocus = document.activeElement === raceSelect;
    raceSelect.innerHTML = '';
    races.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r.id;
      const when = r.startTime
        ? new Date(r.startTime).toLocaleString()
        : r.scheduledStart
          ? 'scheduled ' + new Date(r.scheduledStart).toLocaleString()
          : 'not started';
      opt.textContent = `${r.name} (${when})`;
      raceSelect.appendChild(opt);
    });
    if (activeRaceId) raceSelect.value = activeRaceId;
    if (prevFocus) raceSelect.focus();
  }

  function render() {
    renderRaceSelect();
    noRacesMsg.hidden = races.length > 0;
    raceArea.hidden = !raceState;
    addBoatRow.hidden = !raceState;
    boatsTable.hidden = !raceState;
    deleteRaceBtn.hidden = !raceState;
    exportBtn.hidden = !raceState;
    exportOfflineBtn.hidden = !raceState;
    courseSection.hidden = !raceState;
    classSection.hidden = !raceState;
    raceImportSection.hidden = !raceState || !raceImportEnabled;
    renderStartTimer();
    renderWindShift();

    if (!raceState) {
      emptyMsg.hidden = true;
      renderChart();
      return;
    }

    renderClassRows();
    refreshClassOptionsIfChanged();

    renderChart();

    const now = Date.now();
    if (raceState.startTime) {
      clockEl.textContent = fmtDuration(raceNow() - raceState.startTime);
      clockEl.classList.remove('countdown');
      clockEl.classList.toggle('stopped', !!raceState.stopTime);
      if (raceState.scheduledCallOff && !raceState.stopTime && now >= raceState.scheduledCallOff) {
        // The scheduled call-off moment has passed locally; poke the server
        // so we pick up the auto-stop/DNF without waiting for the next poll.
        loadRaceState();
      }
    } else if (raceState.scheduledStart) {
      clockEl.textContent = '-' + fmtDuration(raceState.scheduledStart - now);
      clockEl.classList.add('countdown');
      clockEl.classList.remove('stopped');
      if (now >= raceState.scheduledStart) {
        // The scheduled moment has passed locally; poke the server so we
        // pick up the auto-start without waiting for the next 5s poll.
        loadRaceState();
      }
    } else {
      clockEl.textContent = '00:00:00';
      clockEl.classList.remove('countdown', 'stopped');
    }

    startBtn.disabled = !!raceState.startTime;
    startBtn.textContent = raceState.startTime ? 'Race Started' : 'Start Race';
    stopBtn.hidden = !raceState.startTime || !!raceState.stopTime;
    resumeBtn.hidden = !raceState.stopTime;

    raceStartInput.type = raceState.multiDay ? 'datetime-local' : 'time';
    if (document.activeElement !== raceStartInput) {
      raceStartInput.value = raceState.multiDay
        ? tsToDateTimeInputValue(raceState.startTime)
        : tsToTimeInputValue(raceState.startTime);
    }

    if (document.activeElement !== scheduleInput) {
      scheduleInput.value = tsToDateTimeInputValue(raceState.scheduledStart);
    }
    scheduleInput.disabled = !!raceState.startTime;
    scheduleBtn.disabled = !!raceState.startTime;
    scheduleBtn.textContent = raceState.scheduledStart
      ? 'Scheduled: ' + new Date(raceState.scheduledStart).toLocaleString()
      : 'Schedule Start';
    cancelScheduleBtn.hidden = !raceState.scheduledStart || !!raceState.startTime;

    callOffInput.type = raceState.multiDay ? 'datetime-local' : 'time';
    callOffInput.disabled = !!raceState.stopTime;
    scheduleCallOffBtn.disabled = !!raceState.stopTime;
    scheduleCallOffBtn.textContent = raceState.scheduledCallOff
      ? 'Call-off: ' + new Date(raceState.scheduledCallOff).toLocaleTimeString()
      : 'Schedule Call-off';
    cancelCallOffBtn.hidden = !raceState.scheduledCallOff || !!raceState.stopTime;

    const boats = boatList();
    emptyMsg.hidden = boats.length > 0;
    const vsSelfMap = computeVsSelf(boats, raceState.selfBoatId);

    boats.forEach((b) => {
      if (!rows.get(b.boatId)) {
        rows.set(b.boatId, buildRow(b.boatId));
      }
    });
    // Moving already-attached nodes to their sorted position keeps them
    // intact (focus, in-progress edits) rather than recreating them — but
    // the move itself still resets a text cursor and closes an open
    // <select>, so the whole reorder pass is skipped while the user has
    // anything in ANY row focused, not just the row that would move.
    // Reordering around a skipped row by moving everyone else in sequence
    // can still shuffle it to a different spot as a side effect of those
    // other moves, which is exactly the "keep self on top" guarantee this
    // was supposed to preserve — so it's all-or-nothing instead. It'll
    // snap to the fully correct order on the next render once focus moves
    // away.
    const anyRowFocused = boats.some((b) => rows.get(b.boatId).tr.contains(document.activeElement));
    if (!anyRowFocused) {
      boats.forEach((b) => boatsBody.appendChild(rows.get(b.boatId).tr));
    }

    boats.forEach((b) => {
      const row = rows.get(b.boatId);

      row.tr.classList.toggle('finished', !!b.finishTime);
      row.tr.classList.toggle('dnf', !!b.dnf || !!b.dns);
      row.nameSpan.textContent = b.name;
      const isSelf = b.boatId === raceState.selfBoatId;
      row.selfBtn.textContent = isSelf ? '★' : '☆';
      row.selfBtn.classList.toggle('active', isSelf);
      if (document.activeElement !== row.sailNumberInput) {
        row.sailNumberInput.value = b.sailNumber || '';
      }
      if (document.activeElement !== row.mmsiInput) {
        row.mmsiInput.value = b.mmsi;
      }
      if (document.activeElement !== row.tcfInput) {
        row.tcfInput.value = b.tcf;
      }
      if ((vetEnabled || ktkEnabled) && row.vetHandicapVersion !== handicapVersion && document.activeElement !== row.vetSelect) {
        refreshVetAlternatives(row, b.name);
        row.vetHandicapVersion = handicapVersion;
      }
      syncVetSelectValue(row, b.tcf);
      row.tdClass.hidden = !raceState.classes || !raceState.classes.length;
      if (document.activeElement !== row.classSelect) {
        row.classSelect.value = b.classId || '';
      }
      // A boat with no start time of its own already starts with the
      // fleet (or its class) — effectiveStartTime falls back to its
      // class's start time, or the race's own, and elapsed/corrected
      // already reflect that. The input showing blank instead of that
      // time made it look like the boat hadn't started at all even while
      // it was actively being timed; showing the inherited value (dimmed,
      // to mark it as inherited rather than a boat-specific override)
      // fixes that without changing what's actually stored — only "Now"
      // or typing a value turns it into a real per-boat override (e.g. a
      // pursuit start), same as before.
      const effectiveStart = effectiveStartTime(b);
      if (document.activeElement !== row.startTimeInput) {
        row.startTimeInput.value = raceState.multiDay ? tsToDateTimeInputValue(effectiveStart) : tsToTimeInputValue(effectiveStart);
      }
      row.startTimeInput.classList.toggle('inherited-value', b.startTime == null && effectiveStart != null);
      const canStart = !!raceState.startTime;
      row.startTimeInput.disabled = !canStart;
      row.startNowBtn.disabled = !canStart;
      row.startClearBtn.disabled = !canStart || !b.startTime;
      row.tdElapsed.textContent = fmtDuration(b.elapsedMs);
      row.tdCorrected.textContent = fmtDuration(b.correctedMs);

      const courseMarks = (raceState.course && raceState.course.marks) || [];
      const marksSig = courseMarks.map((m) => m.id).join(',');
      if (row.marksSignature !== marksSig) {
        row.tdMarks.innerHTML = '';
        row.marksPills = courseMarks.map((m, i) => {
          const pill = document.createElement('button');
          pill.type = 'button';
          pill.className = 'mark-pill';
          pill.textContent = String(i + 1);
          pill.addEventListener('click', () => {
            const boat = raceState.boats[b.boatId];
            const already = boat && boat.markTimes && boat.markTimes[m.id] != null;
            setMarkTime(b.boatId, m.id, already ? null : Date.now());
          });
          row.tdMarks.appendChild(pill);
          return pill;
        });
        row.marksSignature = marksSig;
      }
      courseMarks.forEach((m, i) => {
        const pill = row.marksPills[i];
        const t = b.markTimes && b.markTimes[m.id];
        pill.classList.toggle('rounded', t != null);
        const label = m.name || `Mark ${i + 1}`;
        pill.title = t != null ? `${label} — rounded ${new Date(t).toLocaleTimeString()} (click to clear)` : `${label} — click to mark rounded now`;
      });

      if (b.dnf) {
        row.tdEstFinish.textContent = 'DNF';
      } else if (b.finishTime) {
        row.tdEstFinish.textContent = '—';
      } else if (b.estimate) {
        const t = new Date(b.estimate.estFinishTime);
        const marks = b.estimate.marksRemaining;
        const viaMarks = marks > 0 ? ` via ${marks} mark${marks === 1 ? '' : 's'}` : '';
        row.tdEstFinish.innerHTML =
          `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}` +
          `<span class="est-detail">~${b.estimate.remainingNm}nm${viaMarks} @ ${b.estimate.sogKn}kn</span>`;
      } else {
        row.tdEstFinish.textContent = '—';
      }

      const vs = vsSelfMap.get(b.boatId);
      if (!vs || vs.type === 'none') {
        row.tdVsSelf.textContent = vs ? '—' : '';
        row.tdVsSelf.className = 'vs-self';
        row.tdVsSelf.title = '';
      } else if (vs.type === 'self') {
        row.tdVsSelf.innerHTML = vs.isLeader ? '<span class="self-tag">LEADER</span>' : '<span class="self-tag">SELF</span>';
        row.tdVsSelf.className = 'vs-self';
        row.tdVsSelf.title = vs.isLeader ? 'Current leader — click a boat\'s star to compare against it instead' : '';
      } else if (vs.type === 'countdown') {
        const behind = vs.remainingMs < 0;
        const who = vs.isLeader ? 'The leader' : 'Self';
        row.tdVsSelf.textContent = (behind ? '-' : '') + fmtDuration(Math.abs(vs.remainingMs));
        row.tdVsSelf.className = 'vs-self ' + (behind ? 'behind' : 'ahead');
        row.tdVsSelf.title = behind
          ? `${who} would already finish behind this boat on corrected time`
          : `Time ${who.toLowerCase()} has left to finish and still beat this boat on corrected time`;
      } else {
        const who = vs.isLeader ? 'leader' : 'self';
        row.tdVsSelf.textContent = formatSignedDuration(vs.gapMs);
        row.tdVsSelf.className = 'vs-self ' + (vs.gapMs >= 0 ? 'ahead' : 'behind');
        row.tdVsSelf.title = `Corrected-time gap to the ${who} (positive = ${who} ahead)`;
      }

      row.finishNormalWrap.hidden = b.dnf || b.dns;
      row.dnfWrap.hidden = !b.dnf;
      row.dnsWrap.hidden = !b.dns;
      if (b.dnf) {
        row.dnfPosSpan.textContent = b.dnfPosition
          ? `at ${b.dnfPosition.lat.toFixed(4)}°, ${b.dnfPosition.lon.toFixed(4)}°`
          : 'position unknown';
      } else if (!b.dns) {
        if (document.activeElement !== row.finishTimeInput) {
          row.finishTimeInput.value = raceState.multiDay
            ? tsToDateTimeInputValue(b.finishTime)
            : tsToTimeInputValue(b.finishTime);
        }
        const canFinish = !!raceState.startTime;
        row.finishTimeInput.disabled = !canFinish;
        row.finishNowBtn.disabled = !canFinish;
        row.finishClearBtn.disabled = !canFinish || !b.finishTime;
        row.finishDnfBtn.disabled = !canFinish;
        // DNS (unlike DNF) is meaningful before the race has even started —
        // it's how a known no-show gets recorded — so it's never disabled.
      }
    });

    const seen = new Set(boats.map((b) => b.boatId));
    rows.forEach((row, boatId) => {
      if (!seen.has(boatId)) {
        row.tr.remove();
        rows.delete(boatId);
      }
    });
  }

  raceSelect.addEventListener('change', () => selectRace(raceSelect.value));
  newRaceBtn.addEventListener('click', openNewRaceForm);
  cancelNewRaceBtn.addEventListener('click', closeNewRaceForm);
  createRaceBtn.addEventListener('click', submitNewRace);
  newRaceNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitNewRace();
    if (e.key === 'Escape') closeNewRaceForm();
  });
  exportBtn.addEventListener('click', exportRace);
  exportOfflineBtn.addEventListener('click', exportOfflineTimer);
  armConfirm(deleteRaceBtn, 'Delete Race', 'Confirm Delete?', performDeleteRace);
  startBtn.addEventListener('click', startRace);
  stopBtn.addEventListener('click', stopRace);
  resumeBtn.addEventListener('click', resumeRace);
  armConfirm(resetBtn, 'Reset', 'Confirm Reset?', performResetRace);
  raceStartInput.addEventListener('change', () => {
    if (!raceStartInput.value) {
      setRaceStartTime(null);
      return;
    }
    const ts =
      raceState && raceState.multiDay
        ? dateTimeInputValueToTs(raceStartInput.value)
        : timeInputValueToTs(raceStartInput.value, (raceState && raceState.startTime) || Date.now(), false);
    setRaceStartTime(ts);
  });
  raceStartNowBtn.addEventListener('click', () => setRaceStartTime(Date.now()));
  raceStartClearBtn.addEventListener('click', () => setRaceStartTime(null));
  scheduleBtn.addEventListener('click', scheduleRace);
  cancelScheduleBtn.addEventListener('click', cancelSchedule);
  scheduleCallOffBtn.addEventListener('click', scheduleCallOff);
  cancelCallOffBtn.addEventListener('click', cancelCallOffSchedule);
  vetRefreshBtn.addEventListener('click', () => loadHandicapRegister(true));
  ktkRefreshBtn.addEventListener('click', () => loadKtkRegister(true));
  addBoatBtn.addEventListener('click', () => {
    hideSuggestions();
    addBoat();
  });
  addBoatName.addEventListener('input', () => showSuggestionsFor(addBoatName.value));
  addBoatName.addEventListener('focus', () => {
    if (addBoatName.value.trim()) showSuggestionsFor(addBoatName.value);
  });
  addBoatName.addEventListener('blur', () => hideSuggestions());
  addBoatName.addEventListener('keydown', (e) => {
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
  courseToggleBtn.addEventListener('click', () => {
    courseBody.hidden = !courseBody.hidden;
    courseToggleBtn.textContent = (courseBody.hidden ? '▸' : '▾') + ' Course & chart';
    if (!courseBody.hidden) {
      renderChart();
      renderWindShift();
      // The map may have been created (or last sized) while its container
      // was hidden or a different size — Leaflet doesn't pick that up on
      // its own.
      if (chartMap) setTimeout(() => chartMap.invalidateSize(), 0);
    }
  });
  positionsToggleBtn.addEventListener('click', () => {
    positionsBody.hidden = !positionsBody.hidden;
    positionsToggleBtn.textContent = (positionsBody.hidden ? '▸' : '▾') + ' Positions';
  });
  classToggleBtn.addEventListener('click', () => {
    classBody.hidden = !classBody.hidden;
    classToggleBtn.textContent = (classBody.hidden ? '▸' : '▾') + ' Classes (staggered starts)';
  });
  addClassBtn.addEventListener('click', addClass);
  addClassName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addClass();
    }
  });
  startTimerToggleBtn.addEventListener('click', () => {
    startTimerBody.hidden = !startTimerBody.hidden;
    startTimerToggleBtn.textContent = (startTimerBody.hidden ? '▸' : '▾') + ' Start timer';
    if (!startTimerBody.hidden) renderStartTimer();
  });
  raceImportToggleBtn.addEventListener('click', () => {
    raceImportBody.hidden = !raceImportBody.hidden;
    raceImportToggleBtn.textContent = (raceImportBody.hidden ? '▸' : '▾') + ' Import boats from Manage2Sail';
  });
  importFindClassesBtn.addEventListener('click', findImportClasses);
  importBoatsBtn.addEventListener('click', importSelectedBoats);
  addMarkBtn.addEventListener('click', () => {
    markRefs.push(buildMarkRow(null));
    renderMarkRows();
    updateMarkPickGating();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mapPickTarget) cancelMapPick();
  });
  saveCourseBtn.addEventListener('click', saveCourse);

  // Runs the replay forward at replaySpeed simulated seconds per real
  // second, on its own timer (independent of the general 1s render tick)
  // so playback still looks reasonably smooth at low speeds. Stops itself
  // once it reaches the latest recorded position — there's nothing to play
  // into beyond that until more track is recorded.
  function stopReplayPlayback() {
    replayPlaying = false;
    replayPlayBtn.textContent = '▶ Play';
    if (replayPlayTimer) {
      clearInterval(replayPlayTimer);
      replayPlayTimer = null;
    }
  }
  function replayTick() {
    const now = Date.now();
    const elapsedMs = now - replayPlayLastTick;
    replayPlayLastTick = now;
    const maxT = Number(replaySlider.max);
    if (!isFinite(maxT)) {
      stopReplayPlayback();
      return;
    }
    replayTime = Math.min(replayTime + elapsedMs * replaySpeed, maxT);
    replayTimeLabel.textContent = new Date(replayTime).toLocaleTimeString();
    if (replayTime >= maxT) stopReplayPlayback();
    renderChart();
  }
  function startReplayPlayback() {
    if (replayPlaying) return;
    // Nothing to play forward into from Live — start over from the
    // earliest recorded position instead.
    if (replayLive) {
      const minT = Number(replaySlider.min);
      if (isFinite(minT)) replayTime = minT;
    }
    replayLive = false;
    replayPlaying = true;
    replayPlayBtn.textContent = '⏸ Pause';
    replayPlayLastTick = Date.now();
    replayPlayTimer = setInterval(replayTick, 200);
    renderChart();
  }

  replaySlider.addEventListener('input', () => {
    stopReplayPlayback();
    replayLive = false;
    replayTime = Number(replaySlider.value);
    replayTimeLabel.textContent = new Date(replayTime).toLocaleTimeString();
    renderChart();
  });
  replayPlayBtn.addEventListener('click', () => {
    if (replayPlaying) stopReplayPlayback();
    else startReplayPlayback();
  });
  replaySpeedSlider.addEventListener('input', () => {
    replaySpeed = Number(replaySpeedSlider.value);
    replaySpeedLabel.textContent = replaySpeed + 'x';
  });
  replayLiveBtn.addEventListener('click', () => {
    stopReplayPlayback();
    replayLive = true;
    renderChart();
  });

  async function refreshSelfNav() {
    selfNav = await fetchSelfNav();
    if (selfNav && selfNav.windDirTrueRad != null) {
      const now = Date.now();
      windHistory.push({ t: now, rad: selfNav.windDirTrueRad });
      while (windHistory.length && now - windHistory[0].t > WIND_HISTORY_WINDOW_MS) windHistory.shift();
    }
    renderStartTimer();
    renderWindShift();
  }

  async function init() {
    await loadVetEnabled();
    await loadKtkEnabled();
    await loadRaceImportEnabled();
    await Promise.all([
      loadVessels(),
      loadBoatRegistry(),
      loadHandicapRegister(false),
      loadKtkRegister(false),
      loadWaypoints(),
      loadRacesList(),
      refreshSelfNav()
    ]);
    await loadRaceState();
    render();
    setInterval(render, 1000);
    setInterval(loadVessels, 10000);
    setInterval(refreshSelfNav, 3000);
    setInterval(() => {
      if (activeRaceId) loadRaceState();
    }, 5000);
    setInterval(loadRacesList, 15000);
  }

  init();
})();
