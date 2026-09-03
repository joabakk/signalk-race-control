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
  let handicapVersion = 0; // bumped each successful VET-register load
  let vetEnabled = false; // plugin config setting (Server -> Plugin Config), read-only here; off by default
  let raceImportEnabled = false; // plugin config setting, same pattern as vetEnabled
  let importEventId = null; // Manage2Sail event id from the last successful "Find Classes" lookup
  let importClasses = []; // [{id, name}] from that same lookup
  let importSystemOverrides = {}; // classId -> handicap system key, from the disambiguation picker
  let importHandicapSystems = null; // [{key, label}], fetched lazily on first ambiguity
  let startLineRefs = null; // [pointRefs, pointRefs] or null
  let finishLineRefs = null;
  let markRefs = []; // [pointRefs, ...]
  let lastCourseFormRaceId = undefined; // tracks which race the course form reflects
  let replayLive = true;
  let replayTime = Date.now();
  let waypoints = []; // [{id, name, lat, lon}] from SignalK resources, for the course editor's "Pick a waypoint" dropdown

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
  const addBoatRow = document.getElementById('addBoatRow');
  const addBoatName = document.getElementById('addBoatName');
  const addBoatBtn = document.getElementById('addBoatBtn');
  const boatsTable = document.getElementById('boatsTable');
  const boatsBody = document.getElementById('boatsBody');
  const emptyMsg = document.getElementById('emptyMsg');
  const noRacesMsg = document.getElementById('noRacesMsg');
  const addBoatSuggestions = document.getElementById('addBoatSuggestions');
  const courseSection = document.getElementById('courseSection');
  const courseToggleBtn = document.getElementById('courseToggleBtn');
  const courseBody = document.getElementById('courseBody');
  const startLineRowsEl = document.getElementById('startLineRows');
  const finishLineRowsEl = document.getElementById('finishLineRows');
  const marksRowsEl = document.getElementById('marksRows');
  const addMarkBtn = document.getElementById('addMarkBtn');
  const saveCourseBtn = document.getElementById('saveCourseBtn');
  const courseStatusText = document.getElementById('courseStatusText');
  const courseChart = document.getElementById('courseChart');
  const replayControls = document.getElementById('replayControls');
  const replaySlider = document.getElementById('replaySlider');
  const replayTimeLabel = document.getElementById('replayTimeLabel');
  const replayLiveBtn = document.getElementById('replayLiveBtn');
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
    // status text + refresh link) and the whole "VET alternatives" table
    // column disappear entirely.
    vetStatusLine.hidden = !vetEnabled;
    vetAlternativesTh.hidden = !vetEnabled;
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
      lastCourseFormRaceId = id;
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
    const ts = new Date(callOffInput.value).getTime();
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
    const ts = new Date(scheduleInput.value).getTime();
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
    try {
      const boat = await fetchJSON(`${API}/races/${encodeURIComponent(activeRaceId)}/boats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mmsi })
      });
      raceState.boats[boat.id] = boat;
      addBoatName.value = '';
      addBoatName.focus();
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
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

  // Generic substring-match autocomplete, wiring `input` to `dropdown` (a
  // hidden .suggestions element already sitting next to it in the DOM) —
  // same matching/keyboard-nav behavior as the boat-name autocomplete
  // above, but with its own closure-local item/selection state so several
  // instances (one per course point row) can coexist without stepping on
  // each other the way sharing the boat autocomplete's module-level state
  // would.
  function attachAutocomplete(input, dropdown, getPool, onSelect) {
    let items = [];
    let activeIndex = -1;

    function hide() {
      dropdown.hidden = true;
      dropdown.innerHTML = '';
      items = [];
      activeIndex = -1;
    }
    function renderActive() {
      Array.from(dropdown.children).forEach((el, i) => el.classList.toggle('active', i === activeIndex));
    }
    function select(item) {
      onSelect(item);
      hide();
    }
    function showFor(query) {
      const q = query.trim().toLowerCase();
      if (!q) {
        hide();
        return;
      }
      const matches = getPool()
        .filter((it) => it.name.toLowerCase().includes(q))
        .slice(0, 20);
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

  // One name+lat+lon(+optional "use my position") row, shared by start
  // line, finish line, and mark entry. The name field autocompletes against
  // existing SignalK waypoints (e.g. ones already placed on a chart
  // plotter) — picking one fills in lat/lon (and the name) from it, so a
  // start/mark/finish position doesn't have to be typed by hand if a
  // waypoint for it already exists.
  function buildPointRow(point) {
    const row = document.createElement('div');
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

    const useHereBtn = document.createElement('button');
    useHereBtn.type = 'button';
    useHereBtn.className = 'secondary';
    useHereBtn.textContent = 'Use my position';
    useHereBtn.addEventListener('click', async () => {
      const pos = await fetchSelfPosition();
      if (pos) {
        latInput.value = pos.lat;
        lonInput.value = pos.lon;
      } else {
        setCourseStatus('Could not read a current position from SignalK.', true);
      }
    });

    attachAutocomplete(
      nameInput,
      nameSuggestions,
      () => waypoints,
      (wp) => {
        nameInput.value = wp.name;
        latInput.value = wp.lat;
        lonInput.value = wp.lon;
      }
    );

    row.append(nameWrap, latInput, lonInput, useHereBtn);
    return { row, nameInput, latInput, lonInput };
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
    refs.row.append(upBtn, downBtn, removeBtn);
    return refs;
  }

  // Repopulates the course form from raceState.course — only called on race
  // switch/load and after a successful save, never on the 1s/5s polling
  // ticks, so it can't interrupt someone mid-edit (same reasoning as the
  // boat-row focus guards above, just at the level of "which race is this
  // form even showing").
  function loadCourseFormFromRace() {
    const c = (raceState && raceState.course) || { startLine: null, marks: [], finishLine: null };

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
    setCourseStatus('');
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

  // Simple equirectangular fit (longitude scaled by cos(mean latitude) so
  // the small area a race course covers looks roughly to-scale) mapped into
  // the SVG's viewBox with padding. Re-derived on every render rather than
  // held fixed, since the bounding box grows as tracks come in.
  function buildProjection(points, width, height, padding) {
    const meanLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const cosLat = Math.cos((meanLat * Math.PI) / 180) || 1;
    const xs = points.map((p) => p.lon * cosLat);
    const ys = points.map((p) => -p.lat);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = Math.max(maxX - minX, 1e-9);
    const spanY = Math.max(maxY - minY, 1e-9);
    const scale = Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanY);
    const offX = padding + (width - 2 * padding - spanX * scale) / 2;
    const offY = padding + (height - 2 * padding - spanY * scale) / 2;
    return (p) => ({ x: offX + (p.lon * cosLat - minX) * scale, y: offY + (-p.lat - minY) * scale });
  }

  function renderChart() {
    if (!raceState) {
      courseChart.innerHTML = '';
      replayControls.hidden = true;
      return;
    }
    const course = raceState.course || { startLine: null, marks: [], finishLine: null };
    const boatsWithTrack = Object.values(raceState.boats || {}).filter((b) => b.track && b.track.length);

    const allPoints = [];
    if (course.startLine) allPoints.push(...course.startLine);
    if (course.finishLine) allPoints.push(...course.finishLine);
    allPoints.push(...course.marks);
    boatsWithTrack.forEach((b) => allPoints.push(...b.track));

    if (allPoints.length < 2) {
      courseChart.innerHTML =
        '<text x="400" y="250" text-anchor="middle" fill="var(--muted)" font-size="14">Add a course, then start the race, to see the chart here</text>';
      replayControls.hidden = true;
      return;
    }

    const width = 800;
    const height = 500;
    const proj = buildProjection(allPoints, width, height, 40);
    const parts = [];

    const coursePts = [];
    if (course.startLine) coursePts.push({ lat: (course.startLine[0].lat + course.startLine[1].lat) / 2, lon: (course.startLine[0].lon + course.startLine[1].lon) / 2 });
    course.marks.forEach((m) => coursePts.push(m));
    if (course.finishLine) coursePts.push({ lat: (course.finishLine[0].lat + course.finishLine[1].lat) / 2, lon: (course.finishLine[0].lon + course.finishLine[1].lon) / 2 });
    if (coursePts.length >= 2) {
      const d = coursePts.map((p, i) => (i === 0 ? 'M' : 'L') + proj(p).x.toFixed(1) + ',' + proj(p).y.toFixed(1)).join(' ');
      parts.push(`<path d="${d}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4,4" />`);
    }

    if (course.startLine) {
      const a = proj(course.startLine[0]);
      const b = proj(course.startLine[1]);
      parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="var(--good)" stroke-width="2" />`);
      parts.push(`<text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 8}" fill="var(--good)" font-size="11" text-anchor="middle">Start</text>`);
    }
    if (course.finishLine) {
      const a = proj(course.finishLine[0]);
      const b = proj(course.finishLine[1]);
      parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="var(--accent)" stroke-width="2" />`);
      parts.push(`<text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 8}" fill="var(--accent)" font-size="11" text-anchor="middle">Finish</text>`);
    }
    course.marks.forEach((m, i) => {
      const p = proj(m);
      parts.push(`<circle cx="${p.x}" cy="${p.y}" r="5" fill="var(--bg)" stroke="var(--text)" stroke-width="1.5" />`);
      parts.push(`<text x="${p.x}" y="${p.y - 10}" fill="var(--text)" font-size="11" text-anchor="middle">${escapeHtml(m.name || String(i + 1))}</text>`);
    });

    let minT = Infinity;
    let maxT = -Infinity;
    boatsWithTrack.forEach((b) => {
      b.track.forEach((pt) => {
        if (pt.t < minT) minT = pt.t;
        if (pt.t > maxT) maxT = pt.t;
      });
    });
    const cutoff = replayLive ? Infinity : replayTime;

    boatsWithTrack.forEach((b, idx) => {
      const color = CHART_PALETTE[idx % CHART_PALETTE.length];
      const pts = b.track.filter((pt) => pt.t <= cutoff);
      if (!pts.length) return;
      const d = pts.map((pt, i) => (i === 0 ? 'M' : 'L') + proj(pt).x.toFixed(1) + ',' + proj(pt).y.toFixed(1)).join(' ');
      parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.85" />`);
      const last = proj(pts[pts.length - 1]);
      parts.push(`<circle cx="${last.x}" cy="${last.y}" r="4" fill="${color}" />`);
      parts.push(`<text x="${(last.x + 7).toFixed(1)}" y="${(last.y + 3).toFixed(1)}" fill="${color}" font-size="10">${escapeHtml(b.name)}</text>`);
    });

    courseChart.innerHTML = parts.join('');

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

  function boatList() {
    if (!raceState) return [];
    const now = raceNow();
    return Object.values(raceState.boats || {})
      .map((b) => {
        // A boat with its own start time (a staggered/pursuit start, or a
        // correction) uses that instead of the race's single start time.
        const start = b.startTime != null ? b.startTime : raceState.startTime;
        // A DNF boat is out of the race — no ticking clock, no rank (sorts
        // to the bottom, same as any other boat with nothing to rank by).
        // A start time still in the future (e.g. a later pursuit-start
        // group) means this boat hasn't actually started yet either.
        const elapsedMs = !b.dnf && start && start <= now ? (b.finishTime || now) - start : null;
        const tcf = b.tcf != null ? b.tcf : 1.0;
        const correctedMs = elapsedMs != null ? elapsedMs * tcf : null;
        const estimate = b.estimate || null;
        // Finished boats rank on their real corrected time; still-racing
        // boats rank on the projected corrected time when the server could
        // estimate one (course + live position/speed available), otherwise
        // fall back to elapsed-so-far like before.
        const rankMs = b.dnf ? null : b.finishTime ? correctedMs : estimate ? estimate.estCorrectedMs : correctedMs;
        return {
          boatId: b.id,
          name: b.name,
          sailNumber: b.sailNumber || '',
          mmsi: b.mmsi || '',
          tcf,
          startTime: b.startTime,
          finishTime: b.finishTime,
          dnf: !!b.dnf,
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
      if (self.dnf) {
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
    tdVet.hidden = !vetEnabled;
    tdVet.append(vetSelect, vetBadge);

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

    const finishNormalWrap = document.createElement('div');
    finishNormalWrap.className = 'finish-cell';
    finishNormalWrap.append(finishTimeInput, finishNowBtn, finishClearBtn, finishDnfBtn);

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

    const tdFinish = document.createElement('td');
    tdFinish.append(finishNormalWrap, dnfWrap);

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

    tr.append(tdName, tdSailNumber, tdMmsi, tdTcf, tdVet, tdStart, tdElapsed, tdCorrected, tdMarks, tdEstFinish, tdVsSelf, tdFinish, tdRemove);

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
      dnfWrap,
      dnfPosSpan,
      vetHandicapVersion: -1
    };
  }

  // Rebuilds a row's VET-alternatives <select> from the current register —
  // only called when the register itself (re)loads, not every render tick,
  // so an open dropdown or mid-pick isn't disrupted every second. Never
  // called at all while vetEnabled is false (see the call site) — the
  // "VET alternatives" column is hidden entirely in that case.
  function refreshVetAlternatives(row, boatName) {
    const entry = handicapBoats.find((h) => h.name.toLowerCase() === boatName.trim().toLowerCase());
    row.vetSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = entry ? 'Pick VET…' : 'No VET match';
    row.vetSelect.appendChild(placeholder);
    row.vetSelect.disabled = !entry;
    if (entry) {
      entry.vets.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = String(v.value);
        opt.textContent = `${v.label}: ${v.value}`;
        row.vetSelect.appendChild(opt);
      });
      const notValid = /ikke/i.test(entry.validity || '');
      row.vetBadge.textContent = entry.validity ? (notValid ? '⚠ ' + entry.validity : entry.validity) : '';
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
    raceImportSection.hidden = !raceState || !raceImportEnabled;

    if (!raceState) {
      emptyMsg.hidden = true;
      renderChart();
      return;
    }

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

    scheduleInput.disabled = !!raceState.startTime;
    scheduleBtn.disabled = !!raceState.startTime;
    cancelScheduleBtn.hidden = !raceState.scheduledStart || !!raceState.startTime;

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
      let row = rows.get(b.boatId);
      if (!row) {
        row = buildRow(b.boatId);
        rows.set(b.boatId, row);
      }
      // Moving an already-attached node to its sorted position keeps it
      // intact (focus, in-progress edits) rather than recreating it — but
      // the move itself still resets a text cursor and closes an open
      // <select>, so skip it entirely while the user has something in this
      // row focused. It'll snap to its correct position as soon as they're
      // done (next render after focus moves away).
      if (!row.tr.contains(document.activeElement)) {
        boatsBody.appendChild(row.tr);
      }

      row.tr.classList.toggle('finished', !!b.finishTime);
      row.tr.classList.toggle('dnf', !!b.dnf);
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
      if (vetEnabled && row.vetHandicapVersion !== handicapVersion && document.activeElement !== row.vetSelect) {
        refreshVetAlternatives(row, b.name);
        row.vetHandicapVersion = handicapVersion;
      }
      syncVetSelectValue(row, b.tcf);
      if (document.activeElement !== row.startTimeInput) {
        row.startTimeInput.value = raceState.multiDay ? tsToDateTimeInputValue(b.startTime) : tsToTimeInputValue(b.startTime);
      }
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

      row.finishNormalWrap.hidden = b.dnf;
      row.dnfWrap.hidden = !b.dnf;
      if (b.dnf) {
        row.dnfPosSpan.textContent = b.dnfPosition
          ? `at ${b.dnfPosition.lat.toFixed(4)}°, ${b.dnfPosition.lon.toFixed(4)}°`
          : 'position unknown';
      } else {
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
    if (!courseBody.hidden) renderChart();
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
  });
  saveCourseBtn.addEventListener('click', saveCourse);
  replaySlider.addEventListener('input', () => {
    replayLive = false;
    replayTime = Number(replaySlider.value);
    replayTimeLabel.textContent = new Date(replayTime).toLocaleTimeString();
    renderChart();
  });
  replayLiveBtn.addEventListener('click', () => {
    replayLive = true;
    renderChart();
  });

  async function init() {
    await loadVetEnabled();
    await loadRaceImportEnabled();
    await Promise.all([loadVessels(), loadBoatRegistry(), loadHandicapRegister(false), loadWaypoints(), loadRacesList()]);
    await loadRaceState();
    render();
    setInterval(render, 1000);
    setInterval(loadVessels, 10000);
    setInterval(() => {
      if (activeRaceId) loadRaceState();
    }, 5000);
    setInterval(loadRacesList, 15000);
  }

  init();
})();
