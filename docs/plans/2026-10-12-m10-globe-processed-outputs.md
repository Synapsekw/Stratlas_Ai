# Processed outputs and change heat maps on the Globe: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orthophotos, shaded DSMs and change heat maps made by photo processing and change detection draw on the Globe at their site. An end to end spec proves that two processed synthetic surveys run imagery, surface and cloud change and that the heat map then shows on the Globe.

**Architecture:** `globe:sites` gains each site's frame and its `kit-pyramid` rasters (an additive contract change). A new Cesium imagery provider in `@aio/globe` resamples the project's own kit-pyramid tiles onto Cesium's geographic tiles, through an affine map fitted from the pyramid corners taken exactly through PROJ. The controller draws the outputs of up to two sites in focus (the open project and the picked site). Their rasters sit on top of the layer plan, and their 3D Tiles keep working as before. A site card section, "On the Globe", switches each raster on or off and shows the heat map legend.

**Tech stack:** TypeScript, zod (`@aio/schema`), CesiumJS 1.146 (`@cesium/engine`, `@cesium/core`), React, Vitest, Playwright with Electron, Python 3 (pytest, synthetic scenes in `python/tests`).

**Spec:** `docs/plans/2026-10-12-m10-globe-processed-outputs-design.md`. Read it first: the decisions there are binding for this plan.

## Global constraints

- Worktree: `E:\Dev\AIO Software\.claude\worktrees\m10-globe-processed-outputs`, branch `feat/m10-globe-processed-outputs`. Never edit the main checkout. Stage by path, never with `git add -A`. Never use `git stash`. Never use `--no-verify`.
- **Zero network.** Everything is read from `aio://project/<id>/<path>`. There is no new protocol host, no CSP change, and no Cesium online provider (`eslint.config.js` bans them).
- **The 2 cm rule.** Local frame to WGS84 goes through `@aio/globe` `projectToLonLat` and `localToProject`, never through a UTM-as-metres shortcut.
- **Contracts are additive and optional.** The `GlobeSite` change carries its row in `docs/architecture/contract-changes.md` (Task 1). The `Settings` key set stays pinned (`m10.test.ts`, `m11.test.ts`).
- **Budgets.** At most two sites in focus. The pyramid tile LRU is 48 decoded tiles on Medium and High and 16 on Low. Resampled tiles are 256 px. Leaving the Globe disposes every provider (the "closing the Globe gives its WebGL context back" test stays green).
- **Electron windows stay off-screen** in every agent or e2e run (the fixtures do this). Use `--workers=1` and one Playwright run at a time.
- **E2E the CI way:** `pnpm demo:build --quick` (or `pnpm demo:change --quick`) first, then from `apps/desktop` with `QUADRION_WINDOW_SIZE=1100x720`, `QUADRION_E2E_SCALE=1` and `QUADRION_E2E_SWGL=1`, `npx playwright test e2e/<spec>.spec.ts --workers=1`. A worktree has no `python/.venv`, so point `QUADRION_E2E_PYTHON` at the main checkout's venv.
- **Copy:** no emoji and no em or en dashes in user-facing text. No client, site or person names in code, tests, docs or commit messages. Data is synthetic only.
- Conventional commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review focus

These are the inputs most likely to bite a person that no single test owns, and the task whose tests pin each one:

1. **A site on a WKT CRS, or far from the CRS's central meridian (grid convergence of several degrees).** The ortho must still land within 2 cm and not be rotated. Pinned in Task 3 (`pyramidPlacement` against PROJ for EPSG 32640 at the zone edge and for a WKT Transverse Mercator).
2. **Switching a raster on or off while street tiles are drawn.** The base layers must not rebuild or flash. Pinned in Task 4 (the controller test asserts that `imageryLayers.removeAll` is not called on a raster-only change).
3. **A project with several orthos on the latest date, or none dated.** The default must be deterministic: the first layer of the latest capture, else the first ortho. Pinned in Task 3 (`defaultShown` cases).
4. **A missing or corrupt tile, or a missing `tiles.json`.** This must give a transparent tile or a disabled row with "This map could not be read.", never a thrown error inside Cesium. Pinned in Task 4 (provider test) and Task 6 (row state).
5. **Picking a second site, then a third.** Only two sites may be in focus: the old picked site's outputs go, and the open project's stay. Pinned in Task 6 (`focusSites` test) and Task 4 (diff by project).

---

## Execution DAG

| Task | What                                                          | Depends on | Packages touched                                                                                     | Size |
| ---- | ------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- | ---- |
| T1   | Contract: `GlobeSite.frame?`, `GlobeSite.rasters?`            | none       | `@aio/schema`, `docs/architecture/contract-changes.md`                                               | S    |
| T5   | Synthetic two-survey scene and its truth                      | none       | `python/tests`                                                                                       | M    |
| T2   | Main: frame and rasters in `globe:sites`                      | T1         | `apps/desktop/src/main` (`globe.ts`, `globe.test.ts`)                                                | S    |
| T3   | Pure placement, tile selection, defaults, the layer plan kind | T1         | `@aio/globe` (`projectRasters.ts`, `layers.ts`, `index.ts`)                                          | M    |
| T4   | Imagery provider and controller `setSiteOutputs`              | T3         | `@aio/globe` (`view/**`)                                                                             | L    |
| T6   | Renderer: sites in focus, the "On the Globe" switches, legend | T2, T4     | `apps/desktop/src/renderer/globe/**`, `packages/ui/src/i18n/en.ts`                                   | M    |
| T7   | Globe e2e on the `globeLibrary` fixture                       | T6         | `apps/desktop/e2e` (`m10Fixtures.ts`, `globe.spec.ts`)                                               | M    |
| T8   | Two-survey change chain e2e, then the heat map on the Globe   | T5, T6     | `apps/desktop/e2e` (new spec and fixture script), `renderer/change/producers/**` only if a bug shows | L    |
| T9   | Docs: known limits, M10 plan, data conventions, user guide    | T6         | `docs/**`                                                                                            | S    |

**Parallel batches.** Within a batch no two tasks share a file. Dispatch each batch in one message.

- **Batch 1:** T1, T5
- **Batch 2:** T2, T3
- **Batch 3:** T4
- **Batch 4:** T6
- **Batch 5:** T7, T8, T9

**Critical path:** T1, T3, T4, T6, T8 (T8 is the longest single run: two photo jobs and three change jobs).

**E2E specs:** `apps/desktop/e2e/globe.spec.ts` changes (one new test, and the tileset test moves to the new prop through the UI it already drives). `apps/desktop/e2e/photo-change.spec.ts` is new.

**Contract change:** one row (Task 1).

---

### Task 1: Contract, `GlobeSite.frame?` and `GlobeSite.rasters?`

**Files:**

- Modify: `packages/schema/src/globe.ts` (beside `GlobeSite`, around line 119)
- Modify: `packages/schema/src/index.ts` (export `GlobeRaster`, if the file lists exports by name)
- Test: `packages/schema/src/m10.test.ts`
- Modify: `docs/architecture/contract-changes.md` (append one row)

**Interfaces:**

- Produces: `GlobeRaster` (zod and type) `{ layerId: string; name: string; role: 'ortho' | 'dsm' | 'plan'; src: string; capture?: string; change?: true }`, `GlobeSite.frame?: { crs: Crs; origin: Vec3 }` and `GlobeSite.rasters?: GlobeRaster[]`.

- [ ] **Step 1: Write the failing test** (in `m10.test.ts`):

```ts
import { GlobeRaster, GlobeSite } from './globe';

describe('GlobeSite outputs (12 Oct 2026, additive)', () => {
  const base = {
    projectId: 'p1',
    name: 'Synthetic site',
    lonLat: [55.1, 25.2],
    captures: [],
    issues: { open: 0, bySeverity: {} },
    tilesets: [],
  };
  it('parses a site written before the change', () => {
    expect(GlobeSite.parse(base)).toEqual(base);
  });
  it('carries the frame and the kit-pyramid rasters', () => {
    const site = {
      ...base,
      frame: { crs: { epsg: 32640 }, origin: [412000, 3245000, 20] },
      rasters: [
        {
          layerId: 'r1-ortho',
          name: 'Ortho',
          role: 'ortho',
          src: 'rasters/r1/ortho/tiles.json',
          capture: 'c1',
        },
        {
          layerId: 'chg-heat',
          name: 'Surface change',
          role: 'plan',
          src: 'change/x/tiles.json',
          change: true,
        },
      ],
    };
    expect(GlobeSite.parse(site)).toEqual(site);
  });
  it('refuses an unknown role and an absolute or parent path', () => {
    const r = { layerId: 'a', name: 'A', role: 'ortho', src: 'rasters/a/tiles.json' };
    expect(GlobeRaster.safeParse({ ...r, role: 'mesh' }).success).toBe(false);
    expect(GlobeRaster.safeParse({ ...r, src: '../x/tiles.json' }).success).toBe(false);
    expect(GlobeRaster.safeParse({ ...r, src: 'C:/x/tiles.json' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and check it fails:** `pnpm --filter @aio/schema test -- m10` should fail with `GlobeRaster` not exported.
- [ ] **Step 3: Implement** in `globe.ts`. Reuse `ProjectPath` from `common.ts` ("A path inside the project folder: relative, no `..`, no drive letter"); do not write a new regex.

```ts
import { Crs } from './manifest';
import { Id, IsoDate, IsoTime, ProjectPath, Vec3 } from './common';

/** A `kit-pyramid` raster of a site, for the Globe (12 Oct 2026, additive). */
export const GlobeRaster = z.object({
  layerId: Id,
  name: z.string().min(1),
  role: z.enum(['ortho', 'dsm', 'plan']),
  /** The `tiles.json` (`aio.tiles/1`) inside the project, served at `aio://project/<id>/<src>`. */
  src: ProjectPath,
  capture: Id.optional(),
  /** A change heat map (`derived.kind === 'change'`). */
  change: z.literal(true).optional(),
});
export type GlobeRaster = z.infer<typeof GlobeRaster>;
```

Add `frame: z.object({ crs: Crs, origin: Vec3 }).optional()` and `rasters: z.array(GlobeRaster).optional()` to `GlobeSite`. Check first that `manifest.ts` does not import `globe.ts`, so the import makes no cycle (it does not today).

- [ ] **Step 4: Run** `pnpm --filter @aio/schema test` until it passes, including the pinned `Settings` key tests.
- [ ] **Step 5: Add the contract row** at the end of `docs/architecture/contract-changes.md`:

`| 2026-10-12 | Additive and optional: GlobeSite (globe:sites) gains frame? ({ crs, origin }: the project CRS and local-frame origin) and rasters? (GlobeRaster[]: { layerId, name, role ortho, dsm or plan, src (a tiles.json path inside the project), capture?, change? }): the project's kit-pyramid raster layers that are not drafts. No new channel; globe:sites reads no extra file. Older renderers ignore the fields | M10 exit "outputs open in the Globe" and the change detection follow-up: processed orthos and change heat maps on the Globe for their site (design docs/plans/2026-10-12-m10-globe-processed-outputs-design.md) | main (globe.ts), @aio/globe, renderer globe | pending founder review |`

Format the row like its neighbours: wrap the code names in backticks and pad the columns with `pnpm prettier --write docs/architecture/contract-changes.md`.

- [ ] **Step 6: Commit:** `git add packages/schema/src/globe.ts packages/schema/src/index.ts packages/schema/src/m10.test.ts docs/architecture/contract-changes.md` then `git commit -m "feat(schema): globe sites carry their frame and kit-pyramid rasters"`.

---

### Task 2: Main, frame and rasters in `globe:sites`

**Files:**

- Modify: `apps/desktop/src/main/globe.ts` (`siteOf`)
- Test: `apps/desktop/src/main/globe.test.ts`

**Interfaces:**

- Consumes: `GlobeRaster` and `GlobeSite` (T1).
- Produces: `globeRastersOf(layers: readonly Layer[]): GlobeRaster[]` (exported for the test). `siteOf` now sets `frame` whenever it places the site, and sets `rasters` when there is at least one.

- [ ] **Step 1: Write the failing tests** in the `library projects as Globe sites` describe. Build a manifest with these layers: an ortho `kit-pyramid` with `capture: 'c1'`; a DSM `kit-pyramid`; a heat map `{ role: 'plan', format: 'kit-pyramid', derived: { kind: 'change' } }`; a draft (`derived: { kind: 'model', draft: true }`); a `cog` ortho; a `kit-pyramid` whose `src` is `{ hash }`; and a mesh. Expect exactly three rasters, in manifest order, with `change: true` only on the heat map. Also expect `frame` to equal `{ crs, origin }` of the manifest. A second test checks that a local-grid project still returns `null` (unchanged).
- [ ] **Step 2: Run** `pnpm --filter desktop test -- src/main/globe.test.ts` and check it fails.
- [ ] **Step 3: Implement:**

```ts
export function globeRastersOf(layers: readonly Layer[]): GlobeRaster[] {
  const out: GlobeRaster[] = [];
  for (const l of layers) {
    if (l.kind !== 'raster' || l.format !== 'kit-pyramid' || l.derived?.draft) continue;
    if (!('path' in l.src)) continue; // content-addressed rasters: not on the Globe yet
    out.push({
      layerId: l.id,
      name: l.name,
      role: l.role,
      src: l.src.path,
      ...(l.capture ? { capture: l.capture } : {}),
      ...(l.derived?.kind === 'change' ? { change: true as const } : {}),
    });
  }
  return out;
}
```

In `siteOf`, add `frame: { crs: p.manifest.crs, origin: p.manifest.origin }` and `...(rasters.length ? { rasters } : {})`.

- [ ] **Step 4: Run the tests** until they pass. Then run `pnpm --filter desktop typecheck`.
- [ ] **Step 5: Commit:** `feat(globe): globe:sites lists each site's frame and kit-pyramid rasters`.

---

### Task 3: Pure placement, tile selection, defaults and the layer plan kind

**Files:**

- Create: `packages/globe/src/projectRasters.ts`
- Create: `packages/globe/src/projectRasters.test.ts`
- Modify: `packages/globe/src/layers.ts` (plan kind and input)
- Modify: `packages/globe/src/globe.test.ts` (layer plan cases)
- Modify: `packages/globe/src/index.ts` (exports)

**Interfaces:**

- Consumes: `GlobeRaster` and `GlobeSite` (T1); `projectToLonLat` and `SiteGeoref` from `./geodesy`, and `localToProject` from `@aio/geo`.
- Produces:

```ts
export interface PyramidIndex {
  levels: { z: number; tileSize: number; cols: number; rows: number; pattern: string }[]; // coarse to fine
  corners: { tl: Vec3; tr: Vec3; bl: Vec3 };
  legend?: unknown; // passed through for the renderer (`@aio/maps` parseChangeLegend)
}
export function parsePyramid(json: unknown): PyramidIndex | null;

export interface PyramidPlacement {
  /** West, south, east, north in degrees, with a margin of 1 % of the size. */
  rect: [number, number, number, number];
  /** Lon and lat in degrees to placement fractions (u along tl to tr, v along tl to bl). */
  toUv(lon: number, lat: number): [number, number];
  /** The inverse, for tests and for the corner check. */
  toLonLat(u: number, v: number): [number, number];
  /** Ground metres of one pixel of each level, coarse to fine. */
  metresPerPx: number[];
}
export function pyramidPlacement(
  index: PyramidIndex,
  frame: Pick<SiteGeoref, 'crs' | 'origin'>,
): PyramidPlacement;

export interface PyramidTileRef {
  z: number;
  x: number;
  y: number;
  path: string;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}
export function pyramidTilesFor(
  index: PyramidIndex,
  placement: PyramidPlacement,
  rect: [number, number, number, number],
  metresPerPx: number,
  maxTiles?: number, // default 16
): { z: number; tiles: PyramidTileRef[] } | null;

export function defaultShown(site: Pick<GlobeSite, 'captures' | 'rasters'>): string[]; // layer ids
export function rasterOrder<R extends { role: string; change?: true; capture?: string }>(
  rasters: readonly R[],
  captures: readonly { id: string; date: string }[],
): R[];
```

- `layers.ts`: add `| { kind: 'project-raster'; raster: R }` to `GlobeLayerPlan` (it becomes `GlobeLayerPlan<P, R = never>`), and add `projectRasters?: readonly R[]` to `GlobeLayerInput`. `planGlobeLayers` appends `projectRasters` (in the order given) after every other entry, in every look.

- [ ] **Step 1: Write the failing tests** in `projectRasters.test.ts`:
  - `parsePyramid` accepts an `aio.tiles/1` index, sorts levels by `cols` ascending, keeps `legend`, and returns null for `{ schema: 'x' }`, for missing corners and for empty levels.
  - **Placement accuracy (Review focus 1):** for EPSG 32640 at origin `[412000, 3245000, 20]`, and again at `[170000, 3245000, 20]` (near the zone edge, convergence about 2 degrees), and for a WKT Transverse Mercator equal to 32640: corners `tl [-300, 0, -300]`, `tr [300, 0, -300]`, `bl [-300, 0, 300]`. Check `toLonLat(0.5, 0.5)` and `toLonLat(0.25, 0.75)` against exact `projectToLonLat(localToProject(...))` within 2 cm, converting the difference with metres per degree at that latitude. Check that `toUv(toLonLat(u, v))` round-trips within 1e-9.
  - `metresPerPx` for a 600 m pyramid with levels of 1, 2 and 4 cols of 512 px is `[1.171875, 0.5859375, 0.29296875]`.
  - `pyramidTilesFor` picks the coarsest level whose pixels are no larger than the asked ground pixel, steps coarser while there would be more than `maxTiles` tiles, returns null for a rectangle that misses the pyramid, and fills `{z}`, `{x}` and `{y}` in the pattern.
  - **Defaults (Review focus 3):** two orthos on c2 (the latest) give the first of them; orthos without a capture fall back to the first ortho; no ortho gives `[]`; heat maps and DSMs are never on by default.
  - `rasterOrder`: orthos by capture date ascending, then DSMs, then heat maps.
- [ ] **Step 2:** Add to `globe.test.ts`: `planGlobeLayers({ style, street: true, imagery: [pack], onlineSatellite: true, projectRasters: [a, b] })` ends with `project-raster a, b` in each of `street`, `satellite` and `natural-earth`. Without `projectRasters` the plan is unchanged (the existing expectations still hold).
- [ ] **Step 3: Run** `pnpm --filter @aio/globe test` and check both files fail.
- [ ] **Step 4: Implement** `projectRasters.ts`. Placement: compute the lon/lat of `tl`, `tr` and `bl` exactly (local to project with `localToProject`, then `projectToLonLat`). The affine map from (u, v) to (lon, lat) is `L(u, v) = Ltl + u (Ltr - Ltl) + v (Lbl - Ltl)`, and `toUv` is its 2 by 2 inverse. `rect` is the bounding box of the four corners (the fourth is `tr + bl - tl`) plus a 1 % margin. Tile selection follows `@aio/maps` `pyramidView` (`packages/maps/src/pyramid.ts`), working in (u, v) from the four corners of `rect` through `toUv`. Do not import `@aio/maps`.
- [ ] **Step 5: Implement** the `layers.ts` change. Keep `planShowsPacks` as it is.
- [ ] **Step 6: Run** `pnpm --filter @aio/globe test` and `pnpm --filter @aio/globe typecheck` until both pass.
- [ ] **Step 7: Commit:** `feat(globe): place kit pyramids on the Earth and plan them above every look`.

---

### Task 4: Imagery provider and controller `setSiteOutputs`

**Files:**

- Create: `packages/globe/src/view/projectRasterProvider.ts`
- Create: `packages/globe/src/view/projectRasterProvider.test.ts`
- Modify: `packages/globe/src/view/controller.ts` (`setTilesets` becomes `setSiteOutputs`; layer build; `inspect`; dispose)
- Modify: `packages/globe/src/view/GlobeView.tsx` (prop `tilesets` becomes `outputs`)
- Modify: `packages/globe/src/view/index.ts` (exports `SiteOutputs`)
- Test: add to `packages/globe/src/globe.test.ts` only if the controller has its test there; otherwise create `packages/globe/src/view/controller.outputs.test.ts`

**Interfaces:**

- Consumes: everything Task 3 produces; `TilesetEntry` from `@aio/schema`.
- Produces:

```ts
export interface SiteOutputRaster { layerId: string; src: string; index: PyramidIndex }
export interface SiteOutputs {
  projectId: string;
  georef: SiteGeoref;
  tilesets: readonly Pick<TilesetEntry, 'id' | 'src' | 'visible' | 'transform'>[];
  /** Shown rasters, bottom first (`rasterOrder`). */
  rasters: readonly SiteOutputRaster[];
}
// GlobeController
setSiteOutputs(outputs: readonly SiteOutputs[]): Promise<void>;
// GlobeInspection gains
projectRasters: { projectId: string; layerId: string; ready: boolean; tiles: number; lastError: string | null }[];
// and tilesets entries gain projectId: { projectId: string; id: string; ready: boolean }[]
// GlobeViewProps: `tilesets` is replaced by
outputs: readonly SiteOutputs[];
```

The renderer reads `tiles.json` itself (Task 6) and passes the parsed `index`, so the provider never re-reads it.

- [ ] **Step 1: Write the failing provider tests** (jsdom, with `OffscreenCanvas` or `document.createElement('canvas')` stubbed by the canvas mock the package's other view tests use; check `packages/globe/src/view` and the vitest setup first). Use a synthetic pyramid of one level, 2 by 1 tiles: the left tile all red, the right all blue. A fake `fetchTile(path)` returns an `ImageBitmap` stand-in.
  - `rectangle` equals `placement.rect` in radians, and the tiling scheme is `GeographicTilingScheme`.
  - `requestImage` for the geographic tile over the left half calls `fetchTile` with the left tile's path only, and draws with one `setTransform` per pyramid tile. Assert that the transform matrix maps the tile's (u, v) corners to the right canvas pixels within 0.5 px.
  - **(Review focus 4)** A `fetchTile` that rejects gives a transparent canvas, sets `stats().lastError` and resolves (no rejection reaches Cesium). A tile outside the pyramid gives the shared transparent 1 px tile without a fetch.
  - The LRU keeps at most `cacheTiles` decoded tiles and calls `close()` on what it drops. `dispose()` closes every tile.
  - `maximumLevel` is the smallest geographic level whose ground pixel at 256 px is no larger than the finest `metresPerPx`, capped at 22.
- [ ] **Step 2: Write the failing controller tests**, following how the existing controller tests build a controller with a stubbed `CesiumWidget` (search `packages/globe/src` for the test that calls `setTilesets` or `inspect`; if none builds a controller, test the diff as a pure helper `diffSiteOutputs(prev, next)` exported from `controller.ts`):
  - **(Review focus 2)** Going from `[A with ortho]` to `[A with ortho and heat map]` adds one imagery layer, raises it to the top, and never calls `imageryLayers.removeAll`.
  - **(Review focus 5)** Going from `[A, B]` to `[A, C]` removes B's layers and tilesets, keeps A's (the same objects), and adds C's.
  - A plan rebuild (a look change) re-adds the project raster layers on top after the base layers.
  - `inspect().projectRasters` lists each shown raster with its `projectId` and `layerId`.
- [ ] **Step 3: Run** `pnpm --filter @aio/globe test` and check the new tests fail.
- [ ] **Step 4: Implement the provider** (about 250 lines), following `providers.ts`'s `PmtilesImageryProvider` for the Cesium `ImageryProvider` surface it already satisfies (`asImageryProvider`):

```ts
export class KitPyramidImageryProvider {
  readonly tilingScheme = new GeographicTilingScheme();
  readonly tileWidth = 256;
  readonly tileHeight = 256;
  readonly minimumLevel = 0;
  readonly maximumLevel: number;
  readonly rectangle: Rectangle;
  readonly errorEvent = new Event();
  readonly ready = true;
  readonly credit = undefined;
  readonly hasAlphaChannel = true;
  constructor(
    private readonly index: PyramidIndex,
    private readonly placement: PyramidPlacement,
    private readonly fetchTile: (path: string) => Promise<ImageBitmap>,
    private readonly o: { cacheTiles: number },
  ) {
    /* rectangle from placement.rect; maximumLevel from metresPerPx.at(-1) */
  }
  requestImage(x: number, y: number, level: number): Promise<HTMLCanvasElement> | undefined;
  stats(): { tiles: number; lastError: string | null };
  dispose(): void;
}
```

`requestImage`:

1. Take the tile's rectangle in degrees (`tilingScheme.tileXYToRectangle`).
2. Compute the ground metres per pixel at its centre: the tile height in degrees times 111 320, divided by 256.
3. Call `pyramidTilesFor(index, placement, rect, mpp)`. When it returns null, return the shared transparent tile.
4. For each pyramid tile, get the bitmap through the LRU. Map the tile's (u, v) box to canvas pixels: lon/lat through `placement.toLonLat`, then pixels through the geographic rectangle. Call `ctx.setTransform(a, b, c, d, e, f)` and `ctx.drawImage(bitmap, 0, 0, 1, 1)`, with the bitmap's pixels pre-scaled into the transform.
5. Return the canvas. Catch every error, record it in `lastError`, and return what was drawn.

`fetchTile` in the controller is `fetch('aio://project/<id>/<encoded path>').then((r) => r.blob()).then(createImageBitmap)`, with each path segment run through `encodeURIComponent`, as `setTilesets` does today.

- [ ] **Step 5: Implement `setSiteOutputs`** in `controller.ts`:
  - Keep `private outputs = new Map<string, { georef; tilesets: {id; tileset}[]; rasters: Map<string, { layer: ImageryLayer; provider: KitPyramidImageryProvider }> }>()`.
  - Diff by project id. A project that is gone: remove its primitives and layers, and call `provider.dispose()`. A new or changed project: load its tilesets with the body of the old `setTilesets` loop (keep the generation check, `geoidShift` and `transform`, keyed per project). Rasters: add the missing ones with `this.scene.imageryLayers.add(new ImageryLayer(asImageryProvider(p)))` and remove the dropped ones with `imageryLayers.remove(layer, true)`. Then raise the shown rasters to the top in order (`imageryLayers.raiseToTop(layer)`, bottom first).
  - In the layer build (around line 715): after `layers.removeAll(true)` rebuilds the base, re-add every project raster layer on top, creating new `ImageryLayer`s from the same providers. Base names stay out of the `same` check, so a raster change never triggers `removeAll`.
  - Cache size comes from `this.o.tier === 'low' ? 16 : 48`.
  - `inspect()` fills `projectRasters` from `layer.ready` (or `provider.stats().tiles > 0`), `stats().tiles` and `stats().lastError`.
  - `destroy()` disposes every provider.
- [ ] **Step 6:** In `GlobeView.tsx`, replace the `tilesets` effect with `useEffect(() => { if (ctl) void ctl.setSiteOutputs(props.outputs); }, [ctl, props.outputs]);`. Remove `GlobeTilesets` from the exports. Its only user is `GlobeScreen.tsx`, which Task 6 moves over; keep a temporary type alias if typecheck needs it between batches.
- [ ] **Step 7: Run** `pnpm --filter @aio/globe test`, `pnpm --filter @aio/globe typecheck` and `pnpm lint` until all pass.
- [ ] **Step 8: Commit:** `feat(globe): draw project kit pyramids as imagery for the sites in focus`.

---

### Task 5: Synthetic two-survey scene and its truth

**Files:**

- Modify: `python/tests/products_synth.py` (make the pile and an extra box parameters; the default is unchanged)
- Create: `python/tests/two_surveys_synth.py`
- Create: `python/tests/test_two_surveys_synth.py`

**Interfaces:**

- Produces: `two_surveys_synth.write_project(root: Path, step: float = 0.05) -> dict`, returning `{ "runs": {"c1": RUN1, "c2": RUN2}, "origin": [...], "truth": {...} }` and writing `<root>/truth.json`. The truth is:
  - `shed`: `{ outlineLocal: [[x, z], ...] }` (local frame, x east, z south), 3 m high, on open ground;
  - `pile`: `{ centreLocal: [x, z], radiusM, heightFrom: 4.0, heightTo: 6.0, fillM3 }`, with `fillM3` the cone difference π r² Δh / 3;
  - `openGround`: `[[x, z], ...]` (points that do not change);
  - `captures`: `[{ id: "c1", date: "2026-10-07" }, { id: "c2", date: "2026-10-21" }]`.

- [ ] **Step 1: Write the failing pytest:**
  - The default `make_scene` output is unchanged (hash its first image against the current output, computed before your edit and pasted as a constant).
  - `write_project` writes `manifest.json` with captures c1 and c2, `photogrammetry/<RUN1>/run.json` and `photogrammetry/<RUN2>/run.json`, each with `sparse/`, `frame.json` and `photos.json`, and photos under separate folders (`photos-c1/` and `photos-c2/`).
  - The later scene's `dsm()` at the shed centre is about 3 m above the earlier one and the same on `openGround`. `truth.fillM3` agrees with a numerical integral of the DSM difference over the pile within 2 %.
  - No client, site or person names appear in the written JSON (reuse the `tools/demo/check-no-client-data.mjs` word list through a subprocess, or assert on the fixed fictional strings).
- [ ] **Step 2: Run** `cd python && uv run pytest tests/test_two_surveys_synth.py -q` and check it fails.
- [ ] **Step 3: Implement.** In `products_synth.py`, turn `PILE` and `BOX` into the defaults of a small `Variant` dataclass (`pile`, `boxes`) that `dsm`, `in_box`, `surface_samples` and `make_scene` take with `variant: Variant = DEFAULT`. Call sites are unchanged. `two_surveys_synth.py` writes both scenes with the same camera grid (seed and spacing), the later one with `Variant(pile=(cx, cy, r, 6.0), boxes=(BOX, SHED))`. It reuses `write_project`'s run writing for each run id, so give `write_project` a `photos_dir` and a `captures` argument with defaults that keep today's behaviour. The manifest is written once, with both captures.
- [ ] **Step 4: Run** pytest until it passes. Then run `uv run pytest tests -q -k "products or photo"` so the scenes other tests use still pass.
- [ ] **Step 5: Commit:** `test(photo): a synthetic site surveyed twice, with a grown stockpile and a new shed`.

---

### Task 6: Renderer, sites in focus, the "On the Globe" switches and the legend

**Files:**

- Create: `apps/desktop/src/renderer/globe/SiteOutputs.tsx`
- Create: `apps/desktop/src/renderer/globe/SiteOutputs.test.tsx`
- Create: `apps/desktop/src/renderer/globe/siteOutputs.ts` (store and loaders)
- Create: `apps/desktop/src/renderer/globe/siteOutputs.test.ts`
- Modify: `apps/desktop/src/renderer/globe/GlobeScreen.tsx` (replace the `tilesets` state with outputs; render `SiteOutputs` in the site card)
- Modify: `apps/desktop/src/renderer/globe/GlobeScreen.test.tsx`
- Modify: `apps/desktop/src/renderer/globe/globe.css` (the section and legend; use the existing tokens)
- Modify: `packages/ui/src/i18n/en.ts` (keys below)

**Interfaces:**

- Consumes: `GlobeSite.frame` and `GlobeSite.rasters` (T1, T2); `SiteOutputs`, `parsePyramid`, `defaultShown` and `rasterOrder` from `@aio/globe` and `@aio/globe/view` (T3, T4); `parseChangeLegend`, `defaultLegend` and `legendGradient` from `@aio/maps`; `bridge.call('tilesets:list', { projectId })`.
- Produces:

```ts
export function focusSites(openId: string | null, pickedId: string | null): string[]; // at most 2, open first
export const useSiteOutputs: UseBoundStore<...>; // { shown: Record<projectId, string[] | undefined>; toggle(projectId, layerId); }
export async function loadPyramid(projectId: string, src: string): Promise<PyramidIndex | null>; // fetch aio://project/..., cached per project+src
export function SiteOutputs(props: { site: GlobeSite }): JSX.Element | null;
```

i18n keys: `globe.outputs.title` ("On the Globe"), `globe.outputs.ortho` ("Orthophoto {date}"), `globe.outputs.orthoUndated` ("Orthophoto"), `globe.outputs.dsm` ("Shaded surface {date}"), `globe.outputs.imageryChange` ("Imagery change"), `globe.outputs.surfaceChange` ("Surface change"), `globe.outputs.unreadable` ("This map could not be read.").

- [ ] **Step 1: Write the failing tests:**
  - `focusSites('a', null)` gives `['a']`. `focusSites('a', 'b')` gives `['a', 'b']`. `focusSites('a', 'a')` gives `['a']`. `focusSites(null, 'c')` gives `['c']`.
  - The store: `shown[p]` undefined means `defaultShown(site)`. `toggle` copies the defaults first, then flips the one id.
  - `SiteOutputs` renders nothing for a site without `frame` or `rasters`. It lists the orthos by capture date, then DSMs, then heat maps, each as a switch (`role="switch"`, `aria-checked`). The latest ortho is on. Clicking the heat map turns it on and shows the legend: the `parseChangeLegend` result of its index, else `defaultLegend('metres')` for a raster whose name or legend kind says surface, else `'score'`. A raster whose `loadPyramid` resolved null shows the row disabled with `globe.outputs.unreadable` (Review focus 4).
  - `GlobeScreen`: with the open project A and site B picked, `GlobeView` receives `outputs` for A and B, with B's georef from `B.frame` (`heightOffset: 0`) and B's tilesets from `tilesets:list { projectId: B }`. Picking C replaces B with C (Review focus 5). Only the shown rasters with a loaded index are passed, in `rasterOrder`.
- [ ] **Step 2: Run** `pnpm --filter desktop test -- src/renderer/globe` and check the tests fail.
- [ ] **Step 3: Implement** `siteOutputs.ts` (a zustand store, like the other renderer stores; check `rasterPacks` for the pattern), `loadPyramid` (a `fetch` of `aio://project/${encodeURIComponent(id)}/${segments}`, `parsePyramid`, and a `Map` cache cleared when the Globe unmounts), and `SiteOutputs.tsx`. The legend is a gradient bar (`legendGradient`) with its ticks (`legendTicks`), the same look as the map's change legend: reuse its CSS class if it is exported, else a small `globe-legend` block in `globe.css`.
- [ ] **Step 4:** In `GlobeScreen.tsx`, replace the `tilesets` state and effect with a `useMemo` and effect that, for each id in `focusSites(project?.id ?? null, pick?.projectId ?? null)`, loads `tilesets:list` and the shown pyramids, and builds `SiteOutputs[]`. For the open project, use `georefOf(project.manifest)`; for another site, `{ ...site.frame, heightOffset: 0 }`. Skip sites without a frame. Render `<SiteOutputs site={site} />` in the site card under `SiteFacts`. Pass `outputs` to `GlobeView`.
- [ ] **Step 5: Run** the renderer tests, `pnpm --filter desktop typecheck` and `pnpm lint` until all pass.
- [ ] **Step 6: Design check.** Load the `impeccable` skill and check the section against the site card's existing rhythm: spacing, switch size, the legend at the smallest window (1100 x 700), and keyboard focus order. Fix what it flags.
- [ ] **Step 7: Commit:** `feat(globe): processed outputs of the sites in focus, with switches and the change legend`.

---

### Task 7: Globe e2e on the `globeLibrary` fixture

**Files:**

- Modify: `apps/desktop/e2e/m10Fixtures.ts` (`createGlobeLibrary`: for the first site, a 2-level kit pyramid ortho per capture and one surface heat map, as PNG tiles written with `node:zlib`, plus their `raster` layers)
- Modify: `apps/desktop/e2e/globe.spec.ts` (new test; check the tileset test still passes through `outputs`)

**Interfaces:**

- Consumes: `inspect().projectRasters` (T4); the site card switches (T6).

- [ ] **Step 1: Fixture.** Write `rasters/ortho-c1/tiles.json` and `rasters/ortho-c2/tiles.json`, each covering local `[-150, -150]` to `[150, 150]`, with level 0 (1 by 1) and level 1 (2 by 2) tiles of 256 px. c1 is uniform green `#3a7d44`; c2 is a 4-quadrant pattern (green, grey, green, grey), so a pixel test can tell the dates apart. Also write `change/heat/tiles.json`, red `#e8202a` in the centre 100 m and transparent elsewhere, with a `legend` of kind `metres`. Add the three layers with `capture` c1 and c2 and `derived: { kind: 'change', from: 'c1', to: 'c2' }` on the heat map. PNG encoding: a 40-line helper (IHDR, IDAT through `zlib.deflateSync`, IEND, CRC32 table) local to the fixture file. Keep everything fictional.
- [ ] **Step 2: Write the test** `processed orthos and change heat maps draw at their site`:
  1. Open the Globe and select the first site (as the other tests do).
  2. `expect.poll(inspect().projectRasters)` shows exactly `ortho-c2` ready, `tiles > 0` and `lastError` null.
  3. Sample a canvas pixel at the site's screen position (the helper the spec already uses for colours). It is not the street base colour, and it matches the c2 pattern within tolerance.
  4. Click the "Surface change" switch. `projectRasters` gains `heat`, ready. The centre pixel is red-dominant (`r > 180`, `g < 90`). The legend shows "Height change".
  5. Switch the c2 ortho off and c1 on. The centre stays red, and a pixel 120 m east of the centre is green.
  6. `network` log empty (the zero-network fixture).
  7. Select the second site. The first site's rasters stay drawn only when it is the open project; otherwise they are gone and the second site's are listed (the second site has none in the fixture, so `projectRasters` is empty).
- [ ] **Step 3: Run it the CI way** (see Global constraints) with `--repeat-each=3`, then run the whole `globe.spec.ts` once.
- [ ] **Step 4: Commit:** `test(globe): processed orthos and change heat maps draw at their site`.

---

### Task 8: Two-survey change chain e2e, then the heat map on the Globe

**Files:**

- Create: `apps/desktop/e2e/photo-two-surveys-fixture.py` (like `photo-fixture.py`: `two_surveys_synth.write_project(Path(argv[1]))` and print the JSON)
- Create: `apps/desktop/e2e/photo-change.spec.ts`
- Modify, only if the run shows a defect: `apps/desktop/src/renderer/change/producers/*.ts` and its test (root cause first, with `superpowers:systematic-debugging`)

**Interfaces:**

- Consumes: Task 5's fixture output and `truth.json`; the Changes panel (`change-raster.spec.ts` and `change-cloud.spec.ts` show how they open it and run producers); the Globe switches (T6).

- [ ] **Step 1: Write the spec**, modelled on `photo-products.spec.ts` (`test.use({ appEnv: PIPELINE_ENV })`; skip without `hasPipelinePython()` or `hasPdal()`; `test.setTimeout(900_000)`):
  1. Run the fixture script with `VENV_PYTHON` into `dataRoot/projects/synthetic-two-surveys`.
  2. For each of c1 and c2, `jobs:start` `photo.products` with `{ run, products: ['cloud', 'dsm', 'ortho'], preset: 'fast', capture }`. Poll `jobs:list` until `done`, with a timeout of 360 s each, and fail with the job error.
  3. Open the project. Its manifest has, for each capture, an ortho, a DSM and a COPC cloud with that `capture`.
  4. Open the Changes panel for c1 to c2. **Run imagery change**, **Run surface change** and **Run cloud change** are enabled (no "needs ..." sentence).
  5. Run imagery change and wait for the job. The change set has a `region` item whose outline overlaps `truth.shed.outlineLocal` by at least 50 % of the shed's area. No region lies at the `openGround` points.
  6. Run surface change. A `fill` region contains `truth.pile.centreLocal`, and its fill volume is within 25 % of `truth.pile.fillM3` (Fast preset; tighten if the first runs are better). A `fill` region also covers the shed.
  7. Run cloud change. The change cloud layer exists with its `Distance` scalar. The job's summary, or the change set items, report the shed and pile above `significantM` and nothing at `openGround`.
  8. Open the Globe and select the site (it is the open project). The "Surface change" switch is listed. Turn it on: `inspect().projectRasters` has it ready, and a pixel at the pile is red-dominant. The network log is empty.
- [ ] **Step 2: Run it the CI way**, with `QUADRION_E2E_PYTHON` pointed at the main checkout's venv. Record the wall time in the commit message body. If it is over 10 minutes on this workstation, reduce `step` in the fixture (0.05 to 0.07) before anything else.
- [ ] **Step 3:** If step 4, 5, 6 or 7 fails because a producer refuses processed layers (for example `pairByName` or `own()`), write the failing unit test in the producer's `*.test.ts` first, fix the root cause, and re-run.
- [ ] **Step 4: Commit:** `test(change): two processed surveys run imagery, surface and cloud change and show on the Globe`.

---

### Task 9: Docs

**Files:**

- Modify: `docs/KNOWN-LIMITS.md` (Globe section, around line 230)
- Modify: `docs/plans/2026-10-07-m10-globe-and-photogrammetry.md` (mark the exit item and the change detection follow-up as done, with a pointer to this plan)
- Modify: `docs/architecture/data-conventions.md` (section 23, the Globe: project rasters drawn from kit pyramids, the order, the sites in focus)
- Modify: the user guide page for the Globe (find it with `grep -rl "Show on globe" docs/guide docs/user 2>/dev/null`): a short "Processed maps on the Globe" paragraph

- [ ] **Step 1:** Replace "Processed orthophotos do not show on the Globe yet, sites have no footprints and there is no date filter." with: "Processed maps (orthophotos, shaded surfaces and change heat maps) show for the open project and the site you pick, not for every site at once. COG-only and plain-image rasters and the cloud change result are not drawn on the Globe. Sites have no footprints and there is no date filter."
- [ ] **Step 2:** Make the M10 plan and data-conventions edits as listed above.
- [ ] **Step 3: Run** `pnpm prettier --write <files>`, `pnpm format:check` and `node tools/agent/check-public-text.mjs <files>`.
- [ ] **Step 4: Commit:** `docs(globe): processed maps and change heat maps on the Globe`.

---

## Verification before hand-off

1. `pnpm check` green in the worktree.
2. `pnpm demo:build --quick`, then `globe.spec.ts` and `photo-change.spec.ts` run the CI way (`QUADRION_WINDOW_SIZE=1100x720`, `QUADRION_E2E_SCALE=1`, `QUADRION_E2E_SWGL=1`, `--workers=1`), plus `network.spec.ts` and `photo-products.spec.ts` (shared fixtures and producers).
3. `cd python && uv run pytest tests/test_two_surveys_synth.py tests/test_photo_products*.py -q`.
4. `node tools/agent/finish-task.mjs`.

## How to test (for the founder)

1. Open a project that has processed photos (or process the bundled photo demo: **Process photos** in the Builder, with the Fast preset).
2. Click **Globe** in the left navigation. Find the site (search or its chip) and fly to it, and the site's orthophoto lies on the Earth where the site is, in the Street, Satellite and Natural Earth looks alike.
3. Click the site's chip. The site card has a new section, **On the Globe**, listing the orthophotos by survey date, the shaded surfaces and any change heat maps. The latest orthophoto is switched on.
4. Switch an older orthophoto on and the latest off. The picture on the Globe changes to that date.
5. In a project with two processed survey dates, run **Run surface change** in the Changes panel, then go back to the Globe. Switch on **Surface change**: the heat map lies over the orthophoto, red where material was added and blue where it was removed, with its legend in the card.
6. Pick another site that has processed maps. Its orthophoto appears too, and the open project's stays. Pick a third: the second one's maps go away.
7. Turn the network off (the **Online** switch off). Everything above still works.
