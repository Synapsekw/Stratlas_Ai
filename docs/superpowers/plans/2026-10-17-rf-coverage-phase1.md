# RF coverage Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Predict and show the downlink coverage (RSRP, best server, overlap) of one telecom site on flat ground. Inputs are the antennas measured by antenna detection plus radio settings picked from a catalogue. Azimuth, tilt and power changes update a live preview.

**Architecture:**

- A new package `packages/rf` (pure TypeScript) holds the catalogue types and seed data, the MSI parser, the parametric pattern, the 3D tilt rotation, the link budget, sector grouping and the preview engine. It runs in a renderer Web Worker.
- `packages/schema/src/rf.ts` holds the file contracts.
- Main (`apps/desktop/src/main/rf.ts`) reads and writes `rf/sectors.json`, the project catalogue copy, runs and exports.
- The `rf.coverage` pipeline in the pipeline pack's Python computes the per-sector path-loss cache and the result grids.
- The renderer (`apps/desktop/src/renderer/rf/`) hosts the RF workbench tab, the catalogue picker, the coverage layer and the legend.

**Tech Stack:** TypeScript, zod 4, zustand, React 19, MapLibre, three.js, Python 3.13 with numpy, vitest, pytest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-17-rf-coverage-design.md`. Mockup: `docs/design/rf-coverage/index.html`.

## Global Constraints

- Worktree `E:\Dev\AIO Software\.claude\worktrees\rf-coverage`, branch `feat/rf-coverage`. Never edit the main checkout.
- **Never edit the antenna-detection files:** `packages/schema/src/antennas.ts`, `apps/desktop/src/renderer/telecom/**`, `apps/desktop/src/main/telecom*.ts`, `python/src/aio_pipelines/telecom/**`, `survey/DetectAntennas.tsx`, `packages/ai/src/antennaLabel*.ts`. RF reads `telecom/antennas.json` through its schema only.
- **Never edit the stage overlays owned by the UI rework:** `Stage.tsx` overlays, `FloatingVideo`, `MapMenus`, `SceneCursor`. The legend asks the corner allocator for a slot.
- No change to `aio.antennas/1`, `assemblies.ts`, the manifest or `layers.ts`. New data goes in new files (`rf/`).
- UI rules: `@aio/ui` parts only, foundation tokens, logical CSS properties, strings in `packages/ui/src/i18n/en.ts`, no `title=`, no raw spacing, z-index or shadow values (`cssGuard.test.ts`). No em or en dashes in user-facing text.
- Pattern and link-budget maths exists in TypeScript and Python. Both must pass `packages/rf/fixtures/golden/*.json` to 0.01 dB.
- e2e: `--workers=1`, the CI way (`QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp`), `pnpm demo:change --quick` built first.

## Waits

- **Can start now:** T1 to T7. These are the schema, package, catalogue, engine, pipeline and main IPC.
- **T8, the RF store,** waits on antenna detection merge 1 (`aio.antennas/1`, `AntennaInventory`, `run.groundZ`).
- **T9, the RF tab and picker,** waits on stage-island stage 2: workbench preview tabs, `<Section>`, the 470 px minimum (PR #162 is stage 1).
- **T10, the layer and legend,** waits on stage-island stage 3 Task 21 (`assignSlots`). The map and scene drawing can be built earlier behind the layer toggle; only the legend mount waits.
- **T11, Edit RF… in the Measure workbench,** waits on antenna detection merge 2.

## Review Focus

1. **Wrong-way coverage.** True azimuth must be `azimuthGridDeg + convergenceDeg`. T4 checks this with a golden case that has a non-zero convergence; T8 tests that a unit with `convergenceDeg: null` refuses to run.
2. **Mechanical tilt added to electrical tilt.** T4 golden vectors at 0°, 45° and 90° off boresight with mechanical tilt only, and with e-tilt only, compared to the rotation result.
3. **TS and Python drift.** The same golden file is run by vitest (T4) and pytest (T6).
4. **Orphaned RF settings deleted silently.** T8 test: a unit missing from `antennas.json` keeps its entry and is listed as an orphan.
5. **Colour-only legend.** T10 test: each legend class renders its label and range text. Contrast is checked with `contrast.ts` in light, dark and more-contrast modes.

---

## File structure

| File                                                                                                        | Responsibility                                                                 | Task |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---- |
| `packages/schema/src/rf.ts` (new), `index.ts`                                                               | `RfSectorsFile`, `RfCatalogue` (antenna, radio, aau), `RfRun`, study settings  | T1   |
| `packages/schema/src/versions.ts`                                                                           | three `SCHEMA_REGISTRY` rows                                                   | T1   |
| `packages/schema/src/ipc.ts`                                                                                | `rf:*` channels                                                                | T1   |
| `packages/schema/src/jobs.ts`                                                                               | `rf.coverage` params, `RF_COVERAGE_MIN_PACK`                                   | T1   |
| `docs/architecture/contract-changes.md`, `docs/release/UPGRADE-POLICY.md`                                   | contract row, reader rows                                                      | T1   |
| `packages/rf/` (new package: `package.json`, `tsconfig`, `src/index.ts`)                                    | package skeleton                                                               | T2   |
| `packages/rf/src/bands.ts`                                                                                  | GCC band table, `N_RB` per bandwidth and numerology                            | T2   |
| `packages/rf/catalogue/*.json`, `packages/rf/src/catalogue.ts`                                              | seed entries (generic plus vendor), lookup, search, filters                    | T3   |
| `packages/rf/src/msi.ts`                                                                                    | MSI / Planet parser and nearest e-tilt pick                                    | T3   |
| `packages/rf/src/pattern.ts`                                                                                | parametric 38.901 pattern, two-cut summing, front-to-back cap                  | T4   |
| `packages/rf/src/geometry.ts`                                                                               | true azimuth, direction into the antenna frame (azimuth, then mechanical tilt) | T4   |
| `packages/rf/src/budget.ts`                                                                                 | EIRP, RSRP per RE, margins, classes                                            | T4   |
| `packages/rf/fixtures/golden/*.json`                                                                        | shared golden vectors                                                          | T4   |
| `packages/rf/src/propagation.ts`                                                                            | 38.901 UMa/UMi/RMa, Okumura-Hata, COST-231 Hata, free space, range checks      | T5   |
| `packages/rf/src/sectors.ts`                                                                                | 30 degree bearing grouping, names, eligibility, orphans                        | T5   |
| `packages/rf/src/preview.ts`, `preview.worker.ts`                                                           | pattern and budget over cached path loss; composite, best server, overlap      | T5   |
| `python/src/aio_pipelines/rf/` (new: `pipeline.py`, `pattern.py`, `budget.py`, `propagation.py`, `grid.py`) | `rf.coverage` job                                                              | T6   |
| `python/tests/rf/`                                                                                          | pytest, including the golden vectors                                           | T6   |
| `apps/desktop/src/main/rf.ts` (new), `index.ts` (wiring)                                                    | sectors read and write, catalogue list and import, runs, export                | T7   |
| `apps/desktop/src/main/rf/export.ts` (new)                                                                  | GeoTIFF, GeoJSON contours, CSV                                                 | T7   |
| `apps/desktop/src/renderer/rf/rfStore.ts` (new)                                                             | units from antennas.json, sectors, height basis, orphans, preview state        | T8   |
| `apps/desktop/src/renderer/rf/RfBench.tsx`, `rf.css` (new)                                                  | RF workbench tab: Site, Sector, Results sections                               | T9   |
| `apps/desktop/src/renderer/rf/CataloguePicker.tsx` (new)                                                    | modal picker, search, filters, MSI import                                      | T9   |
| `apps/desktop/src/renderer/rf/CsvImport.tsx` (new)                                                          | CSV import with review                                                         | T9   |
| `packages/ui/src/i18n/en.ts`                                                                                | every RF string                                                                | T9   |
| `apps/desktop/src/renderer/rf/coverageLayer.ts`, `CoverageLegend.tsx` (new)                                 | map raster source, scene drape, boresight arrows, legend with corner slot      | T10  |
| `apps/desktop/src/renderer/shell/actions/rfActions.tsx` (new), `actions/index.ts`                           | Edit RF… action                                                                | T11  |
| host of `AntennaInventory` (Measure workbench file, after merge 2)                                          | pass the extra action                                                          | T11  |
| island Measure group tile (stage-island file, after stage 2)                                                | Coverage tile                                                                  | T11  |
| `apps/desktop/e2e/rf-coverage.spec.ts`, `rfFixtures.ts` (new)                                               | e2e                                                                            | T12  |

## Tasks

### T1. Contracts

- [ ] Write the zod schemas in `rf.ts`, following spec D8, D10 and D12.
- [ ] Add the registry rows, the IPC channels and the `rf.coverage` params.
- [ ] Add the contract row.
- [ ] **Tests:** `rf.test.ts`
  - round-trip a full sectors file;
  - refuse an antenna id that does not match `^ant-`;
  - refuse an AAU entry with a separate antenna;
  - refuse an e-tilt outside the port's range;
  - a newer `/2` file is read as refused.
- **Packages:** schema.

### T2. Package skeleton and bands

- [ ] Add `packages/rf` to the workspace with lint, typecheck and test scripts like `packages/survey`.
- [ ] Write `bands.ts` with the spec's band table, centre frequencies, duplex, and `N_RB` for LTE 5/10/15/20 MHz and NR 15/30 kHz SCS up to 100 MHz.
- [ ] **Tests:**
  - `N_RB(LTE, 20) = 100`;
  - `N_RB(NR, 100 MHz, 30 kHz) = 273`;
  - every band has a frequency inside its range.
- **Packages:** rf, root `pnpm-workspace.yaml`.

### T3. Catalogue and MSI

- [ ] Write the seed catalogue:
  - generic panels (65° and 33°, 15 to 18 dBi);
  - generic 4T4R RRU (4 x 40 W and 4 x 60 W);
  - generic 64T64R and 32T32R AAU;
  - about 20 vendor entries, each with its source and `verified: false` until checked against its datasheet.
- [ ] Write lookup and search by vendor, band and kind.
- [ ] Write the MSI parser: header keys, dBi and dBd, `HORIZONTAL 360` and `VERTICAL 360`, comma or space separators.
- [ ] **Tests:**
  - parse a fixture MSI;
  - convert dBd to dBi (+2.15);
  - refuse a file missing a cut;
  - pick the nearest e-tilt file;
  - every seed entry passes `RfCatalogue` (depends on T1).
- **Packages:** rf.

### T4. Pattern, geometry, budget, golden vectors

- [ ] Write the parametric pattern, the two-cut summing and the cap (spec D11).
- [ ] Write the rotation by true azimuth then mechanical downtilt (spec D15).
- [ ] Write RSRP (spec D13).
- [ ] Write the golden vector file. Each vector holds inputs (direction, azimuth, convergence, mechanical tilt, e-tilt, pattern, power, bandwidth, loss, gain) and expected attenuation and RSRP. Cover the boresight, the 3 dB edge, the back lobe, mechanical tilt at 0°, 45° and 90° off boresight, and convergence 1.5°.
- [ ] **Tests:**
  - `pattern.test.ts`, `geometry.test.ts`, `budget.test.ts`;
  - the golden runner within 0.01 dB.
- **Packages:** rf.

### T5. Propagation, sectors, preview engine

- [ ] Write 38.901 UMa, UMi and RMa (expected path loss with LOS probability), Okumura-Hata and COST-231 Hata with range refusal, and free space.
- [ ] Write sector grouping at 30° on true azimuth, with eligibility (accepted panel by default) and orphans.
- [ ] Write the preview: given cached path-loss Float32 grids and sector settings, compute composite, best server and overlap in a Worker.
- [ ] **Tests:**
  - path loss against published reference values per model;
  - Hata refuses 2600 MHz;
  - grouping of three sectors and of a 359°/1° wrap;
  - preview on a 64 x 64 synthetic grid matches a direct computation;
  - a 280 k pixel, 3-sector preview completes under 150 ms in the test (measured and logged, not asserted on CI timing).
- **Packages:** rf.

### T6. `rf.coverage` pipeline

- [ ] Write the Python job. It builds the grid in the project CRS around the site, computes path loss per sector and band, and writes the run folder (`run.json`, per-sector path loss, composite grids). It reports progress through the existing RPC.
- [ ] Bump the pack version and set `RF_COVERAGE_MIN_PACK`.
- [ ] **Tests:**
  - pytest: the golden vectors through `pattern.py` and `budget.py`;
  - a 3-sector synthetic site against expected class areas;
  - cancel mid-run leaves no partial `run.json`.
- **Packages:** python.

### T7. Main IPC and export

- [ ] Write `rf.ts`:
  - read and write `rf/sectors.json` with an atomic replace and `.bak`, refusing writes into packages;
  - list the catalogue (built in plus userData plus project copy);
  - MSI import into userData;
  - copy used entries into `rf/catalogue.json`;
  - list and read runs.
- [ ] Write the export: GeoTIFF Float32 with CRS and nodata, GeoJSON polygons by marching squares at each threshold, CSV areas.
- [ ] **Tests:**
  - write then read;
  - newer file refused;
  - package refused;
  - a GeoTIFF read back gives the same values and CRS;
  - contour polygons closed and nested correctly.
- **Packages:** apps/desktop main.

### T8. RF store (waits on antenna detection merge 1)

- [ ] Load units from `antennas.json` and RF settings from `rf/sectors.json`.
- [ ] Work out height: `box.centre[2] - run.groundZ` (basis measured), else DSM or terrain at the base (basis estimated), else the user value.
- [ ] Propose sectors.
- [ ] Track orphans, the preview state, and the run and refuse reasons (no CRS, no accepted panels, no band).
- [ ] **Tests:**
  - groundZ present and absent;
  - user override wins;
  - an orphan is kept;
  - a `convergenceDeg: null` unit refuses;
  - a draft unit marks the run unreviewed.
- **Packages:** apps/desktop renderer.

### T9. RF workbench tab, catalogue picker, CSV import (waits on stage-island stage 2)

- [ ] Build the RF tab with the Site, Sector and Results sections per spec D21, at 470 px minimum.
- [ ] Build the catalogue picker per spec D22, and the CSV import with a review table.
- [ ] Add the strings to `en.ts`.
- [ ] **Tests:**
  - component tests: the tab renders measured values with basis marks, the e-tilt slider is clamped to the port range, picking an AAU disables the antenna and radio fields, the picker shows `EmptyState` on no match, CSV review matches by name and shows unmatched rows;
  - `cssGuard` passes.
- **Packages:** apps/desktop renderer, ui (en.ts).

### T10. Coverage layer and legend (legend mount waits on stage 3 Task 21)

- [ ] Draw the map raster source through `FrameProjection`, the scene ground drape and the boresight arrows.
- [ ] Add a "Coverage" group in the layer list with an eye.
- [ ] Build the legend with class names and ranges, an optional hatch, and the indicative and assumptions line. It requests a corner slot.
- [ ] **Tests:**
  - legend labels per class;
  - contrast of the ramp and text in three modes (`contrast.ts`);
  - layer toggle hides both map and scene.
- **Packages:** apps/desktop renderer.

### T11. Entry points (waits on antenna detection merge 2 and stage 2)

- [ ] Add the Edit RF… action in `rfActions.tsx`.
- [ ] Pass the extra action to `AntennaInventory` from its Measure workbench host.
- [ ] Add the Coverage tile in the island Measure group.
- [ ] Hide the entry points with no `antennas.json`, and disable them with a reason during runs.
- [ ] **Tests:** action visibility rules; the tile is hidden without antennas.
- **Packages:** apps/desktop renderer.

### T12. e2e and verify

- [ ] `rf-coverage.spec.ts`, on a fixture project with a CRS, `telecom/antennas.json` (three accepted panels, one draft) and no `rf/`:
  1. Open the RF tab from Edit RF….
  2. Pick a generic panel and RRU and set n78 at 100 MHz.
  3. Run coverage and wait for the job.
  4. The legend shows the classes.
  5. Move a sector's e-tilt and the preview updates.
  6. Save as new run.
  7. Export a GeoTIFF.
  8. Reopen the project and the settings persist.
- [ ] Run `pnpm check` and the e2e the CI way.
- **Packages:** apps/desktop e2e.

## Execution DAG

```
T1 contracts ─┬─> T3 catalogue+MSI ─────────────┐
              ├─> T6 pipeline (needs T4 golden) ─┤
              └─> T7 main IPC+export ────────────┤
T2 rf pkg ────┬─> T3                             │
              └─> T4 pattern/geometry/budget ─┬─> T5 propagation/sectors/preview ─┐
                                              └─> T6                              │
                                                                                  ├─> T8 store* ─> T9 tab* ─┬─> T11 entry* ─┐
                                              T7 ─────────────────────────────────┘          └─> T10 layer* ─┴──────────────┴─> T12 e2e+verify
```

`*` means the task waits on an outside landing (see Waits).

**Parallel batches** (no shared files within a batch, each dispatched in one message):

| Batch | Tasks      | Why they do not collide                                                                                                                                         |
| ----- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1    | T1, T2     | schema files and docs vs the new package and workspace file                                                                                                     |
| B2    | T3, T4, T7 | `rf/catalogue*`, `rf/msi.ts` vs `rf/pattern`, `geometry`, `budget`, `fixtures` vs `main/rf*`; each owns its own `index.ts` exports block, merged by the B2 lead |
| B3    | T5, T6     | `packages/rf/src/{propagation,sectors,preview}` vs `python/.../rf/`                                                                                             |
| B4    | T8         | after antenna detection merge 1                                                                                                                                 |
| B5    | T9, T10    | `RfBench`, `CataloguePicker`, `CsvImport`, `en.ts` vs `coverageLayer`, `CoverageLegend`; T10 strings are added to `en.ts` by T9                                 |
| B6    | T11        | after antenna detection merge 2                                                                                                                                 |
| B7    | T12        |                                                                                                                                                                 |

**Critical path:** T2 → T4 → T5 → T8 → T9 → T11 → T12. The outside landings (antenna detection merges 1 and 2, stage-island stages 2 and 3) are the real gate. B1 to B3 can merge on their own as a first branch (engine, catalogue, pipeline, IPC, no UI) so the UI branch is small when the landings arrive.

## e2e specs

- New: `apps/desktop/e2e/rf-coverage.spec.ts`.
- Unchanged: `telecom-measurements.spec.ts` and the antenna-detection spec (not touched).

## Contract changes

One row per merge in `docs/architecture/contract-changes.md`:

1. **Engine merge (B1 to B3):** families `aio.rf-sectors/1`, `aio.rf-catalogue/1`, `aio.rf-run/1`; the `rf:*` IPC channels; pipeline `rf.coverage` and `RF_COVERAGE_MIN_PACK`.
2. **UI merge (B4 to B7):** no contract change expected. If the UI needs a new channel, it gets its own row.
