# Next phase: M4 Release A completion and M5 Builder foundations

> **For agentic workers:** each stream below is one agent in its own git worktree, branched from `main` after M3 merges. Use superpowers:test-driven-development; follow `CONTRIBUTING.md`, `docs/architecture/data-conventions.md` and `docs/design/DIRECTION.md`. Verify on the real projects in `E:\Stratlas Data\projects\` with Playwright `_electron` (env `STRATLAS_DATA=E:/Stratlas Data`, temp `STRATLAS_USER_DATA`). Small conventional commits; never push.

**Goal:** close every Release A "must" in the PRD (customer mode, reports and exports, native volumetric and road workspaces, AI completeness, map packs, offline updates, Store package) and lay the Release B foundation (bundled Python pipelines, new-project wizard, raw-data import and alignment), so the next milestone builds new deliverables inside the app.

**Spec:** `docs/PRD.md` v1.1 (sections 6 and 9), `docs/architecture/SPEC.md` (sections 6, 7, 10).

## Global constraints

- Offline by default; zero network unless cloud AI is on or the person starts an explicit online action (map pack download, update check).
- Product name only from `@aio/brand`; contracts change only with an entry in `docs/architecture/contract-changes.md`.
- Every new IPC channel is added to `packages/schema/src/ipc.ts` with zod schemas and validated in main.
- Mission UI tokens and patterns; no remote assets.

## Review focus

1. A customer package opened on a machine without Stratlas data paths must open read-only, never write issues, and never call cloud AI unless the package allows it.
2. Exports of projects with hundreds of issues (DAMAC 656 defects) finish without freezing the UI.
3. Volumes recomputed in the native volumetric workspace must equal the original kit values within 0.5 %.
4. A Python pipeline that crashes or is cancelled leaves the project unchanged and the job resumable.
5. Raw video with DJI SRT telemetry imports to an `aio.flight/1` file whose frame times match the video within one frame.

## Streams

| Stream                          | Scope                                                                                                                                                                                                                                                                                                                                                            | PRD                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| N1 Volumetric workspace         | Native Masafi workspace: pile list, four bases, volumes, cut and fill between dates, sections, boundary editor in 3D, stockpile register; data from `volumes.json`, DSM terrain and piles; parity with the original review                                                                                                                                       | REV-3                      |
| N2 Road workspace               | Native Ring Road workspace: map-first layout, defect layer by stage and type, PCI sample-unit grid with Low/Med/High toggle, chainage ruler, close-up viewer, filters, measure; parity with the original review                                                                                                                                                  | REV-4                      |
| N3 Reports and exports          | In-app PDF viewer (bundled pdf.js), exports: issues CSV, GeoJSON, COCO, kit JSON, masks ZIP, screenshots and view snapshots; issue register report (branded PDF) via a print-to-PDF window                                                                                                                                                                       | REV-5, REV-6, ANN-11       |
| N4 Customer mode and packages   | Native `.aio` package export (ZIP64 store, optional AES, size report), double-click open with file association, read-only player mode, package AI policy (forbid by default), export limits; customer onboarding screen                                                                                                                                          | APP-5, BLD-9               |
| N5 AI completeness              | Conversation history per project, approvals that survive restart, preview of what will be sent (AI-6), per-project cost meter, frame capture for map and photo windows, more tools (compare captures, measure, export, summarise by zone), local-model provider seam                                                                                             | AI-6 to AI-9               |
| N6 Platform                     | Map pack manager (list, add a region online by bbox or country, import a pack file offline), light theme, RTL and Arabic readiness, offline update by installer file + optional online check, settings polish, Store MSIX build once identity values arrive                                                                                                      | MAP-3, APP-2, APP-3, APP-7 |
| N7 Point clouds at scale        | COPC/LAZ support in the viewer (copc.js + laz-perf workers), full-resolution Al-Zour cloud converted to COPC (PDAL in the pipeline pack, or a one-off conversion now), GPU-tier presets, perf HUD and a CI perf test on a recorded camera path                                                                                                                   | FUS-8                      |
| B1 Pipeline runtime             | `python/` package `aio_pipelines`, python-build-standalone + uv lock as a separately packaged "pipeline pack", JSON-RPC over stdio, Jobs panel (progress, logs, cancel, resume), first ported pipelines from the Asset Inspection Kit (cameras from EXIF/XMP, project back-projection, records/stats) and the Volumetric Survey Kit (resample, process, package) | BLD-4                      |
| B2 Builder wizard and alignment | New project wizard (type, CRS, origin, brand), raw import (photos with EXIF/XMP, video + DJI SRT telemetry to `aio.flight/1`, GLB/OBJ, LAS/LAZ/E57 via the pipeline pack, GeoTIFF ortho/DSM), alignment tools (georeference a model by picking points, video time offset and field-of-view calibration against the model; fixes the estimated Al-Zour FOV)       | BLD-1 to BLD-3             |

## Integration

The integration lead merges each stream when `pnpm check` and `pnpm test:e2e` are green, rebuilds the installer, and smoke-tests all six projects. Stream conflicts are resolved in favour of the contract; contract changes are logged.

## Exit

- Every PRD Release A "must" checked off in `docs/TESTING-M4.md` with a test or a screenshot.
- A new inspection project created in the app from raw photos and a GLB, aligned, annotated and exported, end to end.
