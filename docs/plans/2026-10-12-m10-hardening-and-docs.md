# M10 hardening and docs: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the M10 integration follow-ups D5 (diagnostics), D6 (accessibility), D7 (performance) and the M10 docs, leaving only the founder's exit items.

**Architecture:** D5 adds a `photo.json` member to the diagnostics bundle, built by a pure allow-list function from the cached hardware probe and the latest `run.json` files of the open projects. D6 adds three axe audits and one keyboard pass to the existing wizard spec. D7 adds a CI-sized budget proxy (Medium forced on SwiftShader, caps scaled through a renderer test hook) and an opt-in local benchmark on real hardware. Docs are corrected where they drifted.

**Tech stack:** TypeScript, Electron main and renderer, 3DTilesRendererJS through `@aio/tiles`, CesiumJS, Vitest, Playwright with Electron, axe-core.

**Spec:** `docs/plans/2026-10-12-m10-hardening-and-docs-design.md` (decisions taken without the founder are listed there).

## Global constraints

- Work only in `.claude/worktrees/m10-hardening-and-docs`, branch `chore/m10-hardening-and-docs`. Never edit the main checkout.
- Do not touch the files another session edits now: `CLAUDE.md`, `.claude/commands/develop.md`, `docs/NORTH-STAR.md`, `docs/KNOWN-LIMITS.md` (line 37 especially), `docs/sessions/` drafts.
- No `@aio/schema` change, no new IPC channel, no preload bridge change.
- `photo.json` never holds photo file names or folders, coordinates (lon/lat, eastings, the project origin), job parameters or free-text stage messages.
- User-facing text: plain words, no emoji, no em or en dashes. No client, site or person names anywhere (`node tools/agent/check-public-text.mjs <files>`).
- E2E runs: `--workers=1`, one Playwright run at a time, off-screen (`QUADRION_USER_DATA` isolation as the fixtures do), the CI way: `QUADRION_WINDOW_SIZE=1100x700`, `QUADRION_E2E_SCALE=1`, `QUADRION_E2E_SWGL=1`, every demo built (`pnpm demo:change --quick`, `demo:build`); in a worktree point `QUADRION_E2E_PYTHON` at the main checkout's `python/.venv`.
- No heavy local benchmark without a window from the founder: T7 is built and its spec skips by default; nobody runs the 100 M or 500 M point data on this branch.
- Scratch files outside the worktree (a `.superpowers/` folder inside fails `pnpm format:check`).

## Review focus

1. **A run with a stage message that names a photo path** (`"could not read C:\\Users\\x\\flight\\IMG_0001.JPG"`): `photo.json` must not contain it. T1 test.
2. **A run in a project opened from a read-only `.aio` package**: its run is read through the package source and listed, never written. T3 test.
3. **A corrupt or half-written `run.json`** in one open project: that project is skipped, the others are listed, the bundle is still written. T3 test.
4. **The probe failing** (no pack, `system` absent in a build): `probe` is `null`, runs are still listed. T1 test.
5. **The tile budget scale left set after a test**: the hook only scales while set and `setBudgetScale(1)` restores the tier budget exactly; a person's session never sees a scale (default 1). T5 test.

## Execution DAG

```
T1 photo.json allow-list ──┐
T2 bundle member ──────────┴─> T3 wiring + e2e ───────────────┐
T4 wizard axe + keyboard ─────────────────────────────────────┤
T5 tiles stats + scale hook ─> T6 CI proxy spec ─> T7 bench ──┼─> T12 verify, hand-off
T8 ROADMAP ───────────────────────────────────────────────────┤
T9 SECURITY-AND-DATA ─────────────────────────────────────────┤
T10 PRD ──────────────────────────────────────────────────────┤
                          (T3, T6) ─> T11 M10 plan + TESTING ─┘
```

- **Batch A (parallel, no shared files):** T1, T2, T4, T5, T8, T9, T10.
- **Batch B (parallel):** T3 (needs T1, T2), T6 (needs T5).
- **Batch C (parallel):** T7 (needs T6's tileset builder), T11 (needs T3's member name and T6's spec name and ceilings).
- **Batch D:** T12 (needs everything).
- **Critical path:** T5, T6, T7, T12 (T6 is the longest task: it needs three CI runs to set the ceilings, see T6 step 6).

Heavy runs (check, e2e, commits) go through the shared one-at-a-time runner; subagents in a batch edit files in parallel but queue their test runs.

## Package ownership

| Task | Packages and folders                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1   | `apps/desktop/src/main/diagnostics/` (new `photo.ts`, `photo.test.ts`)                                                                           |
| T2   | `apps/desktop/src/main/diagnostics/bundle.ts`, `bundle.test.ts`                                                                                  |
| T3   | `apps/desktop/src/main/photogrammetry.ts`, `photogrammetry.test.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/e2e/diagnostics.spec.ts`    |
| T4   | `apps/desktop/e2e/photo-process.spec.ts`; fixes only in `apps/desktop/src/renderer/photogrammetry/**`                                            |
| T5   | `packages/tiles/src/adapter.ts`, `adapter.test.ts`; `apps/desktop/src/renderer/workspace/siteTiles.ts`; `apps/desktop/src/renderer/bootstrap.ts` |
| T6   | new `apps/desktop/e2e/perf-m10.spec.ts`, new `apps/desktop/e2e/quadtreeTileset.ts`, `tools/ci/e2e-timings.json`                                  |
| T7   | new `apps/desktop/e2e/perf-m10-bench.spec.ts`, new `tools/bench/m10-bench-data.mjs`, `m10-bench-data.test.mjs`, `apps/desktop/e2e/gridGlb.ts`    |
| T8   | `docs/plans/ROADMAP.md`                                                                                                                          |
| T9   | `docs/release/SECURITY-AND-DATA.md`                                                                                                              |
| T10  | `docs/PRD.md`                                                                                                                                    |
| T11  | `docs/plans/2026-10-07-m10-globe-and-photogrammetry.md`, `docs/TESTING.md`                                                                       |
| T12  | none (verification and hand-off)                                                                                                                 |

## Contract changes

None. No `@aio/schema` type, IPC channel, bridge method or file contract changes; `photo.json` is a new member of the diagnostics zip, which is not a contract (its README lists the members). No row for `docs/architecture/contract-changes.md`.

## E2E specs added or changed

- Changed: `e2e/diagnostics.spec.ts` (T3), `e2e/photo-process.spec.ts` (T4).
- Added: `e2e/perf-m10.spec.ts` (T6, every merge), `e2e/perf-m10-bench.spec.ts` (T7, `@bench`, skipped unless `QUADRION_BENCH=1`).

---

## Tasks

### T1: `photoDiagnostics`, the allow-list (size S)

**Files:**

- Create: `apps/desktop/src/main/diagnostics/photo.ts`
- Test: `apps/desktop/src/main/diagnostics/photo.test.ts`

**Interfaces:**

- Consumes: `HardwareProbe`, `PhotoRun` types from `@aio/schema`.
- Produces:

```ts
export interface PhotoRunIn {
  project: string;
  run: PhotoRun;
}
export interface PhotoDiagnostics {
  probe: Record<string, unknown> | null;
  runs: Record<string, unknown>[];
}
/** Newest `max` runs (by updatedAt ?? createdAt, then id), allow-listed. */
export function photoDiagnostics(
  probe: HardwareProbe | null,
  runs: readonly PhotoRunIn[],
  max = 3,
): PhotoDiagnostics;
export function probeSummary(p: HardwareProbe): Record<string, unknown>;
export function runSummary(project: string, run: PhotoRun): Record<string, unknown>;
```

- [ ] **Step 1: Write the failing tests** in `photo.test.ts` with a fixture `PhotoRun` (parse it with `PhotoRun.parse` so the fixture stays valid) that has `photos.source` with a folder `C:\\Users\\tester\\flight`, `settings: { folders: ['D:\\\\drone\\\\day1'], products: ['ortho'] }`, `region` with lon/lat 51.5, 25.3, a `crs` with an origin, a stage `message: 'could not read C:\\Users\\tester\\flight\\IMG_0001.JPG'`, `warnings: ['IMG_0002.JPG has no GPS']`, `versions: { pack: '0.5.4', colmap: '3.12.0' }`, three stages with `seconds` 10, 20.5, 30 and `memoryPeakBytes` 1e9, 3e9, 2e9, and a `hardware` probe whose accelerator has `reason: 'C:\\\\drivers\\\\x'`. Tests:
  - `runSummary` keeps `project`, `id`, `createdAt`, `updatedAt`, `status`, `preset`, `photos: { count, registered, rejected: <length> }`, `versions`, `stages` (`name`, `state`, `seconds`, `memoryPeakBytes`, `device`, `fallbacks` when present), `totalSeconds: 60.5`, `memoryPeakBytes: 3e9`, `accuracy`, `warnings: 1`, `hardware` through `probeSummary`.
  - `JSON.stringify(runSummary(...))` contains none of `tester`, `drone`, `IMG_`, `51.5`, `25.3`, the origin numbers, `drivers`, `message`, `settings`, `region`, `source`.
  - `probeSummary` keeps `platform`, `arch`, `cpu`, `memoryBytes`, `freeDiskBytes`, `gpus`, `cuda`, `processing`, `accelerator` without `reason`.
  - `photoDiagnostics(null, [])` is `{ probe: null, runs: [] }`; five runs give the newest three, newest first; a run without `memoryPeakBytes` on any stage has no `memoryPeakBytes` key.
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/main/diagnostics/photo.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `photo.ts`: explicit picks only (no spreading of `run` or `probe`); `totalSeconds` is the sum of stage `seconds` rounded to 0.1 and present only when some stage has seconds; `memoryPeakBytes` is the max over stages.
- [ ] **Step 4: Run** the test again. Expected: PASS. Then `pnpm --filter @aio/desktop exec tsc --noEmit -p tsconfig.node.json` (or the package's main tsconfig).
- [ ] **Step 5: Commit** `feat(diagnostics): photo processing summary without paths or coordinates`.

### T2: `photo.json` in the bundle (size S)

**Files:**

- Modify: `apps/desktop/src/main/diagnostics/bundle.ts` (`BundleSources`, `README`, `collectBundle`)
- Test: `apps/desktop/src/main/diagnostics/bundle.test.ts`

**Interfaces:**

- Produces: `BundleSources.photo?: () => Promise<unknown> | unknown` (T3 passes `photoDiagnostics(...)`'s result).

- [ ] **Step 1: Failing tests** in `bundle.test.ts` (follow the existing fake sources there): with `photo: () => ({ probe: null, runs: [] })` the bundle has `photo.json` with that content; without `photo` there is no `photo.json`; with `photo: () => { throw new Error('boom') }` `photo.json` is `{ "error": "boom" }` and every other member is still there; `README.txt` mentions `photo.json` and "photo file names or folders, coordinates".
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/main/diagnostics/bundle.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement:** after `local-ai.json`, `if (src.photo) add('photo.json', json(await attempt(src.photo)));`. README: a line `- photo.json       maps from photos: this computer's processing check, and the latest runs of the open projects (steps, times, peak memory, tool versions; no photo names, folders or coordinates)` and the "What is never inside" sentence gains `photo file names or folders, coordinates`.
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(diagnostics): photo.json member in the bundle`.

### T3: Wire the photo source, end to end (size M)

**Files:**

- Modify: `apps/desktop/src/main/photogrammetry.ts` (`registerPhotogrammetryIpc` returns an object)
- Modify: `apps/desktop/src/main/index.ts` (late-bound `photo` source in `registerDiagnosticsIpc`)
- Test: `apps/desktop/src/main/photogrammetry.test.ts`, `apps/desktop/e2e/diagnostics.spec.ts`

**Interfaces:**

- Consumes: T1 `photoDiagnostics`, `PhotoRunIn`; T2 `BundleSources.photo`.
- Produces: `registerPhotogrammetryIpc(deps): { diagnostics(projectIds: Iterable<string>): Promise<PhotoDiagnostics> }`.

- [ ] **Step 1: Failing unit tests** in `photogrammetry.test.ts`, with the fake `projects` the file already uses: `diagnostics(['a', 'b'])` where `a` has two runs and `b` one returns the three newest, each with its `project`; a project whose `run.json` does not parse is skipped and the others are listed; a package project (`projects.package(id)` set) lists its run; a probe that throws gives `probe: null`; an unknown project id is skipped.
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/main/photogrammetry.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `registerPhotogrammetryIpc`: for each id, `runSource(projects, id)`, `src.runs()`, `readRunFile`; collect `{ project: id, run }`; probe through `currentProbe().catch(() => null)`; return `photoDiagnostics(probe, runs)`. Return `{ diagnostics }` from the register function. In `index.ts`, declare `let photoDiagnosticsOf: ((ids: Iterable<string>) => Promise<unknown>) | undefined;` before `registerDiagnosticsIpc`, add `photo: () => photoDiagnosticsOf?.(projectNames.keys()) ?? { probe: null, runs: [] }` to its `sources`, and set `photoDiagnosticsOf = registerPhotogrammetryIpc({...}).diagnostics;`.
- [ ] **Step 4: Run** the unit tests. Expected: PASS.
- [ ] **Step 5: E2E test** in `diagnostics.spec.ts`: `photo processing goes into photo.json without photo names or coordinates`, with the `photoProject` fixture (skip like the photo specs when the photo demo is not built). Open the photo demo project, export the bundle with the existing `stubSaveDialog` and `readZip`, then assert: `photo.json` parses; `runs` has the run `20260314-1000` (`PHOTO_DEMO.run`) with `versions.pack` and stages with `seconds`; `probe` is an object or `null`; no member of the zip contains `SYN_0` (the demo's photo names), the data root path, or the demo origin's easting and northing (read from the fixture manifest). Network guard stays empty.
- [ ] **Step 6: Run** it the CI way (Global constraints): `pnpm --filter @aio/desktop exec playwright test e2e/diagnostics.spec.ts --workers=1`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(diagnostics): latest photo runs and the hardware probe in the bundle`.

### T4: The wizard's remaining axe audits and a keyboard pass (size S)

**Files:**

- Modify: `apps/desktop/e2e/photo-process.spec.ts`
- Fix if needed: `apps/desktop/src/renderer/photogrammetry/**`

- [ ] **Step 1:** Add `await expectAccessible(win, 'create maps from photos, starting', { include: '[data-testid="photo-wizard"]' })` before `shot(win, 'create-maps-running')` (if the wizard has closed by then, audit `[data-testid="photo-run"]` and name it `photo run, starting`); `'create maps from photos, questions'` before `shot(win, 'create-maps-questions')`; `'create maps from photos, tools too old'` before `shot(win, 'create-maps-blocked')` in the old-pack test.
- [ ] **Step 2:** New test on the stand-in pipelines, `the wizard works from the keyboard alone`: open the photo site, focus the Processing chip and press Enter, Tab to **Create maps from photos** and press Enter; assert `photo-wizard` is visible and focus is inside it; Tab to **Options** and press Enter (or Space for a `<summary>`), Tab to **Quick** and press Space, assert `aria-pressed="true"`; Tab until `photo-start` is focused (at most 40 presses, fail with the focused element's text otherwise); press Escape: the wizard closes and the focused element is the **Create maps from photos** button (or the Processing chip if the drawer closed; assert whichever the app does today and write it in the test comment).
- [ ] **Step 3: Run** `pnpm --filter @aio/desktop exec playwright test e2e/photo-process.spec.ts --workers=1` the CI way. Expected: PASS. A violation or a focus trap is fixed in the renderer component, not added to `AXE_ALLOW`; re-run.
- [ ] **Step 4: Commit** `test(photo): axe on every wizard state and a keyboard-only pass`.

### T5: Tile cache stats and a budget scale hook (size S)

**Files:**

- Modify: `packages/tiles/src/adapter.ts` (`TilesLike`, `TilesetHandle`), test `packages/tiles/src/adapter.test.ts`
- Modify: `apps/desktop/src/renderer/workspace/siteTiles.ts`
- Modify: `apps/desktop/src/renderer/bootstrap.ts` (`__stratlas.tiles`)

**Interfaces:**

- Produces:

```ts
// @aio/tiles
export interface TilesetStats { cachedBytes: number; maxBytes: number; errorTarget: number; loadProgress: number }
// TilesetHandle gains:
stats(): TilesetStats;
// renderer, siteTiles.ts
export function tilesDebug(): { stats(): TilesetStats[]; setBudgetScale(scale: number): void; budgetScale(): number };
// window.__stratlas.tiles = tilesDebug()
```

- [ ] **Step 1: Failing tests** in `adapter.test.ts` with the fake `TilesLike` there: `stats()` reports `lruCache.cachedBytes` (add `cachedBytes?: number` to the fake's `lruCache`; 0 when absent), `maxBytes`, `errorTarget`, `loadProgress`; after `setBudget({ ...medium, maxBytes: 10 })`, `stats().maxBytes` is 10.
- [ ] **Step 2: Run** `pnpm --filter @aio/tiles exec vitest run`. Expected: FAIL.
- [ ] **Step 3: Implement** `stats()`; check the field name of the cache's byte count in the vendored 3DTilesRendererJS (`node_modules/3d-tiles-renderer`, `LRUCache`: `cachedBytes`) and add it to `TilesLike.lruCache` as optional.
- [ ] **Step 4:** In `siteTiles.ts`, a module-level `let budgetScale = 1`; every `tilesBudget(tier)` passed to a handle goes through `scaled(b) = budgetScale === 1 ? b : { ...b, maxBytes: Math.max(1, Math.round(b.maxBytes * budgetScale)) }`; `setBudgetScale(s)` (clamped to (0, 1]) re-applies the budget to the live handles; `stats()` maps the live handles. Unit test in a new `siteTiles.debug.test.ts` if `siteTiles.ts` can be imported without a stage; otherwise covered by T6 (write which one in the commit message). Review focus 5: `setBudgetScale(1)` gives back exactly `tilesBudget(tier)`.
- [ ] **Step 5:** `bootstrap.ts`: `tiles: tilesDebug()` in `__stratlas` with a one-line comment (performance tests).
- [ ] **Step 6: Run** `pnpm --filter @aio/tiles exec vitest run` and `pnpm --filter @aio/desktop exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(tiles): cache stats and a test budget scale for the performance tests`.

### T6: The CI-sized proxy, `perf-m10.spec.ts` (size M to L)

**Files:**

- Create: `apps/desktop/e2e/quadtreeTileset.ts`, `apps/desktop/e2e/perf-m10.spec.ts`
- Modify: `tools/ci/e2e-timings.json` (one entry, after the first CI run)

**Interfaces:**

- Consumes: T5 `__stratlas.tiles`; existing `__stratlas.graphics` (tier `override`), `__stratlas.pointcloud`; `createGlobeLibrary`, `enuTileset` pattern, `rasterPmtiles` from `m10Fixtures.ts`; `gridGlb`; `SOFTWARE_GPU`, `launchApp`, `NetworkGuard` from `fixtures.ts`; the `Flight` sampling in `perf.spec.ts` (copy the small sampler, do not import from a spec).
- Produces: `export async function writeQuadtreeTileset(dir: string, o: { depth: number; glb: Buffer; halfM: number }): Promise<{ tiles: number; bytes: number; triangles: number }>` (T7 reuses it with a bigger depth).

- [ ] **Step 1:** `quadtreeTileset.ts`: a 3D Tiles 1.1 `tileset.json` with an explicit quadtree of `depth` levels (depth 4: 1 + 4 + 16 + 64 = 85 tiles), each tile a copy of `glb` scaled into its quadrant through the tile `transform`, `geometricError` halving per level, `refine: 'REPLACE'`; files written as `t/<level>/<x>_<y>.glb`. Return counts (triangles = tiles x 12,800 for `gridGlb`).
- [ ] **Step 2:** A cheap check without the app: a `base` test in `perf-m10.spec.ts` that writes the tileset to a temp folder and asserts 85 tiles, about 1.1 M triangles and that `TilesetsFile`/the tileset JSON parse.
- [ ] **Step 3: Tiles test** (`serial`, launched with `SOFTWARE_GPU`, one app for the file): write the tiny project, the quadtree into `tiles/perf-quad/` and its `tilesets.json` entry before launch; open the project; set `__stratlas.graphics().getState()` override to `medium` (use the store's own setter); `__stratlas.tiles.setBudgetScale(0.01)`; fly a recorded camera path over the tileset (new `e2e/perf/tiles-quad.path.json`, six keys, 8 s); sample every frame: `stats()[0].cachedBytes <= maxBytes * 1.05` (the cache trims after load, allow one tile over), `errorTarget === 12`; at the end `loadProgress === 1`; frame p95 under `QUADRION_PERF_M10_P95_MS` (default 400). Attach the numbers as JSON like `perf.spec.ts`.
- [ ] **Step 4: Points test:** same app, the tiny project's 16,000 point COPC; set the point cap through `__stratlas.pointcloud` to 4,000; fly the synthetic path; drawn points (the sampler's `maxPoints`) never above 4,000.
- [ ] **Step 5: Globe test:** a new data root with `createGlobeLibrary` (five placed sites, two region packs), Medium override, open the Globe, fly over sites A, B and C (new `e2e/perf/globe.path.json` through the Globe's camera hook used by `globe.spec.ts`), frame p95 under `QUADRION_PERF_GLOBE_P95_MS` (default 400); `network.outbound()` is empty.
- [ ] **Step 6: Set the ceilings.** Run the spec the CI way three times locally (`--workers=1`) and note the p95 values. This branch never pushes, so the CI numbers come from the draft pull request of whoever merges it: ask in the hand-off for three CI runs of the e2e shard holding this spec, then write the measured p95 values and the run ids into the spec's header comment and set both defaults to twice the median CI p95 (never below the worst measured). Until those numbers exist, keep 400 ms.
- [ ] **Step 7:** `node tools/ci/e2e-shards.mjs --shard 1/6` still lists every spec once (its test does this: `pnpm exec vitest run tools/ci`).
- [ ] **Step 8: Commit** `test(perf): CI-sized M10 proxy for tile, point and Globe budgets`.

### T7: The opt-in local benchmark (size M)

**Files:**

- Create: `tools/bench/m10-bench-data.mjs`, `tools/bench/m10-bench-data.test.mjs`, `apps/desktop/e2e/perf-m10-bench.spec.ts`
- Modify: `apps/desktop/e2e/gridGlb.ts` (an optional size)

**Interfaces:**

- Consumes: T6 `writeQuadtreeTileset`; `tools/pointcloud/synthetic-cloud.mjs` (its generator, extended to write chunks), `tools/pointcloud/merge-copc.mjs`; PDAL from `AIO_PDAL` or `E:\Dev\tools\pdal` (as `tools/pointcloud/README.md`).
- Produces: `node tools/bench/m10-bench-data.mjs --out <dir> [--points 100e6] [--triangles 20e6]` writing `<dir>/mesh/tileset.json` and `<dir>/cloud.copc.laz`, skipping what is already there with the same size parameters (a `bench.json` stamp).

- [ ] **Step 1: Failing test** `m10-bench-data.test.mjs` (Vitest, `tools/vitest.config.ts`). The triangle target counts the leaves (what is drawn fully refined, `REPLACE`): `planBench({ points: 100e6, triangles: 20e6 })` gives depth 6 (1,024 leaves, 1,365 tiles) and 100 quads per tile side (20,000 triangles a tile, 20.48 M on the leaves), so assert `leaves * 2 * quads ** 2 >= 20e6` and `tiles <= 1365`; point chunks of at most 10 M (10 for 100 M); `--points 500e6` gives 50 chunks.
- Modify `apps/desktop/e2e/gridGlb.ts`: `gridGlb(quads = 80)` (the default keeps every existing spec's mesh byte for byte: re-run `e2e/tilesets.spec.ts` and the base test of `e2e/perf-m10.spec.ts` after the change).
- [ ] **Step 2: Run** `pnpm exec vitest run tools/bench`. Expected: FAIL. **Step 3:** implement `planBench` and the writer (the writer is not run in tests: no PDAL in CI). **Step 4:** PASS.
- [ ] **Step 5:** `perf-m10-bench.spec.ts`: `test.skip(process.env.QUADRION_BENCH !== '1', 'opt-in benchmark: QUADRION_BENCH=1 and a window from the founder')`, `test.skip(process.env.QUADRION_E2E_SWGL === '1', 'needs the hardware GPU')`; data root from `QUADRION_BENCH_ROOT`; titles carry `@bench`. Site view: the 20 M triangle tileset and the COPC as layers of a bench project, tier as detected unless `QUADRION_BENCH_TIER=medium`, real budgets (no scale): cache under 384 MB, points drawn under 4 M, p95 at or under 33.3 ms. Globe: `createGlobeLibrary` plus the bench tileset at site A, p95 at or under 33.3 ms. Write `bench-report.json` (frames, p50, p95, p99, worst, fps, tier, GPU renderer, cache peak, points peak) into `QUADRION_BENCH_ROOT`.
- [ ] **Step 6:** Check it skips: `pnpm --filter @aio/desktop exec playwright test e2e/perf-m10-bench.spec.ts --workers=1` reports skipped. Do not generate or run the data on this branch.
- [ ] **Step 7: Commit** `test(perf): opt-in M10 benchmark on real hardware`.

### T8: ROADMAP, the M10 row (size XS)

**Files:** Modify `docs/plans/ROADMAP.md` (M10 row only).

- [ ] **Step 1:** Plan cell: `[2026-10-07-m10-globe-and-photogrammetry.md](2026-10-07-m10-globe-and-photogrammetry.md)`; status cell: `Built in 0.10.0 to 0.11.x; hardening in [2026-10-12-m10-hardening-and-docs.md](2026-10-12-m10-hardening-and-docs.md); exit waits on the founder's smoke tests, the Stage M10 tick-off and the size budget sign-off`. Keep the scope cell; do not add a macOS claim.
- [ ] **Step 2:** `pnpm exec prettier --write docs/plans/ROADMAP.md`, `node tools/agent/check-public-text.mjs docs/plans/ROADMAP.md`.
- [ ] **Step 3: Commit** `docs(roadmap): M10 built, exit items left`.

### T9: SECURITY-AND-DATA, the Globe (size S)

**Files:** Modify `docs/release/SECURITY-AND-DATA.md`.

- [ ] **Step 1: Check the code first:** `apps/desktop/src/renderer/globe/request.ts` and `GlobeScreen.tsx` (what the Globe fetches, from where), `apps/desktop/src/main/packs/**` and `packages/maps/src/packs.ts` (how imagery and terrain packs arrive: download, import from file, or both), `apps/desktop/src/main/index.ts` CSP (`connect-src`). Write down each finding in the commit body.
- [ ] **Step 2: Write:** after the table, a paragraph: the Globe draws the imagery bundled with the app and the installed imagery and terrain packs, and sends no request of its own; the only exception is online satellite imagery (the row above), off by default and never on an offline-only workstation. In the "Map download" row (or a new row if packs come another way), name imagery and terrain packs: they arrive only when a person downloads or imports one. Match the code; if anything contradicts the spec's sentence, write what the code does and say so in the hand-off.
- [ ] **Step 3:** prettier, check-public-text. **Step 4: Commit** `docs(security): the Globe makes no requests; packs arrive on a person's action`.

### T10: PRD, PHO and GLB lines (size S)

**Files:** Modify `docs/PRD.md` (section 3 non-goals: check only; section 9.1 table).

- [ ] **Step 1:** Read Stage M10 of `docs/TESTING.md` and the wizard (`apps/desktop/src/renderer/photogrammetry/`) for the shipped words.
- [ ] **Step 2:** PHO-1: "from **Create maps from photos** in the Processing drawer: one screen with the photos, the time on this computer and the disk and memory it needs; under Options the CRS, a quality preset (Quick, Standard, High), the products and the hardware check". GLB-1: "offline, with no account or token, and no request unless online satellite imagery is switched on". Every other line: change only words that contradict what shipped (list each change in the commit body). Non-goal: confirm the 7 Oct change is there; no edit if so. Do not remove macOS words (parked, not dropped).
- [ ] **Step 3:** prettier, check-public-text. **Step 4: Commit** `docs(prd): PHO and GLB lines match what shipped`.

### T11: M10 plan follow-ups and TESTING steps (size S)

**Files:** Modify `docs/plans/2026-10-07-m10-globe-and-photogrammetry.md` ("Integration follow-ups"), `docs/TESTING.md` (Stage M10).

- [ ] **Step 1:** Under the D7, D6 and D5 bullets, one dated line each: `Done 12 Oct 2026 in 2026-10-12-m10-hardening-and-docs.md:` D5 `photo.json`; D6 the three audits and the keyboard pass (the GCP and Globe audits were there); D7 the CI proxy `e2e/perf-m10.spec.ts` with its ceilings and the opt-in benchmark `e2e/perf-m10-bench.spec.ts`. Docs bullets: ROADMAP, PRD and SECURITY-AND-DATA done; the others still open.
- [ ] **Step 2:** TESTING.md Stage M10, two steps: "**Settings**, **About and updates**, **Export diagnostics** with the photo demo open: the zip has `photo.json` with run `20260314-1000`, its steps and times and the tool versions, and no photo name (`SYN_…`), folder or coordinate." and "(optional, in a window when the PC is free) the benchmark: `node tools/bench/m10-bench-data.mjs --out <folder>`, then `QUADRION_BENCH=1 QUADRION_BENCH_ROOT=<folder> pnpm --filter @aio/desktop exec playwright test e2e/perf-m10-bench.spec.ts --workers=1`; `bench-report.json` shows 30 fps or more and the Medium caps held." Check the exact menu words against the app before writing.
- [ ] **Step 3:** prettier, check-public-text. **Step 4: Commit** `docs(m10): follow-ups D5 to D7 done, test steps for diagnostics and the benchmark`.

### T12: Verify and hand off (size M)

- [ ] **Step 1:** `pnpm check` green in the worktree.
- [ ] **Step 2:** Build the demos (`pnpm demo:change --quick`, the photo demo through `demo:build` with `--python` pointing at the main checkout's venv), then run the changed and added specs the CI way, one run at a time: `diagnostics.spec.ts`, `photo-process.spec.ts`, `perf-m10.spec.ts`, `perf-m10-bench.spec.ts` (skips). Paste the summary lines into the hand-off.
- [ ] **Step 3:** An independent review of the branch (a fresh reviewer: D5's allow-list against the leak list, T5's hook default, T6's ceilings).
- [ ] **Step 4:** `node tools/agent/finish-task.mjs` and send the hand-off (branch, head SHA, summary, check and e2e status, "no contract change", "T6 ceilings need three CI runs to settle" if not yet done) to whoever merges (no Orchestrator since 12 Oct: check with the other sessions before a self-merge).

## How to test (founder)

1. Open **Photo processing demo**, then **Settings**, **About and updates**, **Export diagnostics**, save the zip. Open it: there is a `photo.json`. It lists your computer's processor, memory, free disk and graphics card, and run `20260314-1000` with its steps, times and the tool versions. Search the whole zip for `SYN_` and for the site's coordinates: nothing.
2. With processing tools 0.4.0 or later, open **Processing**, **Create maps from photos** using only the keyboard: Tab to it, Enter, Tab to **Options**, Enter, choose **Quick** with Space, Tab to **Create maps**. Escape closes the dialog and the focus is back where you started.
3. Nothing else changes on screen. The performance checks run in CI; the optional benchmark (TESTING.md, Stage M10) needs a window when the PC is free.
4. Read the M10 row of `docs/plans/ROADMAP.md`, the Globe paragraph in `docs/release/SECURITY-AND-DATA.md` and PHO-1 and GLB-1 in `docs/PRD.md`: they say what the app does today.

## Founder-only M10 exit items

- [ ] Smoke tests on your machine with Wi-Fi off: the photo demo end to end on CPU (checkpoint RMSE within targets); your nadir flight with GCPs on Standard, with an accuracy report you accept; the oblique flight (mesh); outputs in the existing viewers and on the Globe; OPF round trip with another reader; the Globe offline with every library project, attributions and the hand-over to the site view; the zero-network suite.
- [ ] Stage M10 of `docs/TESTING.md` ticked off, every PHO and GLB line seen.
- [ ] Size budget sign-off: the pipeline pack and installer sizes against decision 6, or a recorded change to the budgets.
- [ ] A window for the benchmark (T7), and whether to run the 500 M point data.
- [ ] Confirm or change the decisions in the spec.

## Task count and size

Twelve tasks: one XS (T8), seven S (T1, T2, T4, T5, T9, T10, T11), three M (T3, T7, T12) and one M to L (T6). About two working days for one agent; with Batch A dispatched in parallel, about one, plus the time T6 waits for CI runs to set its ceilings.
