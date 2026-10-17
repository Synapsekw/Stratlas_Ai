# RF coverage prediction for telecom sites (design)

Draft, 17 Oct 2026, for the founder's review. Phase 1 plan: `docs/superpowers/plans/2026-10-17-rf-coverage-phase1.md`. Mockup: `docs/design/rf-coverage/index.html`.

## Why

A drone survey of a telecom tower already gives us what a radio planner spends money to get right: where each antenna is, which way it faces, how far it is tilted down and how high it hangs. The antenna-detection work (`feat/telecom-auto-detect`, `telecom/antennas.json`) measures those values from the point cloud. Nothing in the app turns them into what an operator actually asks next: **what area does this site cover, and what changes if I re-aim a sector?**

This feature predicts the downlink signal level (RSRP) around a site from the measured antenna geometry plus the radio settings a drone cannot see (band, radio unit, power, electrical tilt), and shows it as a coverage map with a legend. Changing azimuth, tilt or power updates the map quickly enough to use as a what-if tool.

It is a **prediction**, not a measurement. An untuned model is typically within 8 to 10 dB (standard deviation) of drive-test readings; terrain, clutter and tuning bring that to about 6 to 8 dB. The UI says "indicative" on every result.

## Scope: what GCC networks run today

Built for one GCC market first (called the lead market here) and the GCC in general. The band list comes from public band listings and operator news (sources at the end) and is data, not code: correcting a band is a catalogue edit.

**Technologies:** LTE and 5G NR only.

- No 2G or 3G. The lead market's regulator scheduled the 2G switch-off for the end of 2025; STC switched 3G off in Q4 2022 and scheduled 2G for Q4 2025; Zain Bahrain switched 3G off in 2022; Oman began its 3G switch-off in July 2024.
- No mmWave (26 GHz, n258) in v1. Only two GCC markets have assigned it, cells reach a few hundred metres, and a useful prediction needs building-level ray tracing.

**Bands in the first catalogue:**

| Band                   | Duplex | Seen at                            |
| ---------------------- | ------ | ---------------------------------- |
| 700 MHz (n28)          | FDD    | KSA (recent award)                 |
| 800 MHz (B20/n20)      | FDD    | lead market, KSA                   |
| 900 MHz (B8/n8)        | FDD    | KSA (LTE and NR)                   |
| 1800 MHz (B3/n3)       | FDD    | every operator, the main LTE layer |
| 2100 MHz (B1/n1)       | FDD    | lead market, KSA                   |
| 2300 MHz (B40/n40)     | TDD    | KSA                                |
| 2600 MHz (B7)          | FDD    | lead market                        |
| 2600 MHz (B38/B41/n41) | TDD    | lead market (5G), KSA              |
| 3500 MHz (n78)         | TDD    | every operator, the main 5G layer  |
| 3700 MHz (n77)         | TDD    | KSA                                |

**Equipment vendors in the first catalogue:** radios from Huawei and Ericsson first (dual-band 2.6 + 3.5 GHz massive MIMO units are deployed in the lead market), Nokia second; antennas from Huawei, CommScope, Ericsson (former Kathrein) and Rosenberger. Massive MIMO units (32T32R, 64T64R) are normal on the 3.5 GHz layer.

## Decisions

### Inputs and where they come from

- **D1. Antenna geometry comes from `telecom/antennas.json` (`aio.antennas/1`), owned by the antenna-detection work.** Agreed with that session on 17 Oct. RF reads it and never writes it. Per unit it uses: `id` (stable across re-runs), `kind`, `status`, `box.centre` (E, N, Z in the project CRS), `azimuthGridDeg`, `downtiltDeg` (signed mechanical downtilt, positive down, from the face normal), `convergenceDeg` (true azimuth = grid azimuth + convergence; null without a CRS), the user `model` text and `active`. Each measured value keeps its `{ value, basis, quality }` and the RF tab shows that basis.
- **D2. Tilt and north need no contract change from RF.** The antenna-detection schema already defines signed mechanical downtilt and grid azimuth with a convergence. The older `assemblies.ts` `antenna` (`azimuthDeg`, `tiltDeg` with no documented sign) is legacy for RF purposes: it is not an RF input. When a unit has no convergence (no CRS), coverage is refused with a reason, because an RF map facing the wrong way is worse than none.
- **D3. Eligible units.** By default only `accepted` units of kind `panel` take part. `short`, `dish` and `other` are listed but greyed with a reason; a person can include a `short` unit by hand (small cells). Draft units can be previewed but a saved run records that it used unreviewed geometry.
- **D4. Height above ground.** When `antennas.json` has `run.groundZ` (tower base ground height, from the detection pipeline), height = `box.centre[2] - run.groundZ`, basis measured. Without it, ground is sampled from the project DSM or terrain at the tower base, basis estimated. A person can always override it (basis user). The tab shows which.
- **D5. What RF owns, because detection does not provide it in v1:** the catalogue antenna id per unit, the radio unit and port per carrier, the band and carrier bandwidth, configured power per port, feeder or jumper loss, electrical tilt, the active flag for RF, and sector grouping.
- **D6. Radio settings are typed, picked or imported.** Per unit, in the RF tab, with the catalogue picker (D10). Also a CSV import of the operator's cell export (columns: antenna name or id, sector, band, bandwidth, power, e-tilt, antenna model, radio model), matched to units by name with a review step before anything is written. Imported values have basis user.
- **D7. Sector grouping.** Proposed automatically by bearing: units whose true azimuths fall within 30 degrees of each other form one sector (the same rule as `assemble/telecom.ts`, ported into `packages/rf`, not imported from modelling). Names S1, S2, S3 clockwise from north. A person can regroup and rename. Grouping affects naming, the best-server colours and the per-sector toggles, not the physics.

### Data

- **D8. `rf/sectors.json` (`aio.rf-sectors/1`), new file, keyed by `AntennaUnit.id`.** It holds sectors (`id`, `name`, `antennaIds`), per-antenna RF settings (catalogue antenna id, height override, e-tilt, carriers with radio unit, port, band, bandwidth, power, loss) and the study settings (model, environment, UE height, margin preset, thresholds, grid resolution and radius). RF settings never go into `antennas.json` or the assemblies. Written only through IPC with an atomic replace and `.bak`, like `edits/boundaries.json`.
- **D9. Orphans are flagged, never deleted.** A unit that detection removed, rejected or marked `notFoundInLatest` leaves its RF entry in place; the tab lists it under "Settings for antennas no longer found" with Remove and Reassign to another unit.
- **D10. Catalogue (`aio.rf-catalogue/1`).**
  - Three record kinds: `antenna` (ports, each with band range, gain dBi, horizontal and vertical beamwidth, front-to-back, e-tilt range and step, and a pattern reference per frequency and e-tilt step), `radio` (RRU: bands, TX/RX ports, max power per port, max bandwidth, mounting) and `aau` (integrated antenna and radio: bands, ports, total power, SSB or broadcast beam gain and beamwidths). Choosing an AAU disables the separate antenna and radio fields.
  - The built-in catalogue ships in `packages/rf/catalogue/` (read only, versioned with the app). A person's imported entries live per computer in userData `rf-catalogue/`. When a project uses an entry, that entry is copied into `rf/catalogue.json` so a project or package is self-contained and a later catalogue edit never changes an old result silently.
  - Every entry carries a source (datasheet URL, vendor pack or "user") and a `verified` flag. Unverified figures show a "check the datasheet" tip.
- **D11. Antenna patterns.**
  - Real patterns: import of MSI / Planet files (`NAME`, `FREQUENCY`, `GAIN`, `TILT`, `HORIZONTAL 360`, `VERTICAL 360`). One file per band, port and e-tilt step, as vendors ship them; the engine snaps to the nearest e-tilt file and says so. NSMA / ADF import is Phase 2.
  - Fallback when no file exists: the 3GPP TR 38.901 parametric pattern, `A_H(φ) = -min(12(φ/φ3dB)², Am)`, `A_V(θ) = -min(12((θ-θtilt)/θ3dB)², SLAv)`, `A = -min(-(A_H + A_V), Am)`, using the port's beamwidths and gain from the catalogue (defaults 65°, Am = SLAv = 30 dB). Results computed with the fallback are labelled "generic pattern".
  - 3D gain from two cuts by the summing method, capped at the front-to-back value.
- **D12. Coverage results are files, not manifest layers.** A run writes `rf/runs/<runId>/` with `run.json` (`aio.rf-run/1`: inputs snapshot, catalogue ids, model, grid, timings, warnings), per-sector path-loss grids (Float32, project CRS, the cache for D15) and the composite RSRP, best-server and overlap grids. The manifest's `raster` layer `role` enum is not extended: a new enum value makes older builds refuse the whole manifest (upgrade policy rule 2: new data in new files). The layer list shows a "Coverage" group built from the RF store, like other derived content.

### Engine

- **D13. Link budget.**
  `RSRP = P_port - 10·log10(12·N_RB) - L_feeder + G_ant + A(φ, θ) - PL - margins`
  - `P_port` in dBm from the configured power per port (default the radio's max, flagged).
  - `N_RB` from carrier bandwidth and numerology (LTE 20 MHz: 100 RB; NR 100 MHz at 30 kHz: 273 PRB).
  - For AAUs the gain and pattern are the SSB or broadcast beam's, never the peak traffic beam's.
  - MIMO layers do not raise RSRP (it is per port).
  - Margins by preset: Outdoor (0 dB), In car (7 dB), Indoor (15 dB), Deep indoor (20 dB), plus body loss 3 dB and a log-normal fade margin from the cell-edge probability (90 % gives 1.28σ, σ 8 dB by default).
  - Thresholds, all editable: Excellent above -80 dBm, Good -80 to -95, Fair -95 to -105, Poor -105 to -115, No service below -115.
- **D14. Propagation models.** 3GPP TR 38.901 is the default because half the GCC bands (2.3, 2.6, 3.5, 3.7 GHz) are above COST-231 Hata's 2 GHz limit. Environments: UMa (urban macro), UMi (street canyon, for small cells), RMa (rural macro), with LOS probability averaged into an expected path loss. Okumura-Hata (below 1500 MHz) and COST-231 Hata (1500 to 2000 MHz) are offered as an option for the low bands; picking them for a band out of range is refused with the range in the reason. Free space is available for a line-of-sight sanity check.
- **D15. Tilt is a 3D rotation, and only the pattern term changes with it.**
  - For each pixel the engine forms the direction from the antenna, rotates it by true azimuth then by mechanical downtilt (about the antenna's horizontal axis) into the antenna frame, and reads the pattern that already holds the electrical tilt. Mechanical and electrical tilt are never simply added: mechanical tilt fades towards ±90° off boresight and lifts the back lobe.
  - Path loss depends only on distance, frequency and heights, so it is computed once per sector and band and cached in the run folder. Changing azimuth, tilt, power or loss recomputes only the pattern and link-budget terms. That is what makes the sliders live.
- **D16. Where it runs.**
  - **Run coverage** is a pipeline job, `rf.coverage`, in the pipeline pack's Python (numpy), through the existing job runner. That is the only kind of job the runner runs, and Phase 2's terrain and clutter work belongs there anyway. It writes the run folder (D12).
  - **Live preview** runs in a renderer Web Worker from `packages/rf` (TypeScript): it reads the cached path-loss grids and recomputes the pattern and link-budget terms on slider changes. **Save as new run** turns a preview into a run.
  - The pattern and link-budget code exists twice (TypeScript and Python). They share one set of golden test vectors (`packages/rf/fixtures/golden/*.json`) run by vitest and pytest, so they cannot drift.
- **D17. Phase 1 assumes flat ground around the site.** UE height 1.5 m above the tower base ground; no terrain profile, no diffraction, no clutter. Every result says "flat ground, no buildings" next to "indicative". Grid default 10 m out to 3 km (about 280 thousand pixels per sector), editable from 5 m to 50 m and up to 15 km.

### Outputs

- **D18. Views.** Composite RSRP (max over sectors), best server (strongest sector per pixel), and overlap (how many sectors are within 6 dB of the best). SINR is Phase 2 with multi-site.
- **D19. Export.** GeoTIFF of the RSRP grid (project CRS, Float32, nodata), GeoJSON coverage polygons at each threshold (marching squares), and a CSV of per-sector summaries (area per class). Through the existing export path and save dialog.

### UI and placement (agreed with the UI rework session, 17 Oct)

- **D20. RF tab.** A workbench preview tab "RF" in the right sidebar (stage-island decisions 11 to 17), 470 px minimum width because of the sliders, returning to the person's width when left. Opened by:
  - the row action and right-click **Edit RF…** on an antenna row in the antenna inventory, through an optional extra-actions prop on `AntennaInventory` that the host fills in (no edit inside the inventory's files);
  - **Edit RF…** in the shell right-click action registry (`shell/actions`) on an antenna;
  - the **Coverage** tile in the island's Measure group, next to the telecom tools and Detect antennas.
- **D21. RF tab content, as collapsible `<Section>`s.**
  - **Site:** tower, sector list with a toggle per sector, study settings (model, environment, margin preset, radius, grid).
  - **Sector or antenna:** measured geometry with basis marks (azimuth true and grid, mechanical downtilt, height); band and carrier; radio unit and antenna fields that open the catalogue picker; electrical tilt slider within the port's range and step; power and loss.
  - **Results:** a segmented choice RSRP / Best server / Overlap that drives the layer; per-class area and percentage; Run coverage, Save as new run, Export; the indicative label and the assumptions.
- **D22. Catalogue picker.** A modal launched from the antenna or radio field: search, filters for vendor and band, a list of `Row`s (model, vendor, bands, gain or power, a verified mark), an `EmptyState` when nothing matches, and Import MSI. Not a permanent tab.
- **D23. Map and scene.** The coverage is drawn on the 2D map (MapLibre raster source through the frame projection) and draped on the 3D scene's ground; each sector's boresight is drawn as a thin arrow from the antenna. The legend is a stage overlay that **asks the corner allocator for a slot** (stage-island stage 3, `assignSlots`, tl/tr/bl/br) and never fixes its own position or sits in the island.
- **D24. Job.** `rf.coverage` shows in the jobs chip, the Jobs workbench and the island live line like every job, with the label "Predicting coverage". Run coverage is a `Button` with `busy` and a `disabledReason` (no accepted panel units, no CRS, no band set).
- **D25. Parts and rules.** Only `@aio/ui` parts (Button, IconButton, Tip, Popover, Menu, Tabs, Chip, Row, EmptyState, ResizableSplit), the foundation tokens (`--sp-*`, `--el-*`, `--z-*`, `--d-*`, `--ease`, `--t-title`, colour tokens), logical CSS properties, every string in `en.ts`, no `title=` tooltips, no raw spacing, z-index or shadow values.
- **D26. Accessibility.** RSRP classes are never colour alone: the legend carries the class name and range, the map has an optional hatch per class, and the best-server view labels sectors. The ramp passes in light, dark and more-contrast modes; legend text meets 4.5:1. Sliders have a number field beside them and step with the arrow keys.

### Availability

- **D27.** The Coverage tile and Edit RF… are hidden when the project has no `telecom/antennas.json`, and disabled with a reason while a detection run or a coverage run is going.

## Phases

1. **Phase 1, single site, flat ground (this plan).** Catalogue and MSI import, `rf/sectors.json`, sector grouping, link budget, 38.901 and Hata, 3D tilt, the `rf.coverage` job with the path-loss cache, live preview, RSRP / best server / overlap, legend, export, CSV import.
2. **Phase 2, terrain and clutter, multi-site.**
   - Terrain profiles from Copernicus GLO-30 (packaged like the existing terrain packs), knife-edge diffraction (ITU-R P.526, Deygout).
   - Clutter loss from ESA WorldCover 10 m and building footprints with heights. Buildings come first in the lead market: the terrain is mostly flat, but high-rise districts dominate urban coverage. Terrain still matters in the Hajar mountains.
   - Near the tower, the project's own drone surface model for detailed local shadowing.
   - Several sites in one study: SINR and pilot pollution. NSMA / ADF pattern import.
3. **Phase 3, calibration and recognition.** Drive-test import (lat, lon, PCI, RSRP), least-squares tuning of the model per environment with the error reported; antenna model suggested from detection photos into the catalogue id.

## Contract

All additive, one row in `docs/architecture/contract-changes.md` per merge:

- New file families in `SCHEMA_REGISTRY`: `aio.rf-sectors/1` (`rf/sectors.json`), `aio.rf-catalogue/1` (`rf/catalogue.json`, userData `rf-catalogue/`), `aio.rf-run/1` (`rf/runs/<runId>/run.json`), schemas in `packages/schema/src/rf.ts`.
- New IPC channels for reading and writing `rf/sectors.json`, listing and importing catalogue entries, listing and reading runs, and exporting.
- New pipeline `rf.coverage` with its params schema in `jobs.ts` and a new `RF_COVERAGE_MIN_PACK`.
- No change to `aio.antennas/1`, `assemblies.ts`, the manifest or `layers.ts`.

## Never edited by this work

Owned by the antenna-detection work: `packages/schema/src/antennas.ts`, `apps/desktop/src/renderer/telecom/**`, `apps/desktop/src/main/telecom*.ts`, `python/src/aio_pipelines/telecom/**`, `apps/desktop/src/renderer/survey/DetectAntennas.tsx`, `packages/ai/src/antennaLabel*.ts`. Owned by the UI rework: `Stage.tsx` overlays, `FloatingVideo`, `MapMenus`, `SceneCursor`. RF code lives in `packages/rf`, `packages/schema/src/rf.ts`, `apps/desktop/src/renderer/rf/`, `apps/desktop/src/main/rf.ts` and `python/src/aio_pipelines/rf/`.

## Dependencies

- Antenna detection merge 1 (schema, store, `AntennaInventory`) before the RF tab can read units; merge 2 (inventory in the Measure workbench) before Edit RF… is wired there. `run.groundZ` (D4) is added by that work.
- Stage-island stage 2 (workbench tabs, Sections, preview tabs, 470 px minimum) before the RF tab; stage 3 Task 21 (corner allocator) before the legend. Until then the legend is not mounted.
- Catalogue, schema, engine and pipeline do not wait on either.

## Risks and open points

- **Vendor data.** Huawei patterns usually need an operator NDA; CommScope packs are often behind a login. v1 ships datasheet figures (marked unverified until checked) and the parametric fallback; customers import their own MSI files.
- **Radio powers in the seed catalogue** are from datasheets and secondary sources; each entry is checked against its datasheet before it is marked verified.
- **Flat ground in Phase 1** is wrong in hilly areas and near tall buildings. The label says so; Phase 2 fixes it.
- **Two engines** (TypeScript preview, Python job) can drift; the shared golden vectors are the guard.
- **Grid azimuth without a CRS:** coverage is refused (D2). Projects without a CRS need one first.

## Open for the founder

1. Ship a seed catalogue of about 20 real products (marked unverified until checked), or only the generic entries plus import?
2. Should a coverage run be included when a project is packaged (`.aio`)? Default yes for `run.json` and the composite grids, no for the per-sector cache.
3. Is the CSV import format worth agreeing with a pilot operator before Phase 1 ends?

## Sources

- 3GPP antenna model reference implementation: <https://www.nsnam.org/doxygen/d1/d75/classns3_1_1_three_gpp_antenna_model.html>
- MSI pattern format: <https://www.mathworks.com/help/antenna/ref/msiread.html>
- Antenna pattern formats and libraries: <https://cloudrf.com/documentation/10_reference_data.html>
- COST-231 Hata validity: <https://help.altair.com/winprop/topics/winprop/user_guide/propagation_methods/propgation_models_terrain_hata_okmura_model.htm>
- RSRP and RSSI relation: <https://www.rfwireless-world.com/calculators/LTE-RSRP-and-RSRQ-calculator.html>
- Copernicus DEM: <https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM>
- Terrain and clutter in ITU-R P.1812: <https://arxiv.org/html/2501.11708v1>
- Signal-Server (GPL, reference only): <https://github.com/expressionnetworks/signal-server>
- Sionna RT (Phase 3 option): <https://research.nvidia.com/publication/2025-04_sionna-rt-technical-report>
- Hata accuracy on measured routes: <https://ideas.repec.org/a/ibn/nctjnl/v2y2013i2p1.html>
- Lead market band listing: <https://www.kimovil.com/en/frequency-checker/AE>
- KSA band listing: <https://www.kimovil.com/en/frequency-checker/SA>
- STC 3G and 2G switch-off: <https://www.stc.com.sa/en/business/static/3G-shutdown.html>
- 2G and 3G switch-off in MENA: <https://cullen-international.com/news/2023/07/Latest-status-of-2G-and-3G-network-switch-off-in-MENA.html>
- GCC spectrum: <https://insights.opensignal.com/2024/11/14/spectrum-and-network-evolution-in-mena-insights-from-gcc-markets>
