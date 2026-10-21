# Changelog

All notable changes to `signalk-race-control`, newest first.

## 0.12.12 (2026-10-21)
- Declare access levels for every plugin route with Signal K's `router.access()`: `GET` is `readonly`, everything else `readwrite`. Signal K 2.x makes undeclared `/plugins/<id>/...` routes admin-only, which broke the webapp for non-admin tokens (e.g. behind signalk-navico-embedder on an MFD). Falls back to the plain router on servers without `router.access`; the reserved `/config` route is unchanged
- The webapp now tells 401 ("Not signed in") from 403 ("Not allowed") and names the method and path that failed; the MFD tile shows "no data" for an empty result and only reports real access errors
- README: route/access table and the embedder's `extraPluginPaths` (`race-control`)
- Tests for the registered access levels

## 0.12.11 (2026-10-18)
- A scheduled race whose start time has passed untouched is now taken as started at that time (backstop to the start timer, checked every tick and whenever a race is read)
- A scheduled call-off whose time has passed untouched is likewise taken as having happened at that time
- The time of a call-off that already happened can be corrected (the call-off box stays usable and shows it; new `PUT /races/:id/stopTime`)
- Finish times can be entered or corrected after a call-off, including for boats the call-off marked DNF (a real finish supersedes the DNF); the DNF/DNS buttons hide once a boat is already marked

## 0.12.10 (2026-10-14)
- Drop the `exceljs` dependency: the Excel export now uses a small built-in `.xlsx` writer, so the plugin has no runtime dependencies (and no `npm audit` findings for installers). `overrides` only apply to the project that declares them, so the earlier `uuid` override never protected installed copies

## 0.12.9 (2026-10-13)
- Patch `brace-expansion` (via `exceljs`) to fix the npm audit finding
- Fix the MFD tile showing "No active race" over a live race (its stylesheet ignored the `hidden` attribute)
- Add this changelog and App Store screenshots

## 0.12.8 (2026-10-12)
- Split the Excel export by class

## 0.12.7 (2026-10-11)
- Allow editing class start times before the race starts

## 0.12.6 (2026-09-20)
- Add read-only MFD tile webapp for signalk-mfd-plugin

## 0.12.5 (2026-09-20)
- Add optional buddy-list registration when adding a boat

## 0.12.4 (2026-09-20)
- Fix webapp icon resolution via signalk.appIcon

## 0.12.3 (2026-09-20)
- Add a favicon: a racing mark with a clock hand

## 0.12.2 (2026-09-19)
- Repopulate the schedule input/button from the actual saved schedule

## 0.12.1 (2026-09-18)
- Fix App Store audit warnings: repository field, uuid override
- Add a plugin-level test suite

## 0.12.0 (2026-09-16)
- Auto-activate the course as a SignalK route on start-line crossing
- Add 10-minute laylines for self on the course chart
- Add a lift/header wind-shift instrument for self

## 0.11.1 (2026-09-16)
- Fix OpenSeaMap autosuggest/snap never finding real data

## 0.11.0 (2026-09-16)
- Let the chart fill the page width, without trapping page scroll
- Add a recenter button to the chart
- Reuse a chosen OpenSeaMap mark instantly in other course-point rows
- Scope the recenter button to just the race's own course
- Fall back to self position when recentering with no course set
- Schedule Start/Call-off only need a date on multi-day races
- Revert Schedule Start to always need a date
- Add classes for staggered/pursuit starts
- Fix buoy name suggestion losing to a generic reverse-geocode guess
- Fix map-pick feedback stalling on a slow Overpass lookup
- Cache OpenSeaMap nav marks per chart area
- Reorder course sections and turn course points into tables
- Collapse course positions once a course is saved

## 0.10.1 (2026-09-15)
- Fix scheduled start/call-off firing immediately when set far enough ahead

## 0.10.0 (2026-09-15)
- Fix multiple registered charts stacking instead of switching
- Show a boat's inherited start time instead of blank
- Autosuggest course point names from the chart area, not just waypoints
- Source the course-point name autosuggest from OpenSeaMap, not general OSM
- Try multiple Overpass mirrors, and ask to snap a map click to a nearby mark
- Default the chart to Eniro's plain map, not whichever loaded first

## 0.9.0 (2026-09-13)
- Add click-to-place course points on the map, fix unreadable mark dropdown
- Merge course-point buttons into one, suggest names from OpenStreetMap

## 0.8.0 (2026-09-13)
- Fix Add Boat not responding to Enter in the offline export
- Mark speed pickups on the course chart
- Draw speed-pickup rings in each boat's own trace color
- Add a real background chart to the course/replay map

## 0.7.0 (2026-09-08)
- Auto-stop a complete race, and add a DNS status
- Make Excel export use live formulas, reorder time columns
- Sort DNS boats to the end and allow marking DNS before race start
- Sort DNS boats last in the offline export template too

## 0.6.0 (2026-09-07)
- Add KTK's KLR handicap register alongside VET-tall

## 0.5.1 (2026-09-04)
- Stop the boats table from resizing/reshuffling confusingly

## 0.5.0 (2026-09-03)
- Add a start timer view with distance/ETA/burn time to the line

## 0.4.3 (2026-09-03)
- Let course points autocomplete against existing SignalK waypoints
- Make mark-rounding radius configurable and add manual mark rounding
- Record positions for manual mark roundings and improve chart replay
- Add author to package.json

## 0.4.2 (2026-09-02)
- Remember sail number across races, like MMSI

## 0.4.1 (2026-08-30)
- Make the offline export installable as a standalone iOS app

## 0.4.0 (2026-08-30)
- Fetch VET-tall handicaps live in the offline export

## 0.3.0 (2026-08-20)
- Add Manage2Sail fleet import with handicap-system conversion

## 0.2.0 (2026-08-20)
- Add signalk-race-control plugin: race timing, handicaps, course/chart, VET import
- Add MIT LICENSE file and drop empty repository field
- Add offline export: standalone backup race timer
- Add multi-day races and individual per-boat start times
- Fix ghost row left in the boat table after removing a boat
- Fall back to the leader when no boat is marked self
- Clarify the multi-day toggle isn't needed for ordinary overnight races
- Fix scheduled call-off loss, stale offline exports, and add race-start correction
