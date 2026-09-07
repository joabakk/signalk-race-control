# signalk-race-control

A [SignalK](https://signalk.org) server plugin + webapp for planning, running, and
reviewing races: elapsed and handicap-corrected time, a course chart with AIS replay,
and a live projected finishing order — during and after the race.

- **Named, plannable races** — create races ahead of time, optionally with a
  scheduled start; switch between past and upcoming races from a dropdown to
  review results later. Nothing gets overwritten by starting the next race.
- **Overnight / multi-day races** — most races are same-day, so this is off by
  default; a normal finish-time entry (like `21:14:07`) already rolls over to the
  next calendar day on its own if it's earlier than the start, so an ordinary race
  finishing just after midnight needs nothing special. Check **Overnight / multi-day
  race** when creating one instead (fixed for that race, not changeable afterward)
  only once a single automatic day-rollover isn't enough — a multi-day distance
  race, say — and finish/start times are then entered with a full date, not just a
  time-of-day. Elapsed/corrected time already display past 24 hours either way (e.g.
  `30:00:00`).
- **Individual start times** — override the race's single start time for one boat at
  a time (in its own **Start time** column, right next to Finish time): for a
  staggered/pursuit start, or to correct a boat that didn't actually get away with
  the fleet. Left blank, a boat just uses the race's own start time as before.
  Starting or resetting the race clears every boat's override along with its finish
  time, ready for a clean re-run.
- **Add/remove boats explicitly** — type a name (autocompletes against the VET
  register, the cross-race boat registry, and any live AIS/self vessel — matching
  anywhere in the name, not just the start) and click **Add Boat**. Boats aren't
  auto-populated from AIS; you control exactly who's racing. Rows stay in the order
  boats were added — adding or removing one doesn't reshuffle the rest — until the
  race actually starts, when the table switches to rank order; whichever boat is
  marked **self** always stays on top regardless of phase. The **Boat** column stays
  pinned in place while scrolling sideways through the rest of the (wide) table, and
  the page itself isn't width-capped, so a larger screen shows more columns at once
  without scrolling.
- **Elapsed / corrected time** — Time-on-Time correction: `corrected = elapsed × TCF`,
  where TCF is edited per boat directly in the webapp and persisted server-side,
  shared by everyone viewing the page.
- **VET-tall import** — pick a boat's handicap straight from SSCA's VET-tall register.
  VET-tall ("veteranbåt-tall") is [Seilskøyteklubben Colin
  Archer](https://ssca.no)'s (SSCA) own handicap register specifically for
  traditional, gaff-rigged/classic wooden sailing boats, published as a downloadable
  spreadsheet on [ssca.no/aktiviteter/vet-tall](https://ssca.no/aktiviteter/vet-tall)
  — this plugin resolves and downloads whichever sheet is linked there live, so it
  tracks the current year's numbers automatically without needing an update. Each
  sail-configuration variant (e.g. with/without topsail) is a separate alternative in
  a per-boat dropdown; picking one applies that exact TCF, and the dropdown keeps
  showing whichever alternative is currently in effect. Since it's specific to
  traditional boats, it won't have every boat in a mixed fleet, so it's **off by
  default** — turn it on in the plugin's settings (`vetEnabled`) for clubs that
  actually race under VET-tall; see **Cross-race TCF memory** below for what happens
  to handicaps while it's off.
- **KTK import** — the same idea as VET-tall, for [Klassisk Treseiler
  Klubb](http://klassisktreseilerklubb.blogspot.com/)'s (KTK) own KLR handicap
  register, published each season as a table in a blog post — this plugin always
  reads whichever post is most recent, so it tracks the current season without
  needing an update. A KLR number isn't a TCF directly: corrected time is elapsed ×
  (KLR / 100), so that conversion happens automatically. Off by default — turn it on
  in the plugin's settings (`ktkEnabled`) for clubs that race under KLR. If a boat is
  listed in **both** VET-tall and KTK, the dropdown shows alternatives from both
  (labeled by which is which), rather than picking one register over the other.
- **Cross-race TCF memory for boats outside every register** — whenever a boat isn't
  matched in VET-tall or KTK (or both are disabled), the TCF you set for it by hand is
  remembered by boat name and applied automatically the next time a boat with that
  name is added to any race. A boat matched in either register never has its TCF
  carried over this way — it always starts from the default until you pick an
  alternative from the dropdown or edit it again.
- **MMSI and sail number, remembered across races** — set once per boat (MMSI can
  also be picked up automatically from a live AIS/self vessel with a matching name),
  both are remembered in a small cross-race registry: add a boat with the same name
  in a later race and its MMSI and sail number fill in on their own.
- **Import a whole fleet from Manage2Sail** — off by default (`raceImportEnabled` in
  the plugin's settings, alongside `vetEnabled`); once turned on, an **Import boats
  from Manage2Sail** section lets you paste a Manage2Sail event URL, pick one or more
  of its classes, and add every entry in them as a boat in the current race. Since a
  class's published handicap number isn't always a directly-usable Time-on-Time
  factor — Yardstick numbers, for instance, run the opposite direction (lower number
  = faster boat) and need `TCF = 100 / number` (or `1000 /` for the RYA scale) rather
  than being used as-is — the plugin converts it automatically once it recognizes the
  system. If a class's numbers don't clearly match a known system's scale, you're
  asked to pick which one applies (e.g. Yardstick vs. Portsmouth Yardstick) before
  anything is imported for it; anything else unrecognized (ORC, IRC, ...) is used
  as-is, same as before. Re-importing updates TCF on boats it already added (matched
  by name) instead of duplicating them. Not every entry has a named boat — where
  Manage2Sail has no boat name, the sail number is used as the identifier instead of
  falling back to the skipper's name, and every imported boat's sail number is also
  set in its own **Sail #** column (editable directly, like MMSI) whether or not it
  ended up as the name.
- **Editable finish times** — click **Now** to record a finish as it happens, type a
  specific `HH:MM:SS` into the finish-time field to correct a mistimed click, or
  **Clear** to undo. Handles races that cross midnight.
- **Start timer** — once a start line is set and a start is scheduled, an expandable
  **Start timer** panel shows a countdown to the gun alongside three live numbers for
  this vessel specifically (from its own SignalK GPS/speed, not any other tracked
  boat): distance to the line, ETA to reach it at current speed, and **time to burn** —
  the countdown minus that ETA. Positive means time to spare (you'll arrive early, so
  slow down or take a longer approach); negative means you're behind schedule to make
  the line before the gun. Disappears once the race actually starts, since the
  pre-start approach is moot by then.
- **Course & chart** — enter lat/lon for the start line, an ordered list of rounding
  marks, and the finish line (or click **Use my position** if you're sitting at that
  spot, or type a name to autocomplete against existing SignalK waypoints — e.g. ones
  already placed from a chart plotter — and pick one to fill in its position). The
  webapp draws them on a built-in chart, overlaid with each AIS-tracked boat's
  recorded track for the current race — drag the **replay** slider to step back
  through it, or leave it on **Live**. Click **Play** to have it step through on its own
  instead, at whatever speed the adjoining slider is set to (1x-60x); it starts over
  from the earliest recorded position when played from Live (there's nothing to play
  forward into from there), stops on its own once it catches up to the latest one, and
  dragging the main slider or clicking **Live** stops it early. Every actual recorded
  position (an AIS sample,
  or a manually-recorded mark rounding) shows as a small dot along the track, so it's
  clear which points are real; wherever the slider sits between two of them, the boat's
  position is linearly interpolated and drawn as a hollow ring instead of a solid dot,
  so an in-between position always reads as estimated rather than observed. It falls
  back to just the last real position (no ring) instead of interpolating across a gap
  longer than 5 minutes — AIS dropping out, or a mark rounding recorded far from any
  real fix — since a straight line across a gap that long would be a guess, not an
  estimate. The course is also published as SignalK
  waypoint/route resources for any chart plotter (e.g. freeboard-sk) that reads the
  standard resources API — both directions (reading existing waypoints for the
  autocomplete, and publishing the saved course) only do anything if your server has a
  resources provider installed; they're a no-op otherwise, never a failure.
- **Estimated finish time & live rank** — while a boat is still racing, if it has a
  live AIS position and speed and the race has a finish line, the plugin projects a
  finish time and corrected time from its remaining distance and speed, and ranks it
  accordingly. The distance routes around whichever marks the boat hasn't rounded yet
  (detected automatically from its recorded track passing within a configurable radius
  — `markRoundingRadiusM`, 100m by default — of each mark in order) rather than
  cutting straight to the finish — accuracy still depends on that detection actually
  catching each rounding. A rounding can also be recorded by hand: each boat's row has
  a numbered pill per mark in the **Marks** column — click one to mark it rounded right
  now, click again to clear it — for a boat with no MMSI/AIS at all, or to correct one
  the automatic detection missed. Either source counts toward the same rounding, and
  for a boat still racing with no AIS-based estimate to rank by, marks rounded (by
  either method) takes priority over raw elapsed time, so a boat further round the
  course still ranks ahead even without live tracking. A manual rounding also records a
  position for the replay chart — the boat's live position if it has AIS, otherwise the
  mark's own position (a reasonable stand-in, since rounding a mark means being at it)
  — so even a boat with no AIS at all shows up on the chart at each mark it's recorded
  rounding.
- **Stop / call off the race** — freezes elapsed/corrected time for everyone without
  touching boats, finish times, or the course (unlike Reset, which clears the race
  back to not-started), and marks every boat that hadn't finished as **DNF**,
  capturing its last known AIS position if one's available. You can also schedule a
  call-off for a future time (mirrors Schedule Start), and mark or un-mark an
  individual boat DNF by hand at any point, independent of the whole race. There's no
  true pause: **Resume** discards the stop, un-DNFs everyone it DNF'd, and the clock
  jumps straight back to real elapsed time — the time spent stopped isn't excluded
  from anyone's result. Recording a real finish time on a DNF'd boat clears its DNF.
- **Compare to a "self" boat** — click the star next to a boat's name to mark it as
  self. Every other boat then shows, in the **vs Self** column: a live-ticking
  countdown to the moment self would tie them on corrected time if that boat has
  already finished (going negative, in red, once self can no longer catch up even by
  finishing instantly), or the current corrected-time gap if both are still racing or
  both have finished. With no boat marked self, the column instead compares everyone
  against the current **leader** (tagged accordingly), so it's never just blank.
- **Export to Excel** — a genuine `.xlsx` snapshot of the current standings (same
  ranking, same rows as the on-screen table: rank, boat, sail number, MMSI, TCF,
  start time, elapsed, corrected, finish time, status), with the time columns
  rendered in your browser's own timezone rather than the server's (and with the
  date included, for a multi-day race).
- **Download Offline Timer** — a single self-contained `.html` file, seeded with the
  current race's boats, TCF, and multi-day setting, that runs the core of race timing
  (start/stop/resume/reset, add/remove boats, edit TCF, individual start times,
  record finishes, DNF, self-comparison) with no server connection to this plugin at
  all — including its own editable **Race start** field (Now/Clear, right under the
  Start/Stop/Resume/Reset buttons) for backdating or correcting the race's start time
  directly, without needing to click Start Race and lose already-recorded progress —
  a backup for keeping a race running if
  this plugin's server becomes unreachable mid-event. It saves everything to that
  browser's own local storage, so closing and reopening the same downloaded file picks
  up right where you left off. If VET-tall is enabled, the register is seeded in at
  download time and a **Refresh VET register** link lets the offline page re-fetch the
  current sheet straight from Google Sheets (no plugin server needed for that — just
  whatever internet connection the browser has), with the same alternatives dropdown
  and autocomplete as the main webapp. If KTK is enabled too, its KLR numbers are
  seeded in the same way, but — since KTK's own page doesn't allow that kind of direct
  browser fetch — only as a snapshot from download time, with no offline refresh
  equivalent. AIS boat names/positions, the course/chart, and
  importing a fleet from Manage2Sail still need the live server (Manage2Sail's own API
  doesn't allow browser-side fetches at all) — TCF is entered by hand for anything the
  VET register doesn't cover. Also has its own "Download results as CSV" button.

## Install

Install this directory's dependencies once (needed for the Excel export), then copy
(or symlink) it into your SignalK server's `node_modules`, e.g.:

```bash
cd /path/to/race-control && npm install
cd ~/.signalk/node_modules
ln -s /path/to/race-control signalk-race-control
```

Then restart the SignalK server, enable "Race Control" under
**Server → Plugin Config**, and open the webapp from the SignalK **Webapps** list
(or navigate to `/signalk-race-control/`).

## Using it

1. Click **+ New Race**, give it a name (e.g. "Onsdagsseilas 3"), and check
   **Overnight / multi-day race** only if a single automatic day-rollover on finish
   times won't be enough (can't be changed after creating the race) — leave it
   unchecked for the usual same-day race, even one that finishes after midnight. It
   becomes the active race, shared across every open browser tab/device.
2. Add boats by name. Each gets a default TCF of 1.0 — edit it directly, or use the
   VET-alternatives dropdown once a matching register entry is found. Set an MMSI per
   boat if you want its AIS position tracked for the chart/estimate.
3. Optionally expand **Course & chart** and enter the start line, marks (in rounding
   order — reorder with ↑/↓), and finish line, then **Save Course**.
4. Either click **Start Race** now, or set a date/time and click **Schedule Start** —
   the race starts itself automatically at that moment (even across a server restart).
   Clicked it a little late? Fix the recorded moment directly in the **Race start**
   field next to the clock (Now/Clear) — unlike Reset, it never touches any boat's
   finish time, DNF, or individual start override. If a particular boat actually
   started at a different moment (a staggered/pursuit start, or a correction), set
   its own time in the **Start time** column instead of leaving it to follow the
   race's start.
5. As boats finish, click **Now** to stamp the current time, or type the exact time
   (plus date, for a multi-day race) into the finish-time field. **Clear** undoes a
   finish.
6. **Stop** calls the race off now (freezes the clock, DNFs whoever hasn't finished);
   **Schedule Call-off** does the same at a future time instead. **Resume** discards
   a stop and un-DNFs whoever it DNF'd. **Reset** (click once to arm, again to
   confirm) clears this race's start/finish/DNF state and recorded tracks entirely so
   it can be re-run — boats and TCF values are kept.
7. Click a boat's ☆ to mark it **self** and see the **vs Self** column fill in for
   every other boat.
8. **Export to Excel** downloads the current standings as a `.xlsx` file at any time
   — before, during, or after the race. **Download Offline Timer** grabs a standalone
   backup copy of the race instead — worth doing before the start if you want a safety
   net in case the server drops out mid-race.
9. Switch races anytime via the dropdown at the top to review an earlier race's
   results, or plan the next one. **Delete Race** (arm-then-confirm) removes one.

Corrected time is shown live throughout the race (using elapsed-so-far), and freezes
once a boat's finish time is recorded. The **Est. finish** column shows a projected
finish time/rank for boats still racing, when the plugin has enough to estimate one.

## Notes

- All race state (names, schedules, boats, TCF, finish times, course, recorded
  tracks) is persisted to disk under the plugin's data directory, so it survives a
  server restart.
- While a race is running, every unfinished boat with an MMSI gets a position sample
  recorded roughly every 15 seconds — that's the track the chart replays. Recording
  stops for a boat once it finishes; **Start**/**Reset** clear previously recorded
  tracks for a fresh run.
- The VET-tall source page can be overridden in the plugin's settings
  (`handicapSourceUrl`) — point it at a specific year's Google Sheet link directly to
  skip the SSCA page lookup, e.g. if a club uses its own register. KTK's source page
  can likewise be overridden (`ktkSourceUrl`) — point it at a specific post directly to
  skip the label-listing lookup.
- Whether the VET-tall register is used at all (`vetEnabled`, off by default) is also a
  plugin setting, not a per-race or webapp-side option — same for KTK's KLR register
  (`ktkEnabled`) — change either under **Server → Plugin Config → Race Control** and
  restart the plugin (the server does this automatically on save) for the webapp to
  pick it up.
- The mark-rounding radius used for the estimated finish time and remaining-distance
  calculations (`markRoundingRadiusM`, 100m by default) is also a plugin setting —
  loosen it for a fleet with noisier AIS tracks, or tighten it if marks sit close
  together and a boat's radius circles are overlapping.
