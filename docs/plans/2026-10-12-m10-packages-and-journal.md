# M10 follow-ups: packages (X1) and journal — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** packages carry a processed project's run records, reports and tiles but never `photogrammetry/<run>/work/`, carry imagery and terrain packs only when ticked, the player shows the Globe at the package's site with them, and History records M10 file writes (tilesets, ground control, runs) with jobs as `via.pipeline`.

**Architecture:** a pure allow-list rule in `planPackage`; raster packs clipped to the site with the existing PMTiles extract and listed and served from open packages the way street packs already are; the journal follows three more files as `record.external` and wraps the two M10 writers like `orientation:write`.

**Tech stack:** TypeScript, zod (`@aio/schema`), Electron main and React renderer, vitest, Playwright e2e.

**Spec:** `docs/plans/2026-10-12-m10-packages-and-journal-design.md` (read its "What exists" and "Decisions taken" first).

**Worktree:** `E:\Dev\AIO Software\.claude\worktrees\m10-packages-and-journal`, branch `feat/m10-packages-and-journal`.

## Global constraints

- Packages stay read-only; player mode never starts processing.
- Customer-licensed packs never travel unless ticked; nothing is ticked by default.
- No new journal op kinds: M10 files are `record.external` (hash-only) with an optional label.
- Every user-facing string goes through the i18n catalogue (`packages/ui` messages, as `package.export.*` and `globe.*` do today); plain words, no jargon, no client, site or person names.
- Electron windows in tests stay off-screen (e2e fixtures do this); e2e runs with `--workers=1`, one Playwright run at a time.
- Stage by path; never `git add -A`; never `git stash`; conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review focus

1. A layer whose file sits inside a run folder (for example a raster pointing at `photogrammetry/<run>/ortho.tif`): the layer's file must still travel. Test in Task 1.
2. A run folder with `gcp.json.bak` and `report/` sub-folders: `.bak` stays out (existing `SKIP`), every `report/**` file travels. Test in Task 1.
3. An export request naming a pack that was removed between plan and export, or one that does not cover the site: refused in words, no partial `.aio` left. Test in Task 3.
4. A package raster pack with the same id as an installed pack: the installed one is used, the package one is not listed (no duplicate menu row). Test in Task 3.
5. The journal switched off for a private project: the wrapped `tilesets:write` and `photo:writeGcp` still save and append nothing. Test in Task 6.

## Contract change

Additive, `@aio/schema` (`ipc.ts`, `package.ts`). Row for `docs/architecture/contract-changes.md` (added in Task 2):

| Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Why                                                                                                                              | Streams affected        | Approved by            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------- |
| 2026-10-12 | Additive, packages carry imagery and terrain packs (M10 X1, decision 12): new `RasterPackRef` (`{ kind: 'imagery' \| 'terrain', id }`); `package:plan` request and `PackageExportOptions` gain optional `rasterPacks: RasterPackRef[]`; `PackagePlan` gains optional `rasterPacks: PackageRasterPlan[]` (`kind`, `id`, `label`, `licence`, `attribution`, `customerLicence`, then `ok: true` with `bytes`, `tiles`, `maxZoom`, or `ok: false` with `reason`); new constant `EMBEDDED_RASTER_DIRS` (`packs/imagery`, `packs/terrain`): a package member `packs/<kind>/<id>.pmtiles` with `<id>.json` (`RasterPackMeta`) is a raster pack clipped to the site. Package layout: run folders travel as `run.json`, `gcp.json` and `report/` only (data-conventions sections 21 and 23). | Customer imagery travels only when ticked; the player shows the package's imagery on the Globe; no COLMAP work files in packages | packages, Globe, player | Pending founder review |

No journal contract change (decision 4 of the spec).

## Package ownership

| Task | Packages and files                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1   | `packages/project` (`src/package/plan.ts`, `plan.test.ts`)                                                                                                                                             |
| T2   | `packages/schema` (`src/ipc.ts`, `src/package.ts`, `src/package.test.ts`), `docs/architecture/contract-changes.md`                                                                                     |
| T3   | `apps/desktop` main (`src/main/packs/rasterEmbed.ts` new, `rasterEmbed.test.ts` new)                                                                                                                   |
| T4   | `apps/desktop` main (`src/main/packages.ts`, `packages.test.ts`, `src/main/globe.ts`, `globe.test.ts`, `src/main/protocol/handler.ts`, its test, `src/main/index.ts`)                                  |
| T5   | `apps/desktop` renderer (`src/renderer/shell/PackageExport.tsx`, its test), `packages/ui` messages (`package.export.raster*` keys)                                                                     |
| T6   | `packages/journal` (`src/diff.ts`, `diff.test.ts`), `apps/desktop` main (`src/main/journal.ts`, `journal.test.ts`)                                                                                     |
| T7   | `apps/desktop` renderer (`src/renderer/globe/GlobeScreen.tsx`, `GlobeScreen.test.tsx`, `src/renderer/processingTools.ts`, its test)                                                                    |
| T8   | `apps/desktop/e2e` (`packages-globe.spec.ts` new, `tilesets.spec.ts`), docs (`docs/KNOWN-LIMITS.md`, `docs/architecture/data-conventions.md`, `docs/plans/2026-10-07-m10-globe-and-photogrammetry.md`) |

## Execution DAG

```
T1 ──────────────────────────────┐
T2 ──┬── T3 ── T4 ───────────────┤
     └── T5 ─────────────────────┼── T8
T6 ──────────────────────────────┤
T7 ──────────────────────────────┘
```

- **Batch A (parallel, one message):** T1, T2, T6, T7. No shared files (T1 `packages/project`, T2 `packages/schema`, T6 `packages/journal` + `main/journal.ts`, T7 renderer globe and `processingTools.ts`).
- **Batch B (parallel):** T3, T5 (after T2). T3 is main `packs/rasterEmbed.ts` only; T5 renderer `PackageExport.tsx` and `packages/ui` messages only.
- **Batch C:** T4 (after T3).
- **Batch D:** T8 (after all): e2e specs and docs.
- **Critical path:** T2 → T3 → T4 → T8.

Sizes: T1 S, T2 S, T3 M, T4 M, T5 M, T6 M, T7 S, T8 M. Eight tasks, about two days of agent time.

---

### Task 1: Run folders travel by allow-list (packages/project)

**Files:** modify `packages/project/src/package/plan.ts`; test `packages/project/src/package/plan.test.ts`.

**Interfaces:** produces `export function runFileTravels(path: string): boolean` (exported for tests and docs).

- [ ] **Step 1: failing tests** in `plan.test.ts`:

```ts
describe('photogrammetry run folders', () => {
  const run = 'photogrammetry/20261007-0915';
  const files: SourceFile[] = [
    'run.json',
    'gcp.json',
    'gcp.json.bak',
    'report/accuracy.json',
    'report/align.json',
    'report/products.json',
    'cameras-sfm.json',
    'sparse/cameras.txt',
    'sparse/frame.json',
    'mesh/full.glb',
    'ortho.tif',
    'dsm.tif',
    'work/database.db',
    'work/products/ab12/depth/1.bin',
  ].map((p) => ({ path: `${run}/${p}`, size: 10 }));
  const extra: SourceFile[] = [
    { path: 'tilesets.json', size: 5 },
    { path: 'tiles/20261007-0915-mesh/tileset.json', size: 5 },
  ];

  it('carries run.json, gcp.json, report/ and tiles, never work/', () => {
    const p = planPackage(manifest(), [...files, ...extra], []);
    expect(
      p.members
        .map((m) => m.path)
        .filter((x) => x.startsWith('photogrammetry/') || x.startsWith('tile'))
        .sort(),
    ).toEqual([
      `${run}/gcp.json`,
      `${run}/report/accuracy.json`,
      `${run}/report/align.json`,
      `${run}/report/products.json`,
      `${run}/run.json`,
      'tiles/20261007-0915-mesh/tileset.json',
      'tilesets.json',
    ]);
  });

  it('does not count left-out run files in baseBytes', () => {
    const p = planPackage(manifest(), files, []);
    expect(p.baseBytes).toBe(5 * 10);
  });

  it('keeps a file a layer owns even inside a run folder', () => {
    const m = manifest();
    m.layers.push({
      kind: 'raster',
      id: 'o',
      name: 'Ortho',
      src: { path: `${run}/ortho.tif` },
      format: 'cog',
    } as never);
    const p = planPackage(m, files, []);
    expect(p.members.some((x) => x.path === `${run}/ortho.tif`)).toBe(true);
  });

  it('runFileTravels', () => {
    expect(runFileTravels(`${run}/report/x/y.json`)).toBe(true);
    expect(runFileTravels(`${run}/work/database.db`)).toBe(false);
    expect(runFileTravels('photogrammetry/readme.txt')).toBe(true); // not a run folder file
    expect(runFileTravels('models/a.glb')).toBe(true);
  });
});
```

Use a raster `format` value the schema accepts (check `RasterLayer` in `packages/schema`; `cog` or `image`).

- [ ] **Step 2:** `pnpm --filter @aio/project test -- plan` fails (`runFileTravels` not exported, work files present).
- [ ] **Step 3: implement** in `plan.ts`:

```ts
/** Inside a run folder only its records and reports travel (data-conventions section 21). */
const RUN_FILE = /^photogrammetry\/[^/]+\/(.+)$/;
const RUN_KEEP = /^(run\.json|gcp\.json|report\/.+)$/;
export function runFileTravels(path: string): boolean {
  const m = RUN_FILE.exec(path);
  return !m?.[1] || RUN_KEEP.test(m[1]);
}
```

In the `planPackage` loop, after `const owners = ownersOf(path);`: `if (owners.length === 0 && !runFileTravels(path)) continue;` (before `baseBytes` is added). Update the doc comment of `planPackage` ("`photogrammetry/<run>/` sends only its records and reports").

- [ ] **Step 4:** tests pass; `pnpm --filter @aio/project typecheck`.
- [ ] **Step 5: commit** `feat(project): packages carry a run's records and reports, never its work files`.

### Task 2: Raster packs in the package contract (packages/schema)

**Files:** modify `packages/schema/src/ipc.ts` (near `PackageMapPackRequest` ~456, `PackagePlan` ~438, `package:plan` ~997), `packages/schema/src/package.ts` (beside `EMBEDDED_PACKS_DIR`); test `packages/schema/src/package.test.ts`; add the row above to `docs/architecture/contract-changes.md`.

**Interfaces:** produces

```ts
// package.ts
export const EMBEDDED_RASTER_DIRS = { imagery: 'packs/imagery', terrain: 'packs/terrain' } as const;
// ipc.ts
export const RasterPackRef = z
  .object({ kind: z.enum(['imagery', 'terrain']), id: RasterPackId })
  .strict();
export const PackageRasterPlan = z.intersection(
  z.object({
    kind: z.enum(['imagery', 'terrain']),
    id: RasterPackId,
    label: z.string(),
    licence: z.string(),
    attribution: z.string(),
    customerLicence: z.boolean(),
  }),
  z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      bytes: z.number().int().nonnegative(),
      tiles: z.number().int().nonnegative(),
      maxZoom: z.number().int(),
    }),
    z.object({ ok: z.literal(false), reason: z.string() }),
  ]),
);
export type RasterPackRef = z.infer<typeof RasterPackRef>;
export type PackageRasterPlan = z.infer<typeof PackageRasterPlan>;
```

`PackagePlan` gains `rasterPacks: z.array(PackageRasterPlan).optional()`; the `package:plan` request and `PackageExportOptions` gain `rasterPacks: z.array(RasterPackRef).max(32).optional()`. Import `RasterPackId` from `globe.ts` (already exported).

- [ ] **Step 1: failing tests** in `package.test.ts`: `PackageExportOptions` parses with `rasterPacks: [{ kind: 'imagery', id: 'site-imagery' }]`; rejects `{ kind: 'street', id: 'x' }` and an id with `/`; `PackagePlan` parses a plan with one ok and one refused raster entry; `EMBEDDED_RASTER_DIRS.imagery === 'packs/imagery'`; an old request without `rasterPacks` still parses.
- [ ] **Step 2:** `pnpm --filter @aio/schema test -- package` fails.
- [ ] **Step 3:** implement as above; export from the schema index.
- [ ] **Step 4:** tests pass; `pnpm --filter @aio/schema typecheck`; `pnpm typecheck` at the root still green (additive).
- [ ] **Step 5: commit** `feat(schema): packages may carry ticked imagery and terrain packs` (with the contract row).

### Task 3: Clip, list and find raster packs in packages (apps/desktop main)

**Files:** create `apps/desktop/src/main/packs/rasterEmbed.ts`, `rasterEmbed.test.ts`.

**Interfaces:** consumes `projectBbox` (`./embed`), `planExtract`, `runExtract`, `fileSource` (`./extract`), `listRasterPacks`, `rasterPackDir` (`./raster`), `EMBEDDED_RASTER_DIRS`, `RasterPackRef`, `PackageRasterPlan`, `RasterPackMeta`, `RasterPackInfo` (schema). Produces:

```ts
export const PACKAGE_RASTER_PREFIX = 'pkg-';
export interface RasterEmbedPlan {
  pack: RasterPackInfo;
  file: string;
  bbox: Bbox;
  maxZoom: number;
  plan: ExtractPlan;
  head: Buffer;
}
export async function planRasterEmbeds(o: {
  manifest: ProjectManifest;
  packs: { imagery: RasterPackInfo[]; terrain: RasterPackInfo[] };
  dataRoot: string;
  marginKm: number;
}): Promise<{ plans: Map<string, RasterEmbedPlan>; summary: PackageRasterPlan[] }>; // key `${kind}/${id}`
export function chooseRasterEmbeds(
  requested: readonly RasterPackRef[],
  planned: Awaited<ReturnType<typeof planRasterEmbeds>>,
): { ok: true; value: RasterEmbedPlan[] } | { ok: false; reason: string };
export async function writeRasterEmbeds(
  plans: readonly RasterEmbedPlan[],
  o: { tempDir: string; signal?: AbortSignal },
): Promise<{ members: ZipMember[]; bytes: number; dispose(): Promise<void> }>;
export async function packageRasterPacks(
  archive: Pick<ZipArchive, 'entries' | 'read'>,
  kind: RasterPackKind,
): Promise<{ meta: RasterPackMeta; id: string; member: string }[]>;
export async function embeddedRasterPacks(
  installed: readonly RasterPackInfo[],
  packages: Iterable<readonly [string, { archive: ZipArchive }]>,
  kind: RasterPackKind,
): Promise<RasterPackInfo[]>; // ids `pkg-<projectId>-<id>`, source 'package'
export function findEmbeddedRaster(
  kind: RasterPackKind,
  id: string,
  packages: Iterable<readonly [string, { archive: ZipArchive }]>,
): { archive: ZipArchive; member: string } | undefined;
```

Rules: a pack is offered when its `bbox` intersects the site box; the clip uses the pack's own `maxZoom`; the written `<id>.json` is the installed pack's `RasterPackMeta` with `bbox` replaced by the clipped box, `source: 'package'` and `sizeBytes` the clip's size, licence, attribution and `customerLicence` unchanged. An installed pack with the same id, or covering the package pack's box at its zoom or deeper, hides the package one (as `embeddedPacks` does). Follow `embed.ts` for temp folders and `dispose`.

- [ ] **Step 1: failing tests** (`rasterEmbed.test.ts`), using the synthetic pack builders in `apps/desktop/e2e/m10Fixtures.ts` (`imageryPack`, `terrainPack`, `rasterPmtiles`; import them, or copy the smallest helper into a `testing` helper if the e2e module pulls in Playwright):
  - a project in EPSG 32633 with one imagery pack covering it and one far away: summary lists only the covering one, `ok: true`, `bytes > 0`, `customerLicence` copied;
  - a project with an unknown CRS: summary entries are `ok: false` with the "no map position" reason;
  - `chooseRasterEmbeds` with a ref that is not in the plan returns `ok: false` naming the id ("The imagery pack "x" is not installed or does not cover this site.");
  - `writeRasterEmbeds` writes `packs/imagery/<id>.pmtiles` and `packs/imagery/<id>.json`; the JSON parses as `RasterPackMeta`, its bbox is inside the site box plus margin, and `dispose` removes the temp folder; an aborted signal rejects with `AbortError` and leaves no temp folder;
  - `packageRasterPacks` on an in-memory archive ignores a `packs/imagery/bad.json` that is not valid `RasterPackMeta` and a `.json` without its `.pmtiles`;
  - `embeddedRasterPacks` hides a package pack whose id is installed (Review focus 4) and returns others as `pkg-<projectId>-<id>` with `source: 'package'`;
  - `findEmbeddedRaster('imagery', 'pkg-p1-site', packages)` returns the member; an unknown id returns undefined.
- [ ] **Step 2:** `pnpm --filter @aio/desktop test -- rasterEmbed` fails.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** tests pass; desktop typecheck.
- [ ] **Step 5: commit** `feat(desktop): clip imagery and terrain packs into packages and read them back`.

### Task 4: Wire raster packs and package sites into packaging, the Globe and the protocol (apps/desktop main)

**Files:** modify `apps/desktop/src/main/packages.ts`, `packages.test.ts`, `src/main/globe.ts`, `globe.test.ts`, `src/main/protocol/handler.ts`, its test, `src/main/index.ts` (deps only).

**Interfaces:** consumes Task 3. `PackageJobDeps` gains `rasterPacks?: { list(kind: RasterPackKind): Promise<RasterPackInfo[]>; dataRoot(): string }`. `GlobeIpcDeps` gains `packageRasterPacks?: (kind: RasterPackKind) => Promise<RasterPackInfo[]>`. Protocol roots gain `embeddedRaster?: (kind: RasterPackKind, id: string) => { archive: ZipArchive; member: string } | undefined`.

- [ ] **Step 1: failing tests**
  - `packages.test.ts`: `plan` with a covering imagery pack returns `plan.rasterPacks` with it; `totalBytes` grows by its bytes only when `rasterPacks` names it; `export` with a ticked pack writes a `.aio` whose entries include `packs/imagery/<id>.pmtiles` and `.json`; `export` naming a removed pack answers `ok: false` with the pack's id and leaves no file at the target (Review focus 3).
  - `globe.test.ts`: `globe:packs` returns installed packs then `packageRasterPacks` ones; `globeProjectReader` for an open package returns the package's `issues.json` issues and `tilesets.json` (build the archive with the zip writer as existing tests do), and `null` tilesets when the member is missing or invalid.
  - protocol test: `aio://packs/imagery/pkg-p1-site.pmtiles` is served from the package member with Range support; an installed `aio://packs/imagery/site.pmtiles` still comes from disk; an unknown `pkg-` id is 404.
- [ ] **Step 2:** run, see failures.
- [ ] **Step 3: implement**
  - `packages.ts` `plan`: when `deps.rasterPacks`, call `planRasterEmbeds` (margin `mapPack?.marginKm ?? 1`) and add `summary` as `plan.rasterPacks`; add requested `ok` bytes to `totalBytes` and 2 files each. `export`: `chooseRasterEmbeds(options.rasterPacks ?? [], ...)`; on `ok: false` throw `new Error(reason)` before any write; `writeRasterEmbeds`; append its members to `extra` (after the street embed); `dispose` in `finally`.
  - `globe.ts`: `globe:packs` concatenates `packageRasterPacks(kind)` after the installed list. `globeProjectReader`: for an open package read `issues.json` (parse with the same parser `readIssues` uses; on failure `[]`) and `tilesets.json` (`TilesetsFile.safeParse`; on failure `null`) from `pkg.archive`.
  - `handler.ts` `packs` host: before `rasterPackFile`, when `segments[0]` is `imagery` or `terrain` and the file name starts with `pkg-`, serve `roots.embeddedRaster(kind, id)` with `serveMember`, else 404.
  - `index.ts`: pass `rasterPacks` to `createPackageJobs` (`listRasterPacks(dataRoot, kind)`), `packageRasterPacks` to `registerGlobeIpc` (`embeddedRasterPacks(installed, registry.packages(), kind)`; use whatever iterator `embeddedPacks` is given today) and `embeddedRaster` to the protocol roots (`findEmbeddedRaster`).
- [ ] **Step 4:** tests pass; `pnpm --filter @aio/desktop typecheck`.
- [ ] **Step 5: commit** `feat(desktop): packages carry ticked raster packs and the player's Globe uses them`.

### Task 5: Imagery and terrain in the export dialog (apps/desktop renderer)

**Files:** modify `apps/desktop/src/renderer/shell/PackageExport.tsx` and its test (create `PackageExport.test.tsx` if none); add message keys in `packages/ui` (the catalogue holding `package.export.mapPack`).

**Interfaces:** consumes `PackagePlan.rasterPacks`, `RasterPackRef` (Task 2). State: `const [rasters, setRasters] = useState<Set<string>>(new Set())` keyed `${kind}/${id}`; included in the `package:plan` request (and in `excludeKey`, so the plan refreshes) and in the export options as `rasterPacks`.

Messages (English):

- `package.export.rasterTitle`: "Imagery and terrain"
- `package.export.rasterHelp`: "Send a piece of an installed pack, cut to this site, so the Globe shows it on the recipient's computer."
- `package.export.rasterNone`: "No installed imagery or terrain pack covers this site."
- `package.export.rasterSize`: "{size}, up to zoom {zoom}"
- `package.export.rasterCustomer`: "Licensed to you by the provider ({licence}). Send it only if the licence allows this recipient to see it."
- `package.export.rasterKind.imagery`: "Imagery"; `package.export.rasterKind.terrain`: "Terrain"

- [ ] **Step 1: failing tests** (testing-library, mocking `bridge.call` as existing renderer tests do): with a plan holding one customer imagery pack and one refused terrain pack, the dialog shows the section, the imagery row unticked with the licence reminder, the terrain row with its reason and no checkbox; ticking the imagery row calls `package:plan` with `rasterPacks: [{ kind: 'imagery', id }]`; Export sends the same `rasterPacks`; with `rasterPacks: []` the "no pack covers" line shows.
- [ ] **Step 2:** run, see failures.
- [ ] **Step 3:** implement, following the map pack section's markup and classes (same card, `Switch` is for the region; use the existing layer checkbox pattern at ~170 for rows). Load `impeccable` before styling; reuse existing CSS classes, no new colours.
- [ ] **Step 4:** tests pass; `pnpm --filter @aio/desktop typecheck`; `pnpm lint`.
- [ ] **Step 5: commit** `feat(desktop): tick imagery and terrain packs into a package`.

### Task 6: Journal follows tilesets, ground control and runs (packages/journal, apps/desktop main)

**Files:** modify `packages/journal/src/diff.ts`, `diff.test.ts`; `apps/desktop/src/main/journal.ts`, `journal.test.ts`.

**Interfaces:** produces `externalOp(rel, before, after, label?: string)`; `isJournaledFile` true for `tilesets.json`, `photogrammetry/<run>/run.json`, `photogrammetry/<run>/gcp.json`; `journaledFiles(root)` lists them.

- [ ] **Step 1: failing tests**
  - `diff.test.ts`: `isJournaledFile('tilesets.json')`, `('photogrammetry/r1/run.json')`, `('photogrammetry/r1/gcp.json')` true; `('photogrammetry/r1/report/align.json')`, `('photogrammetry/r1/work/x.json')`, `('photogrammetry/r1/gcp.json.bak')` false. `diffRecordFile('tilesets.json', a, b, [{ label: 'Imported 3D Tiles "Bridge"', ids: ['file'] }])` returns one `record.external` op whose `label` is that text and whose payload has the two hashes.
  - `journal.test.ts` (follow the existing `orientation:write` tests):
    - `tilesets:write` through `wrap` appends one `record.external` op for `tilesets.json` before the write, labelled "3D Tiles list edited", and History (`journal:history`) shows it as by hand;
    - `photo:writeGcp` appends one op for `photogrammetry/<run>/gcp.json` labelled "Ground control edited";
    - `tilesets:import` (handler writes `tilesets.json` itself) records one op after a successful import, labelled `Imported 3D Tiles "<name>"`, none after a refused one;
    - `photo:applyPoses` with `apply: true` records the manifest change after the write (a `manifest.entry` patch on the photos layer), none for `apply: false`;
    - a `jobs:event` ending a tracked `photo.align` job after the test changed `photogrammetry/r1/run.json` and `gcp.json` records two ops with `via.pipeline.name === 'photo.align'`;
    - a `tiles.mesh` job adding a `tilesets.json` entry is recorded with `via.pipeline`;
    - with the journal off, `tilesets:write` and `photo:writeGcp` save and append nothing (Review focus 5);
    - a package project: no ops (existing guard).
- [ ] **Step 2:** `pnpm --filter @aio/journal test -- diff` and `pnpm --filter @aio/desktop test -- journal` fail.
- [ ] **Step 3: implement**
  - `diff.ts`: `const M10_FILE = /^(tilesets\.json|photogrammetry\/[^/]+\/(run|gcp)\.json)$/;` added to `isJournaledFile`. `externalOp` takes `label?` and sets it on the draft when given. In `diffRecordFile`, the `record.external` fallback passes `commands?.findLast((c) => c.ids.includes('file'))?.label` (use a loop if `findLast` is not available in the target). Update the `isJournaledFile` doc comment.
  - `journal.ts` `journaledFiles`: add `tilesets.json` to the top-level names; then scan `photogrammetry/*/` for `run.json` and `gcp.json` (readdir, skip non-directories, `isJournaledFile` check).
  - `WRITERS`:

```ts
  // M10 3D Tiles list and ground control: one record.external op per save, labelled
  'tilesets:write': (r: IpcRequest<'tilesets:write'>) => ({
    projectId: r.projectId,
    rel: TILESETS_FILE,
    after: r.file,
    commands: [{ label: '3D Tiles list edited', ids: ['file'] }],
  }),
  'photo:writeGcp': (r: IpcRequest<'photo:writeGcp'>) => ({
    projectId: r.projectId,
    rel: `${photoRunDir(r.run)}/${PHOTO_RUN_FILES.gcp}`,
    after: r.gcp,
    commands: [{ label: 'Ground control edited', ids: ['file'] }],
  }),
```

- After-write reconcile (in `journalHandler`, beside `builder:updateLayers`): `tilesets:import` → on `ok`, `serial(st, () => reconcileLabelled(st, TILESETS_FILE, `Imported 3D Tiles "${r.entry.name}"`))`; `photo:applyPoses` with `apply: true` → on `ok`, `reconcile(st, ['manifest.json'], undefined)`. `reconcileLabelled` is a small variant of `reconcile` for one file that passes the label through `diffRecordFile(rel, before, after, [{ label, ids: ['file'] }])`. Skip both for packages and when the journal is off.
- Update the file header comment of `journal.ts` (the wrapped writers list) and remove "Imported tilesets are not recorded in the project history" from KNOWN-LIMITS in Task 8.
- [ ] **Step 4:** tests pass; typecheck both packages.
- [ ] **Step 5: commit** `feat(journal): record 3D Tiles, ground control and run changes in History`.

### Task 7: The Globe starts at the opened project's site; no wizard in player mode (apps/desktop renderer)

**Files:** modify `apps/desktop/src/renderer/globe/GlobeScreen.tsx` (~66, ~278, ~464), `GlobeScreen.test.tsx`; `apps/desktop/src/renderer/processingTools.ts` (~62) and its test.

- [ ] **Step 1: failing tests**
  - `GlobeScreen.test.tsx`: after closing the Globe with project A open (camera remembered), opening project B and the Globe starts at B's site (`start` is `{ site: B.lonLat }`), while reopening with A still open starts at the remembered camera. Use the controller mock the file already uses to read the start argument.
  - `processingTools` test: with `shell.pkg` set, `resumeAfterTools()` neither opens the wizard nor changes the screen, and clears `resume`.
- [ ] **Step 2:** run, see failures.
- [ ] **Step 3: implement**

```ts
/** The Globe camera when it last closed, and the project open then (this session). */
let lastCamera: { projectId: string | null; camera: GlobeCamera } | null = null;
...
const start =
  lastCamera && lastCamera.projectId === (project?.id ?? null)
    ? { camera: lastCamera.camera }
    : project
      ? (() => { const s = loaded.sites.find((x) => x.projectId === project.id); return s ? { site: s.lonLat } : lastCamera ? { camera: lastCamera.camera } : null; })()
      : lastCamera ? { camera: lastCamera.camera } : null;
...
lastCamera = { projectId: project?.id ?? null, camera: c };
```

In `resumeAfterTools`, after clearing `resume`: `if (shell.getState().pkg) return;`.

- [ ] **Step 4:** tests pass; typecheck.
- [ ] **Step 5: commit** `fix(desktop): the Globe opens at the open project's site and player mode never opens the photo wizard`.

### Task 8: End to end and docs

**Files:** create `apps/desktop/e2e/packages-globe.spec.ts`; modify `apps/desktop/e2e/tilesets.spec.ts`; docs `docs/KNOWN-LIMITS.md` (~237, ~241), `docs/architecture/data-conventions.md` (sections 21, 22, 23 and the package layout section), `docs/plans/2026-10-07-m10-globe-and-photogrammetry.md` (mark X1 and Journal (M9) done, pointing at this plan).

- [ ] **Step 1: `packages-globe.spec.ts`** (single test, off-screen fixtures, no network: reuse the zero-network guard of `package.spec.ts`):
  1. Build a folder project with `createGlobeLibrary` (or `createPhotoProject` plus a georeferenced manifest) and add a fake run folder: `photogrammetry/r1/run.json`, `gcp.json`, `report/accuracy.json`, `work/database.db` (1 MB of zeros), `work/products/k/depth.bin`, plus `tiles/r1-mesh/tileset.json` from `enuTileset` and its `tilesets.json` entry.
  2. Install a customer imagery pack covering the site with `writeRasterPack` (`imageryPack({ customerLicence: true, ... })`) and a terrain pack that does not cover it.
  3. Open the project, open **Share as package**: the "Imagery and terrain" section lists the imagery pack unticked with the licence reminder and does not list the far terrain pack. Tick it; the total grows. Export (save dialog stubbed as `package.spec.ts` does).
  4. Read the `.aio` with `openZip` in the test: entries include `photogrammetry/r1/run.json`, `gcp.json`, `report/accuracy.json`, `tilesets.json`, `tiles/r1-mesh/tileset.json`, `packs/imagery/<id>.pmtiles` and `.json`; no entry starts with `photogrammetry/r1/work/`.
  5. Remove the installed imagery pack (so only the package can provide it), visit the Globe once with no project, then open the `.aio` in player mode: the Globe flies to the package's site (site card shows the package name and "1 tileset"), the imagery menu lists the pack marked as from the package, and a pixel at the site centre has the pack's colour (`imageryColour`, as `imagery-packs.spec.ts` checks).
  6. Player mode: the Processing drawer shows the "not in a package" text and no **Create maps** button; `jobs:start` through the bridge for the package path answers `ok: false`; no file under the package's folder or the data root's `projects/` changed (compare a listing before and after).
- [ ] **Step 2: `tilesets.spec.ts`**: after the existing import step, open **History** and expect a row `Imported 3D Tiles "<name>"`; rename the tileset (the existing edit step, or `tilesets:write`) and expect "3D Tiles list edited".
- [ ] **Step 3:** run both specs the way CI does, from `apps/desktop`: `pnpm demo:change --quick` first (main checkout's venv per `reference-e2e-in-a-worktree`: `QUADRION_E2E_PYTHON`), then `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=1 pnpm exec playwright test e2e/packages-globe.spec.ts e2e/tilesets.spec.ts --workers=1`. Also rerun `e2e/package.spec.ts`, `e2e/packages-packs.spec.ts`, `e2e/globe.spec.ts`, `e2e/audit.spec.ts` (touched paths).
- [ ] **Step 4: docs**: KNOWN-LIMITS: replace "Customer-licensed imagery stays out of packages; ticking it into a package is not built yet." with "Customer-licensed imagery and terrain travel in a package only when you tick them, cut to the site."; drop "Imported tilesets are not recorded in the project history."; keep the turn-taking limit, adding that History now shows which job changed the project. data-conventions: section 21 "Packages" line (allow-list), section 23 (`packs/<kind>/<id>` members in packages, `source: 'package'`, `pkg-` ids), section 17 (journal follows `tilesets.json` and run files as `record.external`). Run `node tools/agent/check-public-text.mjs` on the changed docs.
- [ ] **Step 5:** `pnpm check` green; commit `test(e2e): processed project packages and the player's Globe` and `docs: packages carry runs and ticked packs; History records M10 files`.

---

## How to test (for the founder, after the build)

1. Open a project that has been processed from photos (the photo demo after **Create maps**, or any project with a run). Choose **Share as package**.
2. In the dialog, find **Imagery and terrain**. Each installed pack that covers the site is listed, all unticked. A pack you imported as customer imagery shows its licence and the reminder. Tick it: the total size grows by the clip's size, not the whole pack.
3. Export the package. Open it with any ZIP tool: you see `photogrammetry/<run>/run.json`, `gcp.json` and `report/`, `tilesets.json`, `tiles/`, and `packs/imagery/...`; there is no `photogrammetry/<run>/work/` folder. The file is several GB smaller than before for a large run.
4. In **Settings, Offline maps**, remove that imagery pack (or open the package on another computer). Open the Globe once, then double-click the `.aio`.
5. Go to the Globe: it flies to the package's site, the site card shows its open issues and tilesets, and the satellite imagery shows, marked as coming from the package in the imagery menu.
6. Look for any way to start processing (the Processing drawer, the photo wizard, **Update processing tools**): there is none; the drawer says processing needs the project folder.
7. Back in a folder project: import a 3D Tiles folder (**Import 3D Tiles**), edit ground control on a run, and run **Create maps**. Open **History**: you see "Imported 3D Tiles "<name>"", "Ground control edited", and the processing job's changes under the job's name.

## Self-review notes

- Spec coverage: section 1 → T1; section 2 → T2, T3, T4, T5; section 3 → T4 (package sites), T7; section 4 → T6; tests and docs → T8. The turn-taking issue is explicitly out of scope (spec "Out of scope").
- Names used across tasks: `RasterPackRef`, `PackageRasterPlan`, `EMBEDDED_RASTER_DIRS` (T2) → T3, T4, T5; `planRasterEmbeds`, `chooseRasterEmbeds`, `writeRasterEmbeds`, `embeddedRasterPacks`, `findEmbeddedRaster` (T3) → T4; `runFileTravels` (T1); `externalOp(..., label?)` (T6).
