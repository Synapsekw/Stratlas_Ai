---
type: session
date: 2026-11-09-2154
branch: fix/manifest-lock-race
status: complete
related: [2026-11-09-2030-flyability-short-paths.md, 2026-10-25-2120-area-compare-one-layer.md]
---

# Pipeline jobs write the manifest under its lock

## What changed

- Every pipeline job that adds layers now reads, changes and writes `manifest.json` under the project's manifest lock (`runtime.manifest_lock`), reading it again inside the lock: `pointcloud.to_copc` (register), `bentley.import`, `opf.import`, `drawing.import`, `photo.products`, `pointcloud.clean`, `road.build` and `volumetric.build`. Only `change.*` and `flyability.import` took the lock before.
- `bentley.import` now writes its run file inside the lock as well, so the run's survey date and CRS come from the same read as the layer.
- New `python/tests/test_manifest_race.py`: the job under test is held just before its manifest write while another job commits. It fails on the old code (the other job's layer is lost, as in the Bentley e2e run where the photos layer went missing) and passes now, for the cloud register, the Bentley import (against a locked writer, and against a real cloud job finishing at the same time), the drawing import and the OPF import.
- Pack stays 0.34.0 (not released yet); its version note and the Settings guide line say it also carries this fix.

## Why

`e2e/bentley-import.spec.ts` once ended on CI with a mesh and a cloud but no photos: `bentley.import` and `pointcloud.to_copc` finished together and the later manifest write dropped the earlier job's layer.

## How to test

No user-facing behaviour to test; covered by the test suite. In use: import a Bentley block together with its `.zpc` cloud several times. The project always ends with the photos layer and the cloud.

## Open threads

- The app's own manifest saves (`withManifest` in `packages/project/src/builder/manifestFile.ts`) queue only within the app's process and do not take the pipelines' lock file (`jobs/.manifest.lock`), so an app save (a rename, a survey date) at the moment a job commits can still drop one side's change. Sharing the lock means an operating system lock from Node (a native add-on or a lock-file protocol the Python side also honours), which is not a small change.
- Photo products, cleanup, road and volumetric builds are fixed the same way but have no dedicated race test (their existing suites pass).

## Next session entry point

Hand this branch to the merge coordinator. A later branch can give the app's manifest saves the same lock file.
