# Next phase: M6 Release B completion (Builder)

> Draft, 4 Oct 2026. Starts after the M5 feedback round (founder test fixes) is merged, the installer is rebuilt and `docs/TESTING-M5.md` is written.

**Goal:** a person builds a complete deliverable inside Stratlas, from raw data to a branded report and a customer package, with the same quality as the six original reviews: run the kits' pipelines, review and correct detections, let AI draft detections and narrative under human review, and print the report in the house format with the user's own branding.

## Global constraints

- Offline first; cloud AI only when the user turns it on, with the preview of what is sent (AI-6).
- Pipelines run in the bundled pipeline pack (python-build-standalone + uv), JSON-RPC over stdio, resumable; a resume is refused when inputs changed.
- Delivered data is never modified in place; every writer backs up and swaps atomically; user issues are never dropped by an importer or pipeline.
- Reports carry the user's branding (Settings, report branding) or neutral branding; never a client's brand unless the user picks it.
- Test windows stay off-screen (`STRATLAS_USER_DATA`); e2e `--workers=1` locally.
- `pnpm check`, `pnpm test:e2e` and pytest green before each merge.

## Review focus

- A pipeline killed mid-run (app quit, crash, power loss) resumes or restarts cleanly, never leaves a half-written project.
- Photo sets with missing or wrong GPS / EXIF, mixed cameras, and videos without SRT telemetry: imported with a clear warning, not silently misplaced.
- Thousands of detections on hundreds of photos: review stays responsive (virtualised contact sheets, paged masks).
- AI detection with no key, an invalid key, rate limits or a refused request: an exact error, nothing counted until a person accepts it.
- A report for a project with no issues, or with issues lacking photos or 3D positions, still prints.

## Streams

| Stream                   | Scope                                                                                                                                                                                                                                                                | PRD               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| P1 Inspection pipeline   | Port the rest of the Asset Inspection Kit to `aio_pipelines`: tiling, detection pass hooks, back-projection of detections to the mesh, clustering into issues, stats; run from the Jobs panel on a new project                                                       | BLD-4             |
| P2 Volumetric pipeline   | Volumetric Survey Kit end to end from raw DSM/ortho per date: pile detection, toe lines, four bases, `volumes.json`, terrain tiles; a new volumetric project opens in the native workspace                                                                           | BLD-4             |
| P3 Road pipeline         | Road builder: ortho tiling, chainage from a centreline, defect polygons import, PCI sample units and deducts                                                                                                                                                         | BLD-4             |
| R1 Detection review      | Contact sheets, boxes and masks (draw, edit, SAM-class assist via ONNX when available), class, severity, note, uncertain flag; accept / reject with keyboard; links to issues                                                                                        | BLD-5, BLD-10 (C) |
| R2 AI-assisted detection | Vision model passes over photos and video frames with the configured provider, batched with cost estimate and preview, results land as Draft for review in R1                                                                                                        | BLD-6             |
| R3 Narrative             | AI-drafted executive summary, method and findings text from project statistics; edited in place; versioned                                                                                                                                                           | BLD-7             |
| R4 House-format report   | PDF report generation for any project type in the house format: cover, method, statistics, register, one page per issue, appendices; user branding; reproduces the EBSM and DAMAC report structure                                                                   | BLD-8             |
| A1 Al-Zour orientation   | Per-clip orientation (pitch/roll/yaw bias) calibration against the model, alongside the existing time offset and lens; removes the ~8 degree pitch error                                                                                                             | BLD-3             |
| X1 Packages and packs    | Edit a package ("extract to edit"), include map packs in packages, resumable map pack download                                                                                                                                                                       | BLD-9, MAP-3      |
| X2 Streaming smoothness  | COPC streaming hitches on Al-Zour: the recorded fly-through holds 53 to 55 fps but its p95 frame time flips between 16.8 and 33.3 ms (budget 20 ms) as nodes stream in (decode, upload and node swap spread across frames; worker transfer, upload budget per frame) | FUS-8             |

## Integration

As in M4: worktree streams, integration lead merges when green, rebuilds the installer, smoke-tests all six projects plus one project built from raw data per type (inspection, volumetric, road).

## Exit

- One new project of each type built in the app from raw data, reviewed, reported and packaged, end to end, on the founder's machine.
- Stage M6 of `docs/TESTING.md` with every BLD "must" checked by a test or a screenshot.
