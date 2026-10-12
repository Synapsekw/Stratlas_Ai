# M10 hardening and docs: design

The M10 plan (`docs/plans/2026-10-07-m10-globe-and-photogrammetry.md`, "Integration follow-ups") still lists four open items after the streams landed: diagnostics (D5), accessibility (D6), performance (D7) and the docs. This branch closes them, short of what only the founder can do (the exit smoke tests, the Stage M10 tick-off and the size budget sign-off, listed at the end).

Scoped on 12 Oct 2026 by an agent without the founder: every question below was answered with the recommended option, and the answers are listed under "Decisions taken (founder to confirm)".

## What is there today

- **Diagnostics.** `apps/desktop/src/main/diagnostics/bundle.ts` writes `system.json`, `settings.json`, `packs.json` (map packs and the pipeline pack runtime, with its version), `jobs.json` (the last 25 jobs: status, steps, `packVersion`, no parameters), `projects.json`, `updates.json`, `local-ai.json`, `errors.txt`, logs and crash reports. Nothing about photo processing beyond the job rows. Everything D5 asks for already exists on disk: each run's `photogrammetry/<run>/run.json` (`aio.photo-run/1`) has `versions` (the component versions: `pack`, `colmap`, `pdal`, `opencv` and so on), `stages[]` with `seconds` and `memoryPeakBytes`, and `hardware` (a `HardwareProbe`); the live probe is cached by `registerPhotogrammetryIpc` (`photo:probe`).
- **Accessibility.** The brief assumed the photo wizard had no axe check. It has three: `apps/desktop/e2e/photo-process.spec.ts` audits the wizard ready to start (line 154), with **Options** open (line 196) and blocked without processing tools (line 524), and audits the run panel, the GNSS-only report and refined poses. GCP import, table, marker and report (`gcp-marking.spec.ts`) and the Globe (`globe.spec.ts`) have axe too, and GCP marking is done by keyboard there. What is missing: the wizard while a run starts (the screenshot `create-maps-running`, line 231), the wizard with its questions shown (disk, time, zone: `create-maps-questions`, line 490), the "tools too old" blocked state (line 574), and a check that the wizard can be completed from the keyboard alone.
- **Performance.** `apps/desktop/e2e/perf.spec.ts` has the M7 budgets: a synthetic project on the software GPU (SwiftShader, detected as the Low tier) everywhere, CI included, and recorded fly-throughs of the real projects at 60 fps on the workstation (`@realdata`, skipped on SwiftShader). Nothing measures 3D Tiles or the Globe. The tile budgets per tier are in `packages/tiles/src/budgets.ts` (Medium: screen-space error 12 px, 384 MB tile cache); the point budgets in `apps/desktop/src/renderer/graphics.ts` (Medium: 4 M points, at most 8 M). A person can override the tier (the graphics store's `override`), and `window.__stratlas.graphics` exposes that store to tests. `createGlobeLibrary` (`apps/desktop/e2e/m10Fixtures.ts`) already writes five placed sites, a world imagery pack and two region packs (imagery and terrain around site A).
- **Docs.** `ROADMAP.md` still says M10 is "Being written" and "Next". `PRD.md` already carries the non-goal change (photogrammetry moved into scope, 7 Oct) and PHO-1 to PHO-8 and GLB-1 to GLB-5, but they drifted from what was built: PHO-1 names a "Fast" preset (the app says **Quick**) and a Builder wizard (it is **Create maps from photos** in the Processing drawer); GLB-1 says the Globe makes "no request", while online satellite imagery (off by default) can now be switched on. `SECURITY-AND-DATA.md` lists online satellite and map downloads but says nothing about the Globe itself.

## Design

### D5: photo processing in the diagnostics bundle

A new bundle member, `photo.json`, written only when the photo source is wired (the app always wires it; tests and tools may not):

```json
{
  "probe": { "platform": "win32", "arch": "x64", "cpu": { "model": "...", "cores": 8, "threads": 16 },
             "memoryBytes": 34359738368, "freeDiskBytes": 512000000000,
             "gpus": [{ "name": "...", "vendor": "...", "vramBytes": 8589934592 }],
             "cuda": false, "accelerator": { "state": "ready", "version": "0.1.0", "driver": "560.94" },
             "processing": "available" },
  "runs": [
    { "project": "<project id>", "id": "20260314-1000", "createdAt": "...", "updatedAt": "...",
      "status": "done", "preset": "standard",
      "photos": { "count": 24, "registered": 22, "rejected": 2 },
      "versions": { "pack": "0.5.4", "colmap": "...", "pdal": "..." },
      "stages": [{ "name": "align", "state": "done", "seconds": 512.4, "memoryPeakBytes": 6442450944,
                   "device": "cpu" }],
      "totalSeconds": 1840.2, "memoryPeakBytes": 6442450944,
      "accuracy": { "control": {...}, "check": {...}, "meanReprojPx": 0.8, "gsdCm": 2.1 },
      "warnings": 3, "hardware": { ...the run's own probe, same allow-list... } }
  ]
}
```

- **An allow-list, not a deny-list.** A pure function copies the named fields only. Never copied: `photos.source` (folders and files), `settings` (the job parameters, with paths), `region` (lon/lat), `crs` (it can carry the project origin), `cameras`, `outputs` (project paths), stage `message` (free text that can name a file), warning texts (only their count), the accelerator's `reason`. "Native build ids" are the run's `versions` record, the component versions the pack itself writes, plus the GPU add-on version from the probe; the pack version is already in `packs.json`.
- **Which runs.** The latest three runs across the projects open in this run of the app (the bundle already limits `projects.json` to those), newest first. A project that cannot be read is skipped. No open project: `runs: []`.
- **Failure.** The source may fail like every other: the member then holds `{ "error": "..." }` and the bundle is still written (`attempt()` in `bundle.ts`). Every text still goes through `redactText` last.
- **README.txt** gains one line for `photo.json`, and "What is never inside" adds "photo file names or folders, coordinates".
- **Wiring.** `registerPhotogrammetryIpc` returns `{ diagnostics(projectIds) }`; it already holds the probe cache and the run readers. `registerDiagnosticsIpc` runs before it in `index.ts`, so the bundle's `photo` source reads a late-bound reference.

No `@aio/schema` change: the bundle's layout is not a contract, and every input type already exists.

### D6: the wizard's remaining axe checks

Add `expectAccessible(win, ..., { include: '[data-testid="photo-wizard"]' })` at the three states that have a screenshot but no audit (starting, questions, tools too old), and one keyboard test on the stand-in pipelines: from the Processing drawer, with Tab, Enter and Space only, open the wizard, open **Options**, choose **Quick**, close **Options**, reach **Create maps**, then Escape closes the wizard and focus returns to **Create maps from photos**. A violation found is fixed in `apps/desktop/src/renderer/photogrammetry/**`, not allow-listed.

### D7: what CI can measure, and what it cannot

CI renders on SwiftShader at 1100 x 700 on two vCPUs. It cannot show 30 fps, nor hold a 500 M point cloud (about 7.5 GB as COPC) or a 20 M triangle tileset (about 1 GB) in a repository fixture. D7's targets are two claims in one: **the budgets hold** (the tile cache stays under the tier's cap, points drawn under the tier's budget, however large the data) and **the frame rate holds** on real hardware. The first is logic and runs anywhere; the second needs the hardware.

1. **CI-sized proxy (every merge, `e2e/perf-m10.spec.ts`).** On the software GPU with the tier overridden to **Medium**:
   - _Tiles._ A generated quadtree mesh tileset (85 tiles of the 12,800 triangle `gridGlb`, about 1.1 M triangles and 20 MB, written into the tiny project before launch) with the Medium tile cache scaled to 1 % (3.8 MB, through a renderer test hook), so the data is about five times the cap (20 M triangles, about 1 GB, are between two and three times the real cap). Fly a recorded path; assert at every sample that the cache is under the scaled cap, that every tile in view settles to the Medium screen-space error, and the frame p95 under `QUADRION_PERF_M10_P95_MS`.
   - _Points._ The 16,000 point COPC fixture with the point cap set to 4,000 through `__stratlas.pointcloud`: drawn points never exceed the cap.
   - _Globe._ `createGlobeLibrary` (three sites in view, the two region packs, terrain on since the tier is Medium) with a recorded fly-over; frame p95 under `QUADRION_PERF_GLOBE_P95_MS`; zero network, as every test.
   - The ceilings start generous (400 ms for both; the Low synthetic budget is 250 ms) and are set to twice the median p95 of three CI runs once those runs exist, with the run ids noted in the spec's header comment. The numbers are attached to the test results, like `perf.spec.ts`.
2. **Opt-in local benchmark (`e2e/perf-m10-bench.spec.ts`, `@bench`).** Skipped unless `QUADRION_BENCH=1` and the hardware GPU is in use (it refuses SwiftShader). Data from `tools/bench/m10-bench-data.mjs`, written outside the repository to `QUADRION_BENCH_ROOT` and reused: a 20 M triangle quadtree tileset and a synthetic COPC (`--points`, default 100 M so a first run takes minutes; `--points 500e6` for the full target, made in chunks with PDAL and merged with `tools/pointcloud/merge-copc.mjs`). On the detected tier, or Medium forced, it asserts the real Medium caps (384 MB cache, 4 M points) and p95 at or under 33.3 ms (30 fps) for the site view and the Globe, and writes a JSON report. Runs only when the founder gives a window (the PC must not be in use).

### Docs

- `ROADMAP.md`: the M10 row links its plan; status "Built in 0.10.0 to 0.11.x; exit waits on the founder's smoke tests and sign-off".
- `SECURITY-AND-DATA.md`: the Globe draws the bundled Natural Earth imagery and installed packs and makes no request of its own; the only exception is online satellite imagery, which is off by default, switched on by a person and never on an offline-only workstation (the existing row). Imagery and terrain packs reach the computer only when a person downloads or imports one. The section is checked against the code (`apps/desktop/src/renderer/globe/request.ts`, `apps/desktop/src/main/packs/**`) before writing.
- `PRD.md`: PHO-1 says **Quick**, Standard, High and "Create maps from photos (Processing drawer)"; GLB-1 keeps "no account, token or request" and adds "unless online satellite imagery is switched on"; every other PHO and GLB line is checked against Stage M10 of `TESTING.md` and changed only where it drifted. The non-goal change is there already.
- The M10 plan's follow-ups get a dated note: D5, D6 and D7 done here (with this plan's path), D7 split into the proxy and the benchmark. `TESTING.md` Stage M10 gets a step for `photo.json` in the diagnostics bundle and one for the optional benchmark.

Not on this branch: `SPEC.md` sections, the data-conventions sections, `THIRD-PARTY-NOTICES.md`, the user guide (D8), the macOS items (parked), and the files another session edits now (`CLAUDE.md`, `.claude/commands/develop.md`, `docs/NORTH-STAR.md`, `KNOWN-LIMITS.md` line 37, `docs/sessions/` drafts).

## Decisions taken (founder to confirm)

1. **D5 reads what the runs already write.** No new measurement and no schema change: timings and memory peaks come from `run.json` stages, the build ids from its `versions`. (Alternative: a new field in `JobRecord`; rejected as a contract change for data that exists.)
2. **D5 is an allow-list** of the fields above, and keeps per-run accuracy figures (RMSE and reprojection numbers, no point coordinates). (Alternative: drop accuracy too; kept because support asks for it first.)
3. **D5 covers the latest three runs of the projects opened in this run of the app**, not every project on disk (the bundle never walks the library).
4. **D6 adds the three missing audits and one keyboard pass** instead of a new a11y spec; the existing audits stay where they are.
5. **D7 in CI is a proxy of the budgets, not of the frame rate**: Medium forced on SwiftShader with the caps scaled to make the data about five times larger than the cap. It runs on every merge (about a minute on one shard; the shard splitter balances it).
6. **The frame-rate targets (30 fps, 500 M points, 20 M triangles) are an opt-in local benchmark** on the founder's machine, run only in a window the founder gives, with a 100 M point default and 500 M on request.
7. **The tile budget scale is a renderer test hook on `window.__stratlas`** (like the graphics store already there), not an environment variable through the preload, so no bridge change.
8. **Docs: the PRD is corrected, not rewritten.** Only drifted words change.

## Founder-only M10 exit items

- [ ] Smoke tests on the founder's machine with Wi-Fi off: the photo demo end to end on CPU with checkpoint RMSE within targets; the founder's nadir flight with GCPs (Standard) with an accuracy report the founder accepts; the oblique flight (mesh); outputs in the existing viewers and the Globe; OPF round trip with another reader; the Globe offline with every library project, attributions and hand-over to the site view; the zero-network suite.
- [ ] Stage M10 of `docs/TESTING.md` ticked off, every PHO and GLB line seen.
- [ ] Size budget sign-off: pipeline pack and installer sizes against decision 6 (or a recorded change to the budgets).
- [ ] A window for the opt-in benchmark (D7), and the 500 M point run if wanted.
- [ ] Confirm or change the decisions above.
