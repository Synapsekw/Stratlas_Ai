# Tracks across survey dates (Wave 3 M2)

Roadmap: `docs/plans/2026-10-30-intelligence-review.md`, Wave 3 row M2. Study: `docs/design/intelligence-review-2026-10/vision.md` 3.10 (gap 7, improvement 10). Branch `feat/site-tracks`. Built without questions (founder go of 11 Nov 2026); the calls below are decided.

## Goal

Link the same antenna, change region and thermal hot spot across survey dates into a track, show the track's values per date where the object is already inspected, and let the site digest speak about what changed.

## Decisions

1. **Derived at read time, one small store.** Tracks are computed in `@aio/change/core` (`tracks.ts`) from files that already hold each date: change sets (regions) and detection passes (hot spots). Nothing about tracks is stored, so they rebuild the same way every time. The one gap is antennas: `telecom/antennas.json` holds one date and is replaced by a run on a new date, so no earlier azimuth survives. `telecom.antennas` now also writes a per-date copy, `telecom/history/<captureId>.json` (same `aio.antennas/1` shape, no crops): the date it replaces, as the person left it, and its own. Contract row added; pipeline pack 0.35.0.
2. **Matching is geometric and deterministic.** Date by date, oldest first; each track's latest sighting is a candidate for the next date's observations. A pair links on the same class and agreeing places: the same antenna id (the re-run merge already keeps ids across dates), else outlines overlapping `MIN_OVERLAP` (regions), else positions within the larger radius. Pairs best first (id, overlap, distance, then ids), each at most once. Radii: antenna `max(0.3 m, half its face)` (the merge radius as the floor), hot spot `max(0.5 m, 10 x GSD)` with GSD from the photo's distance to the point and its lens (the vote radius as the floor), region `max(1 m, 3 x the set's cell)`. Positions are compared lined up (each date's shift).
3. **Which observations count.** Antennas: every unit but rejected ones; drafts are marked. Regions: items of the change set from a date's predecessor to it (consecutive pairs only, so a long c1-c3 set does not double count), dismissed ones left out. Hot spots: the review's `thermal-*.json` detections (or class `hot-spot`) with a vote point, rejected ones left out.
4. **Where it shows.** A small "Across survey dates" table (`TrackHistory`, `@aio/change`) in the antenna details card, under a selected hot spot in Inspect's findings, and in a change region's detail in the Changes panel. Nothing shows for an object seen on one date. No shell, right panel, island or palette file is touched.
5. **Digest.** Three rules in `@aio/insights` (`trackRules.ts`): `antenna-turned` (azimuth 3 degrees or downtilt 1 degree, both dates reviewed), `hotspot-hotter` (peak up 5 degC, both reviewed), `region-grew` (area up 20 % and 5 m2). Each speaks only when the last sighting is on the latest date. New actions `insights.openAntenna` and `insights.openHotspot`; a region opens the Changes tab on the latest pair.
6. **No agent tool.** The fact index (M1) is being built in parallel and will be the query layer; a track tool would duplicate it.

## Tasks, tests and packages

| #   | Task                                                                        | Tests                                                                  | Packages                             |
| --- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| T1  | Per-date antenna copies in `telecom.antennas` commit (`telecom/history.py`) | `test_telecom_history.py`, two cases in `test_telecom_pipeline.py`     | `python` telecom                     |
| T2  | `linkTracks`, `antennaTracks`, `regionTracks`, `hotspotTracks`              | `packages/change/src/tracks.test.ts`                                   | `@aio/change`                        |
| T3  | `TrackHistory` component, change region detail                              | `TrackHistory.test.tsx`, ChangePanel tests                             | `@aio/change`, `@aio/ui` i18n        |
| T4  | IPC `telecom:readAntennaHistory`, schema constants                          | `apps/desktop/src/main/telecom.test.ts`                                | `@aio/schema`, desktop main, preload |
| T5  | Renderer: `siteTracks`, antenna and hot spot sections                       | `tracks/siteTracks.test.ts`, existing AntennaDetails and Inspect tests | desktop renderer                     |
| T6  | Digest rules and actions                                                    | `packages/insights/src/trackRules.test.ts`, `runInsight.test.ts`       | `@aio/insights`, desktop renderer    |
| T7  | e2e `site-tracks.spec.ts`                                                   | the spec, run the CI way                                               | desktop e2e                          |
| T8  | Pack bump to 0.35.0 (last, separate commit), contract row, session note     | `pnpm check`                                                           | `python`, docs                       |

## Execution DAG

- Batch 1 (parallel, no shared files): T1, T2, T4.
- Batch 2 (after T2): T3, T6 (T6 needs only the track shape), T5 (after T2 and T4).
- Batch 3: T7 (after T3, T5, T6).
- Batch 4: T8.

Critical path: T2, T5, T7, T8.

## e2e

New `apps/desktop/e2e/site-tracks.spec.ts`. No existing spec changes. The telecom pipeline change only adds files, so `telecom-antennas.spec.ts` is run too.

## Contract change

`telecom/history/<captureId>.json` and IPC `telecom:readAntennaHistory` (one row in `docs/architecture/contract-changes.md`).
