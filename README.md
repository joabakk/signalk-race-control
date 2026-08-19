# signalk-race-control

A [SignalK](https://signalk.org) server plugin + webapp for planning, running, and
reviewing races: elapsed and handicap-corrected time, a course chart with AIS replay,
and a live projected finishing order — during and after the race.

- **Named, plannable races** — create races ahead of time, optionally with a
  scheduled start; switch between past and upcoming races from a dropdown to
  review results later. Nothing gets overwritten by starting the next race.
- **Add/remove boats explicitly** — type a name (autocompletes against the VET
  register, the cross-race boat registry, and any live AIS/self vessel — matching
  anywhere in the name, not just the start) and click **Add Boat**. Boats aren't
  auto-populated from AIS; you control exactly who's racing.
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
- **Cross-race TCF memory for boats outside VET** — whenever a boat isn't matched in
  the VET register (or the register is disabled altogether), the TCF you set for it by
  hand is remembered by boat name and applied automatically the next time a boat with
  that name is added to any race. A boat that *is* VET-matched never has its TCF
  carried over this way — it always starts from the default until you pick a VET
  alternative or edit it again.
- **MMSI, remembered across races** — set once per boat (or picked up automatically
  from a live AIS/self vessel with a matching name), it's remembered in a small
  cross-race registry: add a boat with the same name in a later race and its MMSI
  fills in on its own.
- **Editable finish times** — click **Now** to record a finish as it happens, type a
  specific `HH:MM:SS` into the finish-time field to correct a mistimed click, or
  **Clear** to undo. Handles races that cross midnight.
- **Course & chart** — enter lat/lon for the start line, an ordered list of rounding
  marks, and the finish line (or click **Use my position** if you're sitting at that
  spot). The webapp draws them on a built-in chart, overlaid with each AIS-tracked
  boat's recorded track for the current race — drag the **replay** slider to step
  back through it, or leave it on **Live**. The course is also published as SignalK
  waypoint/route resources for any chart plotter (e.g. freeboard-sk) that reads the
  standard resources API — that part only does anything if your server has a
  resources provider installed; it's a no-op otherwise, never a failure.
- **Estimated finish time & live rank** — while a boat is still racing, if it has a
  live AIS position and speed and the race has a finish line, the plugin projects a
  finish time and corrected time from its remaining distance and speed, and ranks it
  accordingly. The distance routes around whichever marks the boat hasn't rounded yet
  (detected automatically from its recorded track passing within ~0.1nm of each mark
  in order) rather than cutting straight to the finish — accuracy still depends on
  that detection actually catching each rounding.
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
  both have finished.
- **Export to Excel** — a genuine `.xlsx` snapshot of the current standings (same
  ranking, same rows as the on-screen table: rank, boat, MMSI, TCF, elapsed,
  corrected, finish time, status), with the finish-time column rendered in your
  browser's own timezone rather than the server's.
- **Download Offline Timer** — a single self-contained `.html` file, seeded with the
  current race's boats and TCF, that runs the core of race timing (start/stop/resume/
  reset, add/remove boats, edit TCF, record finishes, DNF, self-comparison) with no
  server and no internet connection at all — a backup for keeping a race running if
  this plugin's server becomes unreachable mid-event. It saves everything to that
  browser's own local storage, so closing and reopening the same downloaded file picks
  up right where you left off. AIS boat names/positions, VET-tall lookup, and the
  course/chart all need the live server and aren't included; TCF is entered by hand
  instead. Also has its own "Download results as CSV" button.

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

1. Click **+ New Race**, give it a name (e.g. "Onsdagsseilas 3"). It becomes the
   active race, shared across every open browser tab/device.
2. Add boats by name. Each gets a default TCF of 1.0 — edit it directly, or use the
   VET-alternatives dropdown once a matching register entry is found. Set an MMSI per
   boat if you want its AIS position tracked for the chart/estimate.
3. Optionally expand **Course & chart** and enter the start line, marks (in rounding
   order — reorder with ↑/↓), and finish line, then **Save Course**.
4. Either click **Start Race** now, or set a date/time and click **Schedule Start** —
   the race starts itself automatically at that moment (even across a server restart).
5. As boats finish, click **Now** to stamp the current time, or type the exact
   `HH:MM:SS` into the finish-time field. **Clear** undoes a finish.
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
  skip the SSCA page lookup, e.g. if a club uses its own register.
- Whether the VET-tall register is used at all (`vetEnabled`, off by default) is also a plugin
  setting, not a per-race or webapp-side option — change it under
  **Server → Plugin Config → Race Control** and restart the plugin (the server does
  this automatically on save) for the webapp to pick it up.
