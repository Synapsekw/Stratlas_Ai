---
type: session
date: 2026-10-17-2125
branch: feat/rf-coverage
status: complete
related:
  [
    superpowers/specs/2026-10-17-rf-coverage-design.md,
    superpowers/plans/2026-10-17-rf-coverage-phase1.md,
  ]
---

# RF coverage backend

## What changed

- Research, design spec, Phase 1 plan and a clickable mockup (`docs/design/rf-coverage/`) for predicting tower coverage from antenna azimuth and tilt plus an antenna and radio selector. Scope: LTE and NR on the lead market's bands; coverage sits on the satellite or street basemap with per-layer opacity.
- Landed the backend as #169 (`f83df907`): `packages/rf` (band table, 3GPP 38.901 pattern, MSI patterns, 3D mechanical tilt, RSRP, 38.901 and Hata path loss, sector grouping, a live preview of about 30 to 50 ms for 280k pixels), a seed catalogue (9 generic, 19 vendor entries from public datasheets, all `verified: false`), the `aio.rf-*` schemas and `rf:*` IPC, GeoTIFF, GeoJSON and CSV export, `.aio` packaging without the path-loss cache, and the `rf.coverage` job (pipeline pack 0.15.0).
- Shared golden vectors (29 pattern and budget, 434 propagation) come from independent stdlib generators; the TS engine and the Python job both pass them to 0.01 dB, and a committed run from the job is read by the TS reader in tests.
- Rulings: dual-band radios are one catalogue row per band; a UE below the model range is clamped (1.5 m UMa and UMi, 1 m RMa) with a warning; AAU power means total SSB-beam power; a newer project catalogue refuses the save instead of being overwritten.

## Why

The founder asked for telecom coverage from tower azimuth and tilt with selectable antennas and radios. The antenna geometry comes from the antenna detection inventory; the radio settings a drone cannot see (band, power, electrical tilt) are entered per sector.

## How to test

No user-facing behaviour to test yet; covered by the test suite. Settings, Advanced lists "Telecom coverage", which reports a missing setting if started.

## Open threads

- T8 to T12 (store, RF workbench tab, coverage layer and legend, Edit RF..., e2e) wait for stage-island stages 2 and 3.
- Catalogue values need checking against datasheets; AAU broadcast gains are estimates; no Nokia entry.
- Deferred minors: `RF_COVERAGE_MIN_PACK` not enforced yet, no `tools/compat` additive test for the rf files, multi-band radio ranges in the schema.

## Next session entry point

When stage 2 lands, cut a branch from main and build T8 to T12 from the plan, starting with the RF store and the workbench tab.
