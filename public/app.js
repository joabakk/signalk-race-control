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
  let startLineRefs = null; // [pointRefs, pointRefs] or null
  let finishLineRefs = null;
  let markRefs = []; // [pointRefs, ...]
  let lastCourseFormRaceId = undefined; // tracks which race the course form reflects
  let replayLive = true;
  let replayTime = Date.now();

  const raceSelect = document.getElementById('raceSelect');
  const newRaceBtn = document.getElementById('newRaceBtn');
  const deleteRaceBtn = document.getElementById('deleteRaceBtn');
  const exportBtn = document.getElementById('exportBtn');
  const exportOfflineBtn = document.getElementById('exportOfflineBtn');
  const newRaceForm = document.getElementById('newRaceForm');
  const newRaceNameInput = document.getElementById('newRaceName');
  const createRaceBtn = document.getElementById('createRaceBtn');
  const cancelNewRaceBtn = document.getElementById('cancelNewRaceBtn');
  const raceArea = document.getElementById('raceArea');
  const clockEl = document.getElementById('clock');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const resumeBtn = document.getElementById('resumeBtn');
  const resetBtn = document.getElementById('resetBtn');
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

  // Combines a "HH:MM:SS" wall-clock value with the race's start date to get
  // an absolute timestamp, rolling over to the next day if the entered time
  // is earlier than the start time (so overnight races finish correctly).
  function timeInputValueToTs(value) {
    if (!value) return null;
    const parts = value.split(':').map(Number);
    const [h, m, s] = [parts[0] || 0, parts[1] || 0, parts[2] || 0];
    const base = raceState && raceState.startTime ? new Date(raceState.startTime) : new Date();
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, s, 0);
    let ts = d.getTime();
    if (raceState && raceState.startTime && ts < raceState.startTime) {
      ts += 24 * 3600 * 1000;
    }
    return ts;
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
        body: JSON.stringify({ name })
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
    if (raceState && raceState.boats) delete raceState.boats[boatId];
    rows.delete(boatId);
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

  // One name+lat+lon(+optional "use my position") row, shared by start
  // line, finish line, and mark entry.
  function buildPointRow(point) {
    const row = document.createElement('div');
    row.className = 'course-point-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'course-name-input';
    nameInput.placeholder = 'Name (optional)';
    nameInput.value = (point && point.name) || '';

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

    row.append(nameInput, latInput, lonInput, useHereBtn);
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
        // A DNF boat is out of the race — no ticking clock, no rank (sorts
        // to the bottom, same as any other boat with nothing to rank by).
        const elapsedMs = !b.dnf && raceState.startTime ? (b.finishTime || now) - raceState.startTime : null;
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
          mmsi: b.mmsi || '',
          tcf,
          finishTime: b.finishTime,
          dnf: !!b.dnf,
          dnfPosition: b.dnfPosition || null,
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
  function computeVsSelf(boats, selfBoatId) {
    const map = new Map();
    const self = boats.find((b) => b.boatId === selfBoatId);
    if (!self) return map;
    boats.forEach((b) => {
      if (b.boatId === selfBoatId) {
        map.set(b.boatId, { type: 'self' });
        return;
      }
      if (self.dnf) {
        // Self is out of the race — no meaningful comparison to make.
        map.set(b.boatId, { type: 'none' });
        return;
      }
      if (!self.finishTime && b.finishTime) {
        const thresholdElapsedMs = b.correctedMs / (self.tcf || 1);
        map.set(b.boatId, { type: 'countdown', remainingMs: thresholdElapsedMs - self.elapsedMs });
        return;
      }
      const selfVal = self.finishTime ? self.correctedMs : self.rankMs;
      const otherVal = b.finishTime ? b.correctedMs : b.rankMs;
      if (selfVal == null || otherVal == null) {
        map.set(b.boatId, { type: 'none' });
        return;
      }
      map.set(b.boatId, { type: 'gap', gapMs: otherVal - selfVal });
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

    const tdElapsed = document.createElement('td');
    const tdCorrected = document.createElement('td');
    const tdEstFinish = document.createElement('td');
    tdEstFinish.className = 'est-finish';
    const tdVsSelf = document.createElement('td');
    tdVsSelf.className = 'vs-self';

    const finishTimeInput = document.createElement('input');
    finishTimeInput.type = 'time';
    finishTimeInput.step = '1';
    finishTimeInput.className = 'finish-time-input';
    finishTimeInput.addEventListener('change', () => {
      const ts = finishTimeInput.value ? timeInputValueToTs(finishTimeInput.value) : null;
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

    tr.append(tdName, tdMmsi, tdTcf, tdVet, tdElapsed, tdCorrected, tdEstFinish, tdVsSelf, tdFinish, tdRemove);

    return {
      tr,
      selfBtn,
      nameSpan,
      tdEstFinish,
      tdVsSelf,
      mmsiInput,
      tcfInput,
      vetSelect,
      vetBadge,
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
      row.tdElapsed.textContent = fmtDuration(b.elapsedMs);
      row.tdCorrected.textContent = fmtDuration(b.correctedMs);

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
        row.tdVsSelf.textContent = raceState.selfBoatId ? '—' : '';
        row.tdVsSelf.className = 'vs-self';
        row.tdVsSelf.title = '';
      } else if (vs.type === 'self') {
        row.tdVsSelf.innerHTML = '<span class="self-tag">SELF</span>';
        row.tdVsSelf.className = 'vs-self';
        row.tdVsSelf.title = '';
      } else if (vs.type === 'countdown') {
        const behind = vs.remainingMs < 0;
        row.tdVsSelf.textContent = (behind ? '-' : '') + fmtDuration(Math.abs(vs.remainingMs));
        row.tdVsSelf.className = 'vs-self ' + (behind ? 'behind' : 'ahead');
        row.tdVsSelf.title = behind
          ? 'Self would already finish behind this boat on corrected time'
          : 'Time self has left to finish and still beat this boat on corrected time';
      } else {
        row.tdVsSelf.textContent = formatSignedDuration(vs.gapMs);
        row.tdVsSelf.className = 'vs-self ' + (vs.gapMs >= 0 ? 'ahead' : 'behind');
        row.tdVsSelf.title = 'Corrected-time gap to self (positive = self ahead)';
      }

      row.finishNormalWrap.hidden = b.dnf;
      row.dnfWrap.hidden = !b.dnf;
      if (b.dnf) {
        row.dnfPosSpan.textContent = b.dnfPosition
          ? `at ${b.dnfPosition.lat.toFixed(4)}°, ${b.dnfPosition.lon.toFixed(4)}°`
          : 'position unknown';
      } else {
        if (document.activeElement !== row.finishTimeInput) {
          row.finishTimeInput.value = tsToTimeInputValue(b.finishTime);
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
    await Promise.all([loadVessels(), loadBoatRegistry(), loadHandicapRegister(false), loadRacesList()]);
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
