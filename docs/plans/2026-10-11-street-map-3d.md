# The 3D scene sits on the street map: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project's 3D scene opens sitting on the offline street map, sharp near the model and reaching to the horizon, with one toolbar button to turn it off and on.

**Architecture:** The single 5 km picture under the site becomes up to three nested rings drawn by one hidden MapLibre map, near ring first, each a mesh in one group (`@aio/maps`). The desktop shell sizes the rings from the stage's content, draws them once the scene is up, hides them under the landscape from packs, and replaces the Layers checkbox with a toolbar toggle that is on by default. No engine change, no schema change.

**Tech stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), three.js, MapLibre GL, React 18, zustand, vitest, Playwright on Electron.

**Spec:** `docs/plans/2026-10-11-street-map-3d-design.md`

## Global constraints

- Work only in the worktree `E:\Dev\AIO Software\.claude\worktrees\street-map-3d` on `feat/street-map-3d`. Never edit the main checkout.
- Touch only the files your task lists. Implementers do not commit: the controller commits each task (the pre-commit hook stashes, so nobody may be editing while it runs). Never `git stash`, never `--no-verify`.
- Conventional commits, subject in lower case, header and body lines at most 100 characters, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- User-facing text (strings, docs, commit subjects): no emoji, no em or en dashes, no client, site, tester or person names.
- The group in the scene keeps the name `basemap:site-street-map` (two existing specs look for it).
- The remembered choice stays in `localStorage` under `stratlas.streetMap3d`, keyed by project id. Nothing under `packages/schema` changes. No new dependency.
- Manifest `basemap` layers (`createGround` in `groundRender.ts`) are not touched.
- Local test load stays light: unit tests by file (`pnpm vitest run <file>`), one Playwright run at a time with `--workers=1`, and only the controller runs Playwright.

## Review focus

1. A ring whose rendered box does not contain the ring inside it (rounding at a pack edge): the frame must not turn inside out or overlap. Pinned in Task 1 (`ringGeometry` clamps the hole; test "a hole that sticks out is cut to the picture").
2. The button is turned off, or the project closed, while the second ring is being drawn: nothing may be added to the scene afterwards and the hidden map must go. Pinned in Task 1 (`groundRings.test.ts`, "stops when disposed while drawing").
3. A project with nothing in it yet (no model, flight or photo): the rings must still appear, sized around the origin, after the 2.5 s cap. Pinned in Task 2 (`settledBox` test "gives up waiting after the cap").
4. Rings kept from the project that was open before: a newly opened project must never draw them. Pinned in Task 2 (store test "rings belong to one project").
5. A site 6 km across: the far ring would be the same 12 km square as the middle one. Pinned in Task 2 ("leaves out a ring that adds little").

## Execution DAG

```
T1 (maps: ring geometry + ring renderer) ──┐
T2 (desktop: model, strings) ──────────────┼──> T3 (desktop: draw rings, button) ──> T4 (e2e)
T5 (docs) ── independent
```

| Batch | Tasks (dispatched in one message) | Why they can run together                                             |
| ----- | --------------------------------- | --------------------------------------------------------------------- |
| 1     | T1, T2, T5                        | No shared files: `packages/maps`, the desktop model and strings, docs |
| 2     | T3                                | Needs T1's `createStreetRings` and T2's model; touches T2's files     |
| 3     | T4                                | Needs the rings and the button in the built app                       |

**Critical path:** T1 (or T2), T3, T4.

**Packages touched:** T1 `@aio/maps`; T2 desktop shell and three strings in `@aio/ui`; T3 desktop shell, two strings removed in `@aio/ui`, one export removed in `@aio/maps`; T4 desktop e2e; T5 docs.

**Contract changes:** none. `@aio/schema` is not touched, so no row in `docs/architecture/contract-changes.md`. `@aio/maps` gains `createStreetRings` and loses `createStreetGround`; its only consumer changes in T3.

**End to end specs:** new `apps/desktop/e2e/street-map-3d.spec.ts` (T4). `video-first.spec.ts` and the stockpile spec are unchanged and must keep passing.

---

### Task 1: Ring geometry and the ring renderer (`@aio/maps`)

**Files:**

- Modify: `packages/maps/src/ground.ts` (append)
- Modify: `packages/maps/src/ground.test.ts` (append)
- Create: `packages/maps/src/groundRings.ts`
- Create: `packages/maps/src/groundRings.test.ts`
- Modify: `packages/maps/src/index.ts` (after `createStreetGround`, which stays for now)

**Interfaces:**

- Consumes: `FrameProjection` (`./geo`), `Bbox` (`./packs`), `extentBbox`, `GroundExtent` (`./ground`), `installBasemap` (`./runtime`), `buildStyle` (`./style`).
- Produces:
  - `ringGeometry(bbox: Bbox, hole: Bbox | null, proj: FrameProjection, y?: number): RingGeometry` with `RingGeometry { positions: Float32Array; uvs: Float32Array; indices: number[] }`.
  - `createStreetRings(layer, ctx, options: GroundRingsOptions): Promise<GroundRingsHandle>` exported from `@aio/maps`, with `GroundRingsOptions { extents: readonly GroundExtent[]; sizePx?: number; onRing?: (mesh: Mesh, index: number) => void }` and `GroundRingsHandle extends LayerHandle { readonly group: Group; readonly done: Promise<void> }`.

- [ ] **Step 1: Write the failing geometry tests.** Append to `packages/maps/src/ground.test.ts` (extend the import to `import { groundCorners, ringGeometry, siteBbox, type RingGeometry } from './ground';` and add `import type { FrameProjection } from './geo';`):

```ts
/** Twice the signed area of each triangle seen from above: positive when it faces up. */
function facing(g: RingGeometry): number[] {
  const at = (k: number): [number, number] => [
    g.positions[k * 3] ?? NaN,
    g.positions[k * 3 + 2] ?? NaN,
  ];
  const out: number[] = [];
  for (let i = 0; i < g.indices.length; i += 3) {
    const [px, pz] = at(g.indices[i] ?? -1);
    const [qx, qz] = at(g.indices[i + 1] ?? -1);
    const [rx, rz] = at(g.indices[i + 2] ?? -1);
    out.push((qz - pz) * (rx - px) - (qx - px) * (rz - pz));
  }
  return out;
}
const area = (g: RingGeometry) => facing(g).reduce((a, b) => a + b, 0) / 2;

describe('street ground rings', () => {
  const outer = siteBbox(proj, 2000);
  const inner = siteBbox(proj, 500);

  it('draws the near ring as one quad under the whole picture', () => {
    const g = ringGeometry(outer, null, proj, -0.2);
    expect(g.indices).toEqual([0, 3, 1, 1, 3, 2]);
    expect([...g.positions]).toEqual(
      groundCorners(outer, proj, -0.2)
        .flat()
        .map((v) => Math.fround(v)),
    );
    // top left, top right, bottom right, bottom left of the picture
    [0, 1, 1, 1, 1, 0, 0, 0].forEach((v, i) => expect(g.uvs[i]).toBeCloseTo(v, 6));
    expect(facing(g).every((f) => f > 0)).toBe(true);
    expect(area(g)).toBeGreaterThan(4000 * 4000 * 0.98);
    expect(area(g)).toBeLessThan(4000 * 4000 * 1.04);
  });

  it('draws a further ring as a frame around the ring inside it', () => {
    const g = ringGeometry(outer, inner, proj, -0.2);
    expect(g.positions.length).toBe(8 * 3);
    expect(g.indices.length).toBe(8 * 3);
    // the hole's corners are the inner ring's corners, to the last bit
    expect([...g.positions.slice(12)]).toEqual([
      ...ringGeometry(inner, null, proj, -0.2).positions,
    ]);
    expect(facing(g).every((f) => f > 0)).toBe(true);
    // nothing is drawn twice: the frame is the picture less the hole
    const want = area(ringGeometry(outer, null, proj)) - area(ringGeometry(inner, null, proj));
    expect(Math.abs(area(g) - want) / want).toBeLessThan(1e-6);
    // the hole's top left corner sits three eighths in from the picture's top left
    expect(g.uvs[8]).toBeCloseTo(0.375, 2);
    expect(g.uvs[9]).toBeCloseTo(0.625, 2);
  });

  it('places a vertex in the picture by its Web Mercator latitude', () => {
    const flat: FrameProjection = {
      toLonLat: () => [0, 0],
      toLocal: (lon, lat) => [lon, 0, -lat],
    };
    const g = ringGeometry([10, 0, 11, 60], [10.2, 30, 10.8, 31], flat);
    // inner bottom left: a fifth across, and ln(tan 60) / ln(tan 75) up
    expect(g.uvs[14]).toBeCloseTo(0.2, 6);
    expect(g.uvs[15]).toBeCloseTo(0.41709, 4);
  });

  it('cuts a hole that sticks out to the picture', () => {
    const g = ringGeometry(inner, outer, proj);
    expect(facing(g).every((f) => f >= 0)).toBe(true);
    expect(Math.abs(area(g))).toBeLessThan(1e-3);
  });
});
```

- [ ] **Step 2: Run them to see them fail.** From the worktree root: `pnpm vitest run packages/maps/src/ground.test.ts`. Expected: FAIL, `ringGeometry` is not exported.

- [ ] **Step 3: Implement `ringGeometry`.** Append to `packages/maps/src/ground.ts`:

```ts
/** One ring of the street ground: triangles in the local frame and their place in the picture. */
export interface RingGeometry {
  /** x, y, z per vertex. */
  positions: Float32Array;
  /** u, v per vertex: (0, 1) is the picture's top left (north west) corner. */
  uvs: Float32Array;
  indices: number[];
}

/** Web Mercator y of a latitude in degrees. */
function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

const QUAD = [0, 3, 1, 1, 3, 2];
/** North, east, south and west sides between the picture's corners (0 to 3) and the hole's (4 to 7). */
const FRAME = [0, 4, 1, 1, 4, 5, 5, 6, 1, 1, 6, 2, 7, 3, 6, 6, 3, 2, 0, 3, 4, 4, 3, 7];

/**
 * The ground under a north-up Web Mercator picture of `bbox`, at height `y`: one quad, or with
 * `hole` (the box of the ring inside it) a frame around that box, so nested rings never overlap.
 * Vertices are the corners (top left, top right, bottom right, bottom left) of the picture, then
 * of the hole. Each takes its place in the picture from its longitude and its Mercator latitude,
 * so the frame's inner edge shows the same ground as the edge of the ring inside it. A hole that
 * reaches outside the picture is cut to it.
 */
export function ringGeometry(
  bbox: Bbox,
  hole: Bbox | null,
  proj: FrameProjection,
  y = 0,
): RingGeometry {
  const [w, s, e, n] = bbox;
  const south = mercatorY(s);
  const height = mercatorY(n) - south;
  const positions: number[] = [];
  const uvs: number[] = [];
  const corners = ([bw, bs, be, bn]: Bbox) => {
    for (const [lon, lat] of [
      [bw, bn],
      [be, bn],
      [be, bs],
      [bw, bs],
    ] as const) {
      const [x, , z] = proj.toLocal(lon, lat);
      positions.push(x, y, z);
      uvs.push((lon - w) / (e - w), (mercatorY(lat) - south) / height);
    }
  };
  corners(bbox);
  if (hole)
    corners([
      Math.min(e, Math.max(w, hole[0])),
      Math.min(n, Math.max(s, hole[1])),
      Math.max(w, Math.min(e, hole[2])),
      Math.max(s, Math.min(n, hole[3])),
    ]);
  return {
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    indices: hole ? FRAME : QUAD,
  };
}
```

- [ ] **Step 4: Run the geometry tests.** `pnpm vitest run packages/maps/src/ground.test.ts`. Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing renderer tests.** Create `packages/maps/src/groundRings.test.ts`:

```ts
// @vitest-environment jsdom
import type { AdapterContext } from '@aio/engine';
import type { Layer, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { Scene, type Mesh } from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroundRings } from './groundRings';
import type { GroundExtent } from './ground';

type Bounds = [[number, number], [number, number]];

/** MapLibre, as far as the rings go: it draws whatever bounds it was last given, a tick later. */
const fake = vi.hoisted(() => {
  const maps: { removed: boolean; fits: number }[] = [];
  class FakeMap {
    removed = false;
    fits = 0;
    private bounds: Bounds;
    private readonly canvas = document.createElement('canvas');
    constructor(o: { bounds: Bounds }) {
      this.bounds = o.bounds;
      maps.push(this);
    }
    once(_event: string, cb: () => void) {
      setTimeout(cb, 0);
    }
    fitBounds(b: Bounds) {
      this.bounds = b;
      this.fits++;
    }
    triggerRepaint() {
      // nothing to draw
    }
    getBounds() {
      const [[w, s], [e, n]] = this.bounds;
      return { getWest: () => w, getSouth: () => s, getEast: () => e, getNorth: () => n };
    }
    getCanvas() {
      return this.canvas;
    }
    remove() {
      this.removed = true;
    }
  }
  return { maps, FakeMap };
});
vi.mock('maplibre-gl', () => ({ Map: fake.FakeMap }));
vi.mock('./runtime', () => ({ installBasemap: vi.fn() }));

// jsdom has no 2D canvas: the copy of the picture is skipped
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const layer = {
  kind: 'basemap',
  id: 'site-street-map',
  name: 'Street map',
  visible: true,
  pack: 'auto',
  style: 'dark',
} as Extract<Layer, { kind: 'basemap' }>;
const square = (h: number): GroundExtent => ({ minX: -h, maxX: h, minZ: -h, maxZ: h });
const EXTENTS = [square(500), square(2000), square(8000)];

function context() {
  const scene = new Scene();
  const ctx = {
    url: () => '',
    scene: {
      scene,
      requestRender: vi.fn(),
      renderer: { capabilities: { getMaxAnisotropy: () => 1 } },
    },
  } as unknown as AdapterContext;
  return { scene, ctx };
}

beforeEach(() => {
  fake.maps.length = 0;
  (globalThis as { aio?: unknown }).aio = {
    invoke: vi.fn(() => Promise.resolve([{ id: 'pack', maxZoom: 14 }])),
  };
  workspace.getState().openProject({
    id: 'p',
    root: '/p',
    manifest: {
      crs: { epsg: 32639 },
      origin: [245747.13, 3179641.87, 0],
      layers: [],
    } as unknown as ProjectManifest,
  });
});

describe('street ground rings in the scene', () => {
  it('adds the near ring first, then each further ring as a frame, with one hidden map', async () => {
    const { scene, ctx } = context();
    const seen: number[] = [];
    const h = await createGroundRings(layer, ctx, {
      extents: EXTENTS,
      onRing: (mesh, i) => {
        seen.push(i);
        // the group is in the scene from the first ring on
        expect(scene.getObjectByName('basemap:site-street-map')).toBe(mesh.parent);
      },
    });
    expect(scene.getObjectByName('basemap:site-street-map')).toBeUndefined();
    await h.done;
    expect(seen).toEqual([0, 1, 2]);
    const rings = h.group.children as Mesh[];
    expect(rings.map((m) => m.geometry.getAttribute('position').count)).toEqual([4, 8, 8]);
    expect(fake.maps.length).toBe(1);
    expect(fake.maps[0]?.fits).toBe(2);
    expect(fake.maps[0]?.removed).toBe(true);
    expect(document.body.children.length).toBe(0);
  });

  it('hides and shows every ring together', async () => {
    const { ctx } = context();
    const h = await createGroundRings(layer, ctx, { extents: EXTENTS });
    await h.done;
    h.setVisible(false);
    expect(h.group.visible).toBe(false);
    h.setVisible(true);
    expect(h.group.visible).toBe(true);
  });

  it('stops when disposed while drawing, and frees what it drew', async () => {
    const { scene, ctx } = context();
    const seen: number[] = [];
    const h = await createGroundRings(layer, ctx, {
      extents: EXTENTS,
      onRing: (_mesh, i) => {
        seen.push(i);
        if (i === 0) h.dispose();
      },
    });
    await h.done;
    expect(seen).toEqual([0]);
    expect(scene.getObjectByName('basemap:site-street-map')).toBeUndefined();
    expect(h.group.children.length).toBe(0);
    expect(fake.maps[0]?.removed).toBe(true);
    expect(document.body.children.length).toBe(0);
  });

  it('draws nothing without extents', async () => {
    const { scene, ctx } = context();
    const h = await createGroundRings(layer, ctx, { extents: [] });
    await h.done;
    expect(scene.children.length).toBe(0);
    expect(fake.maps.length).toBe(0);
  });
});
```

- [ ] **Step 6: Run them to see them fail.** `pnpm vitest run packages/maps/src/groundRings.test.ts`. Expected: FAIL, `./groundRings` does not exist.

- [ ] **Step 7: Implement the renderer.** Create `packages/maps/src/groundRings.ts`:

```ts
// Browser-only: the street map under a site in 3D as nested rings. One hidden MapLibre map draws
// the offline street style over each square of the local frame in turn, nearest first, and each
// picture is draped on its own mesh: a quad for the near ring, a frame around the ring inside it
// for the others (`ringGeometry`), all at one height, so the ground is sharp under the site, runs
// out to the horizon and nothing is drawn twice. Stands in for the tiled quadtree of
// tech-evaluation section 5 until that is built.
import type { AdapterContext, LayerHandle } from '@aio/engine';
import type { AioBridge, Layer } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { Map as MapLibreMap } from 'maplibre-gl';
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
} from 'three';
import { frameProjection } from './geo';
import { extentBbox, ringGeometry, type GroundExtent } from './ground';
import type { Bbox } from './packs';
import { installBasemap } from './runtime';
import { buildStyle } from './style';

const SIZE_PX = 2048;
/** The rings are built this far under the frame's zero height; the caller moves the group. */
const GROUND_Y = -0.2;

export interface GroundRingsOptions {
  /** The squares of the local frame to cover, nearest first; each contains the one before it. */
  extents: readonly GroundExtent[];
  /** Pixels across each ring's picture (default 2048). */
  sizePx?: number;
  /** A ring is in the scene (0 is the nearest). */
  onRing?: (mesh: Mesh, index: number) => void;
}

export interface GroundRingsHandle extends LayerHandle {
  /** Holds the rings; named `basemap:<layer id>`, in the scene from the first ring on. */
  readonly group: Group;
  /** Resolves when every ring is in the scene, or drawing stopped (disposed, a ring failed). */
  readonly done: Promise<void>;
}

/** Resolves when every tile is drawn, or after `timeoutMs` (a hidden window renders nothing). */
function waitIdle(map: MapLibreMap, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    map.once('idle', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Lets the scene draw a frame between two rings. */
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export async function createGroundRings(
  layer: Extract<Layer, { kind: 'basemap' }>,
  ctx: AdapterContext,
  opts: GroundRingsOptions,
): Promise<GroundRingsHandle> {
  const project = workspace.getState().project;
  const proj = project ? frameProjection(project.manifest.crs, project.manifest.origin) : null;
  const aio = (globalThis as { aio?: AioBridge }).aio;
  if (!proj || !aio) throw new Error('Street map ground needs an open project in a supported CRS');
  const packs = await aio.invoke('packs:list', {});
  if (!packs.length) throw new Error('No map packs installed');
  installBasemap(packs);

  const size = opts.sizePx ?? SIZE_PX;
  const group = new Group();
  group.name = `basemap:${layer.id}`;
  group.visible = layer.visible;
  const state = { disposed: false };
  /** Asked again after every wait: `dispose` may run while a ring is being drawn. */
  const gone = (): boolean => state.disposed;
  const bounds = (b: Bbox): [[number, number], [number, number]] => [
    [b[0], b[1]],
    [b[2], b[3]],
  ];

  const draw = async (): Promise<void> => {
    const [first] = opts.extents;
    if (!first) return;
    const host = document.createElement('div');
    host.style.cssText = `position:fixed;left:-${String(size * 2)}px;top:0;width:${String(size)}px;height:${String(size)}px;pointer-events:none`;
    document.body.appendChild(host);
    const map = new MapLibreMap({
      container: host,
      // Always the dark street style, as on every map of the app.
      style: buildStyle({ lang: 'en', maxZoom: Math.max(...packs.map((p) => p.maxZoom)) }),
      bounds: bounds(extentBbox(proj, first)),
      fitBoundsOptions: { padding: 0 },
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      pixelRatio: 1,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    try {
      let hole: Bbox | null = null;
      for (const [i, extent] of opts.extents.entries()) {
        if (i > 0) {
          map.fitBounds(bounds(extentBbox(proj, extent)), { padding: 0, animate: false });
          map.triggerRepaint();
        }
        await waitIdle(map);
        if (gone()) return;
        // The rendered bounds are what the picture shows (fitBounds keeps aspect, so read them).
        const b = map.getBounds();
        const bbox: Bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
        const canvas = document.createElement('canvas');
        const src = map.getCanvas();
        canvas.width = src.width;
        canvas.height = src.height;
        canvas.getContext('2d')?.drawImage(src, 0, 0);

        const ring = ringGeometry(bbox, hole, proj, GROUND_Y);
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(ring.positions, 3));
        geometry.setAttribute('uv', new BufferAttribute(ring.uvs, 2));
        geometry.setIndex(ring.indices);
        geometry.computeVertexNormals();
        const texture = new CanvasTexture(canvas);
        texture.colorSpace = SRGBColorSpace;
        texture.anisotropy = ctx.scene.renderer.capabilities.getMaxAnisotropy();
        const mesh = new Mesh(geometry, new MeshBasicMaterial({ map: texture }));
        mesh.name = `${group.name}:ring-${String(i)}`;
        mesh.renderOrder = -1;
        group.add(mesh);
        if (i === 0) ctx.scene.scene.add(group);
        opts.onRing?.(mesh, i);
        ctx.scene.requestRender();
        hole = bbox;
        await nextTask();
        if (gone()) return;
      }
    } finally {
      map.remove();
      host.remove();
    }
  };

  const done = draw().catch((e: unknown) => {
    console.warn('Street map ring not drawn', e);
  });

  return {
    group,
    done,
    setVisible: (v) => {
      group.visible = v;
      ctx.scene.requestRender();
    },
    dispose: () => {
      state.disposed = true;
      ctx.scene.scene.remove(group);
      for (const child of [...group.children]) {
        const mesh = child as Mesh<BufferGeometry, MeshBasicMaterial>;
        group.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.map?.dispose();
        mesh.material.dispose();
      }
      ctx.scene.requestRender();
    },
  };
}
```

- [ ] **Step 8: Export it.** In `packages/maps/src/index.ts`, after the `createStreetGround` function (leave that function in place: Task 3 removes it), add:

```ts
export type { GroundRingsHandle, GroundRingsOptions } from './groundRings';

/**
 * The street map ground under a site in 3D as nested rings (`groundRings.ts`): sharp near the
 * site, out to the horizon, without a manifest layer. MapLibre loads lazily.
 */
export async function createStreetRings(
  layer: Extract<Layer, { kind: 'basemap' }>,
  ctx: AdapterContext,
  options: GroundRingsOptions,
): Promise<GroundRingsHandle> {
  const { createGroundRings } = await import('./groundRings');
  return createGroundRings(layer, ctx, options);
}
```

and add `import type { GroundRingsHandle, GroundRingsOptions } from './groundRings';` beside the file's other type imports at the top.

- [ ] **Step 9: Run the package's tests and types.** `pnpm vitest run packages/maps` then `pnpm --filter @aio/maps exec tsc --noEmit` (if the package has no own `tsconfig`, run `pnpm typecheck` from the root instead). Expected: all pass. If `packages/maps/src/index.test.ts` lists the package's exports, add `createStreetRings` to its list.

- [ ] **Step 10: Report** the files changed and the test output. Do not commit. Controller's commit message: `feat(maps): street ground as nested rings drawn by one hidden map`.

---

### Task 2: The model: on by default, ring sizes, the landscape rule, the button's states (desktop)

**Files:**

- Modify: `apps/desktop/src/renderer/workspace/siteBasemap.ts`
- Modify: `apps/desktop/src/renderer/workspace/siteBasemap.test.ts`
- Modify: `packages/ui/src/i18n/en.ts` (the three `stage.streetMap` lines at about line 112)
- Modify: `apps/desktop/src/renderer/workspace/Stage.tsx` (the `streetMap` selector at about line 682)
- Modify: `apps/desktop/src/renderer/workspace/CompareScene.tsx` (the `streetMap` selector at about line 124)
- Modify: `apps/desktop/src/renderer/workspace/StageTools.tsx` (`StreetMapRow`, about line 431)

**Interfaces:**

- Consumes: `GroundExtent` (`@aio/maps`), `GroundModel` (`./basemap`, type only), `MessageKey` (`@aio/ui`, type only), `EngineStage` (`@aio/engine`, type only).
- Produces, all exported from `siteBasemap.ts`:
  - `siteBasemapOn(choices: Record<string, boolean>, projectId: string): boolean` (two arguments now; `siteBasemapDefault` and `hasOwnGround` are deleted).
  - `streetMapExtent(points: readonly Vec3[]): GroundExtent` (the `ownGround` argument is gone).
  - `boxPoints(box: BoxLike): Vec3[]` with `BoxLike { min: { x: number; z: number }; max: { x: number; z: number } }`.
  - `streetMapRings(near: GroundExtent): GroundExtent[]`.
  - `settledBox<B extends BoxLike>(read: () => B | null, done: (box: B | null) => void, stepMs?: number, capMs?: number): () => void`.
  - `landscapeOn(prefs: { aroundTerrain: boolean; aroundImagery: boolean }, ground: GroundModel): boolean`.
  - `interface StreetMap3d { projectId: string | null; wanted: boolean; on: boolean; covered: boolean | null; landscape: boolean; shown: boolean }`.
  - `streetMapTool(s: StreetMap3d): { label: MessageKey; pressed: boolean; disabled: boolean } | null`.
  - Store: `rings: { projectId: string; json: string } | null` and `setRings(projectId: string, json: string): void`.
  - Strings: `stage.streetMap.show`, `stage.streetMap.hide`, `stage.streetMap.landscape` (the existing `stage.streetMap`, `.tip` and `.none` stay until Task 3).

- [ ] **Step 1: Rewrite the tests.** In `siteBasemap.test.ts` replace the import and the last three tests (keep the fixtures and the first test, "is offered for every project placed on the Earth without a basemap layer"):

```ts
import type { Layer, ProjectManifest } from '@aio/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boxPoints,
  landscapeOn,
  settledBox,
  siteBasemap,
  siteBasemapOn,
  streetMapExtent,
  streetMapRings,
  streetMapTool,
  wantsSiteBasemap,
  type StreetMap3d,
} from './siteBasemap';
```

```ts
  it('starts on for every project, and a choice made with the button wins', () => {
    expect(siteBasemapOn({}, 'p')).toBe(true);
    expect(siteBasemapOn({ q: false }, 'p')).toBe(true);
    expect(siteBasemapOn({ p: false }, 'p')).toBe(false);
    expect(siteBasemapOn({ p: true }, 'p')).toBe(true);
  });

  it('covers the content with a margin', () => {
    const e = streetMapExtent([
      [100, 40, -200],
      [700, 50, 300],
    ]);
    // centred on what the content covers, a square
    expect((e.minX + e.maxX) / 2).toBeCloseTo(350, -2);
    expect(e.maxX - e.minX).toBeCloseTo(e.maxZ - e.minZ, 6);
    expect(e.minX).toBeLessThan(0);
    expect(e.maxX).toBeGreaterThan(700);
    expect(e.minZ).toBeLessThan(-200);
    expect(e.maxZ).toBeGreaterThan(300);
    expect(e.maxX - e.minX).toBeLessThan(2500);
  });

  it('keeps a useful size around the origin alone, and stops at 6 km', () => {
    const small = streetMapExtent([]);
    expect(small.maxX - small.minX).toBe(800);
    const huge = streetMapExtent([[40_000, 0, 0]]);
    expect(huge.maxX - huge.minX).toBe(12_000);
  });

  it('measures a model or a cloud by the corners of its box', () => {
    const points = boxPoints({ min: { x: -50, z: -80 }, max: { x: 900, z: 40 } });
    expect(points).toEqual([
      [-50, 0, -80],
      [900, 0, -80],
      [900, 0, 40],
      [-50, 0, 40],
    ]);
    const e = streetMapExtent(points);
    expect(e.minX).toBeLessThan(-50);
    expect(e.maxX).toBeGreaterThan(900);
  });
});

const square = (h: number, cx = 0, cz = 0) => ({
  minX: cx - h,
  maxX: cx + h,
  minZ: cz - h,
  maxZ: cz + h,
});
const half = (e: { minX: number; maxX: number }) => (e.maxX - e.minX) / 2;

describe('street map rings', () => {
  it('surrounds the near ring with rings four and sixteen times its size', () => {
    const rings = streetMapRings(square(500, 100, -50));
    expect(rings.map(half)).toEqual([500, 2000, 8000]);
    // one centre
    for (const r of rings) {
      expect((r.minX + r.maxX) / 2).toBe(100);
      expect((r.minZ + r.maxZ) / 2).toBe(-50);
    }
    expect(rings[0]).toEqual(square(500, 100, -50));
  });

  it('never reaches past 12 km', () => {
    expect(streetMapRings(square(1000)).map(half)).toEqual([1000, 4000, 12_000]);
  });

  it('leaves out a ring that adds little', () => {
    expect(streetMapRings(square(6000)).map(half)).toEqual([6000, 12_000]);
    expect(streetMapRings(square(2500)).map(half)).toEqual([2500, 10_000]);
  });
});

describe('waiting for the scene', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const box = (x: number) => ({ min: { x: 0, z: 0 }, max: { x, z: 10 } });

  it('answers once the content box has stopped changing', () => {
    vi.useFakeTimers();
    let now: ReturnType<typeof box> | null = null;
    const done = vi.fn();
    settledBox(() => now, done);
    vi.advanceTimersByTime(300);
    now = box(10);
    vi.advanceTimersByTime(300);
    now = box(40);
    vi.advanceTimersByTime(300);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(done).toHaveBeenCalledExactlyOnceWith(box(40));
    vi.advanceTimersByTime(5000);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting after the cap, with or without a box', () => {
    vi.useFakeTimers();
    const done = vi.fn();
    settledBox(() => null, done);
    vi.advanceTimersByTime(2399);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(301);
    expect(done).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('stops asking when cancelled', () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const cancel = settledBox(() => box(1), done);
    cancel();
    vi.advanceTimersByTime(5000);
    expect(done).not.toHaveBeenCalled();
  });
});

describe('the street map and the landscape from packs', () => {
  const ground = { offered: true, imagery: true, terrain: true };
  it('gives way while imagery or terrain around the site is drawn', () => {
    expect(landscapeOn({ aroundTerrain: false, aroundImagery: false }, ground)).toBe(false);
    expect(landscapeOn({ aroundTerrain: true, aroundImagery: false }, ground)).toBe(true);
    expect(landscapeOn({ aroundTerrain: false, aroundImagery: true }, ground)).toBe(true);
  });
  it('stays when the choice is on but nothing can be drawn', () => {
    const chosen = { aroundTerrain: true, aroundImagery: true };
    expect(landscapeOn(chosen, { ...ground, offered: false })).toBe(false);
    expect(landscapeOn(chosen, { offered: true, imagery: false, terrain: false })).toBe(false);
    expect(landscapeOn({ ...chosen, aroundImagery: false }, { ...ground, terrain: false })).toBe(
      false,
    );
  });
});

describe('the street map button', () => {
  const base: StreetMap3d = {
    projectId: 'p',
    wanted: true,
    on: true,
    covered: true,
    landscape: false,
    shown: true,
  };
  it('is pressed while the street map is on, and says what a click does', () => {
    expect(streetMapTool(base)).toEqual({
      label: 'stage.streetMap.hide',
      pressed: true,
      disabled: false,
    });
    expect(streetMapTool({ ...base, on: false, shown: false })).toEqual({
      label: 'stage.streetMap.show',
      pressed: false,
      disabled: false,
    });
    // still looking for a pack: it can be clicked
    expect(streetMapTool({ ...base, covered: null })?.disabled).toBe(false);
  });
  it('is greyed out with the reason', () => {
    expect(streetMapTool({ ...base, covered: false })).toEqual({
      label: 'stage.streetMap.none',
      pressed: false,
      disabled: true,
    });
    expect(streetMapTool({ ...base, landscape: true, shown: false })).toEqual({
      label: 'stage.streetMap.landscape',
      pressed: false,
      disabled: true,
    });
  });
  it('is absent for a project that cannot have the street map', () => {
    expect(streetMapTool({ ...base, wanted: false })).toBeNull();
    expect(streetMapTool({ ...base, projectId: null })).toBeNull();
  });
});

describe('the rings kept for the second view', () => {
  it('belong to one project', () => {
    siteBasemap.getState().setRings('a', '[1]');
    expect(siteBasemap.getState().rings).toEqual({ projectId: 'a', json: '[1]' });
    const kept = siteBasemap.getState().rings;
    siteBasemap.getState().setRings('a', '[1]');
    // the same rings again change nothing (no redraw)
    expect(siteBasemap.getState().rings).toBe(kept);
    siteBasemap.getState().setRings('b', '[2]');
    expect(siteBasemap.getState().rings).toEqual({ projectId: 'b', json: '[2]' });
  });
```

(The last `describe` is closed by the file's existing final `});`. Remove the old test "starts on while the project has no ground of its own, or has stockpiles" and the old "keeps a useful size around the origin alone, and the old square with own ground"; the `ortho` fixture stays, the first test uses it.)

- [ ] **Step 2: Run to see them fail.** `pnpm vitest run apps/desktop/src/renderer/workspace/siteBasemap.test.ts`. Expected: FAIL on the missing exports.

- [ ] **Step 3: Add the strings.** In `packages/ui/src/i18n/en.ts`, directly after the line `'stage.streetMap.none': 'No installed map pack covers this site',` add:

```ts
  'stage.streetMap.show': 'Show the street map under the site',
  'stage.streetMap.hide': 'Hide the street map under the site',
  'stage.streetMap.landscape':
    'The street map is hidden while imagery or terrain around the site is on (Layers)',
```

- [ ] **Step 4: Change the model.** In `siteBasemap.ts`:

Replace the file's head comment with:

```ts
/**
 * The offline street map under the site in 3D: the maps package's street rings (the app's street
 * style rendered from the installed PMTiles packs, sharp near the site and out to the horizon),
 * added for projects placed on the Earth whose manifest has no basemap layer of its own. It
 * covers what the project covers (models, clouds, flight paths, photo places, the origin) and
 * stands in for the plain ground. On for every project until turned off with the stage toolbar's
 * street map button, a choice remembered per project on this computer. It gives way to imagery
 * and terrain around the site from packs. Nothing is drawn, and nothing fails, when no installed
 * pack covers the site.
 */
```

Add to the imports: `import type { MessageKey } from '@aio/ui';` and `import type { GroundModel } from './basemap';`.

In `SiteBasemapState` add, after `covered`:

```ts
  /** The rings the main view draws for a project, as JSON: a second view draws the same. */
  rings: { projectId: string; json: string } | null;
  setRings(projectId: string, json: string): void;
```

and in the store, after `covered: null,` add `rings: null,` and after `setCovered`:

```ts
  setRings(projectId, json) {
    const cur = get().rings;
    if (cur?.projectId === projectId && cur.json === json) return;
    set({ rings: { projectId, json } });
  },
```

Delete `hasOwnGround` and `siteBasemapDefault` with their comments, and replace `siteBasemapOn` with:

```ts
/** The remembered choice for the project, else on. */
export function siteBasemapOn(choices: Record<string, boolean>, projectId: string): boolean {
  return choices[projectId] ?? true;
}
```

Delete the `LEGACY_HALF_M` constant and its comment, and replace `streetMapExtent` and its comment with:

```ts
/**
 * The square of the local frame the near ring of the street map covers: the content (models,
 * clouds, flight paths, photo places) and the origin with a margin, at least MIN_HALF_M, at most
 * MAX_HALF_M. Rounded to 50 m so small additions do not redraw it.
 */
export function streetMapExtent(points: readonly Vec3[]): GroundExtent {
  let minX = 0;
  let maxX = 0;
  let minZ = 0;
  let maxZ = 0;
  for (const [x, , z] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const step = 50;
  const cx = Math.round((minX + maxX) / 2 / step) * step;
  const cz = Math.round((minZ + maxZ) / 2 / step) * step;
  const span = Math.max(maxX - cx, cx - minX, maxZ - cz, cz - minZ);
  const half = Math.min(
    MAX_HALF_M,
    Math.max(MIN_HALF_M, Math.ceil((span * MARGIN + PAD_M) / step) * step),
  );
  return { minX: cx - half, maxX: cx + half, minZ: cz - half, maxZ: cz + half };
}

/** A box on the ground (the stage's content box). */
export interface BoxLike {
  min: { x: number; z: number };
  max: { x: number; z: number };
}

/** The corners of a content box, as points for `streetMapExtent`. */
export function boxPoints(box: BoxLike): Vec3[] {
  return [
    [box.min.x, 0, box.min.z],
    [box.max.x, 0, box.min.z],
    [box.max.x, 0, box.max.z],
    [box.min.x, 0, box.max.z],
  ];
}

/** Each ring is this many times the size of the ring inside it. */
const RING_STEP = 4;
/** No ring reaches further from its centre than this, metres (the camera sees 20 km). */
const MAX_RING_HALF_M = 12_000;
/** A ring less than this many times the ring inside it adds too little to be drawn. */
const MIN_RING_GROWTH = 1.5;

/**
 * The squares the street map is drawn in, nearest first: `near` (sharp, under the content), then
 * up to two more around the same centre, so the map runs out to the horizon without one picture
 * having to cover everything.
 */
export function streetMapRings(near: GroundExtent): GroundExtent[] {
  const cx = (near.minX + near.maxX) / 2;
  const cz = (near.minZ + near.maxZ) / 2;
  const half = (near.maxX - near.minX) / 2;
  const rings = [near];
  let last = half;
  for (let k = 1; k <= 2; k++) {
    const h = Math.min(MAX_RING_HALF_M, half * RING_STEP ** k);
    if (h < last * MIN_RING_GROWTH) break;
    rings.push({ minX: cx - h, maxX: cx + h, minZ: cz - h, maxZ: cz + h });
    last = h;
  }
  return rings;
}

/**
 * Wait for the scene to be up: `done` gets the content box once two readings `stepMs` apart are
 * the same (to the metre), or whatever it is after `capMs` (null for a project with nothing in
 * it yet). The street map is drawn after that, so it never holds up the first frames, and is
 * sized by what was loaded. Returns a function that stops the wait.
 */
export function settledBox<B extends BoxLike>(
  read: () => B | null,
  done: (box: B | null) => void,
  stepMs = 300,
  capMs = 2400,
): () => void {
  let last: string | null = null;
  let waited = 0;
  const timer = setInterval(() => {
    waited += stepMs;
    const box = read();
    const key = box
      ? [box.min.x, box.min.z, box.max.x, box.max.z].map((v) => Math.round(v)).join()
      : null;
    if ((key !== null && key === last) || waited >= capMs) {
      clearInterval(timer);
      done(box);
      return;
    }
    last = key;
  }, stepMs);
  return () => {
    clearInterval(timer);
  };
}

/**
 * Imagery or terrain around the site is drawn (the landscape from packs, `siteTiles.ts`): the
 * street map gives way, because the landscape follows the terrain and a flat map would cut
 * through it.
 */
export function landscapeOn(
  prefs: { aroundTerrain: boolean; aroundImagery: boolean },
  ground: GroundModel,
): boolean {
  return (
    ground.offered &&
    ((prefs.aroundTerrain && ground.terrain) || (prefs.aroundImagery && ground.imagery))
  );
}

/** The street map of the open project's 3D view, for the layer and its button. */
export interface StreetMap3d {
  projectId: string | null;
  /** The project can have it (placed on the Earth, no basemap layer of its own). */
  wanted: boolean;
  /** The choice: remembered, else on. */
  on: boolean;
  /** A pack covers the site: null while unknown. */
  covered: boolean | null;
  /** The landscape from packs is drawn instead. */
  landscape: boolean;
  /** Draw it (given a covering pack). */
  shown: boolean;
}

/** The toolbar button: its label, whether it is pressed or greyed out; null when there is none. */
export function streetMapTool(
  s: StreetMap3d,
): { label: MessageKey; pressed: boolean; disabled: boolean } | null {
  if (!s.projectId || !s.wanted) return null;
  if (s.covered === false) return { label: 'stage.streetMap.none', pressed: false, disabled: true };
  if (s.landscape) return { label: 'stage.streetMap.landscape', pressed: false, disabled: true };
  return {
    label: s.on ? 'stage.streetMap.hide' : 'stage.streetMap.show',
    pressed: s.on,
    disabled: false,
  };
}
```

Note on the cap: with `stepMs` 300 the readings fall at 300, 600 ... 2400 ms, so `capMs = 2400` ends the wait on the eighth reading (the spec's "2.5 s").

In `useSiteBasemapLayer`, the extent effect calls `streetMapExtent(points, own)` twice and reads `hasOwnGround`: change both calls to `streetMapExtent(points)` and `streetMapExtent([])`, and delete the `const own = hasOwnGround(manifest);` line. Nothing else in the hook changes in this task.

- [ ] **Step 5: Update the three call sites.** Each drops `siteBasemapDefault` (and, where it is then unused, `hasVolumes` / `volumes` / `defaultOn` and the `useVolumetric` import if nothing else in the file uses it):

`Stage.tsx` (about line 680), replace the `hasVolumes` line and the selector with:

```ts
const streetMap = useSiteBasemap((s) => (project ? siteBasemapOn(s.choices, project.id) : false));
```

and remove `siteBasemapDefault,` from the `./siteBasemap` import. `Stage.tsx` uses `useVolumetric` elsewhere (`StageToolbar`), so that import stays.

`CompareScene.tsx` (about line 122), the same replacement; remove `siteBasemapDefault,` from the import. Check whether `hasVolumes` or `useVolumetric` is still used below in the file (the `volumetric.getState()` call in the next effect uses `volumetric`, not the hook) and remove what is unused.

`StageTools.tsx`, in `StreetMapRow`: delete the `volumes` and `defaultOn` constants and change the selector to `projectId ? siteBasemapOn(s.choices, projectId) : false`; remove `siteBasemapDefault,` from the import. `useVolumetric` may still be used elsewhere in the file: remove its import only if the linter says it is unused.

- [ ] **Step 6: Run the tests and the types.** `pnpm vitest run apps/desktop/src/renderer/workspace/siteBasemap.test.ts packages/ui/src/i18n` then `pnpm typecheck` and `pnpm lint` from the root (or the narrowest equivalents the root `package.json` offers). Expected: all pass, no unused imports.

- [ ] **Step 7: Report** the files changed and the output. Do not commit. Controller's commit message: `feat(desktop): the 3D street map starts on, with ring sizes and the button's states`.

---

### Task 3: Draw the rings and put the button on the toolbar (desktop)

**Files:**

- Create: `apps/desktop/src/renderer/workspace/streetMap3d.ts`
- Create: `apps/desktop/src/renderer/workspace/StreetMapTool.tsx`
- Modify: `apps/desktop/src/renderer/workspace/siteBasemap.ts` (`useSiteBasemapLayer`)
- Modify: `apps/desktop/src/renderer/workspace/Stage.tsx` (the hook call, the toolbar's `display` group and `content` key)
- Modify: `apps/desktop/src/renderer/workspace/CompareScene.tsx` (the hook call)
- Modify: `apps/desktop/src/renderer/workspace/StageTools.tsx` (remove `StreetMapRow`)
- Modify: `packages/ui/src/i18n/en.ts` (remove `stage.streetMap` and `stage.streetMap.tip`)
- Modify: `packages/maps/src/index.ts` (remove `createStreetGround`)

**Interfaces:**

- Consumes: `createStreetRings`, `GroundRingsHandle` (Task 1); everything Task 2 produces; `useGround`, `useRasterPacks` (`./siteTiles`); `useGraphics` (`../graphics`); `Tool` (`./StageTools`).
- Produces: `useStreetMap3d(): StreetMap3d` (`streetMap3d.ts`), `StreetMapTool` (`StreetMapTool.tsx`, `data-testid="street-map-3d"`), `useSiteBasemapLayer(stage, project, shown, probe?)` drawing rings.

- [ ] **Step 1: The hook that reads the model.** Create `streetMap3d.ts`:

```ts
/**
 * The street map of the open project's 3D view, read from the stores: the remembered choice
 * (`siteBasemap.ts`), the pack that covers the site, and the landscape from packs it gives way to
 * (`siteTiles.ts`). The layer (`useSiteBasemapLayer`) and the toolbar button share it.
 */
import { useWorkspace } from '@aio/workspace';
import {
  landscapeOn,
  siteBasemapOn,
  useSiteBasemap,
  wantsSiteBasemap,
  type StreetMap3d,
} from './siteBasemap';
import { useGround, useRasterPacks } from './siteTiles';

export function useStreetMap3d(): StreetMap3d {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const wanted = useWorkspace((s) => (s.project ? wantsSiteBasemap(s.project.manifest) : false));
  const on = useSiteBasemap((s) => (projectId ? siteBasemapOn(s.choices, projectId) : false));
  const covered = useSiteBasemap((s) => s.covered);
  const landscape = landscapeOn(
    useRasterPacks((s) => s.prefs),
    useGround(),
  );
  return { projectId, wanted, on, covered, landscape, shown: wanted && on && !landscape };
}
```

- [ ] **Step 2: The button.** Create `StreetMapTool.tsx`:

```tsx
import { useT } from '@aio/ui';
import { siteBasemap, streetMapTool } from './siteBasemap';
import { Tool } from './StageTools';
import { useStreetMap3d } from './streetMap3d';

/**
 * The street map under the site in 3D, on and off in one click. Greyed out, with the reason as
 * its label, when no installed pack covers the site or the landscape from packs is drawn instead;
 * absent for a project that cannot have it.
 */
export function StreetMapTool() {
  const t = useT();
  const state = useStreetMap3d();
  const tool = streetMapTool(state);
  const { projectId, on } = state;
  if (!tool || !projectId) return null;
  return (
    <Tool
      icon="map"
      label={t(tool.label)}
      pressed={tool.pressed}
      disabled={tool.disabled}
      testId="street-map-3d"
      onClick={() => {
        siteBasemap.getState().set(projectId, !on);
      }}
    />
  );
}
```

(Take `useT` from wherever `StageTools.tsx` imports it.)

- [ ] **Step 3: Draw rings in `useSiteBasemapLayer`.** In `siteBasemap.ts` change the imports: `createStreetGround` becomes `createStreetRings`, add `type GroundRingsHandle` from `@aio/maps`, add `useRef` from `react`, add `import { useGraphics } from '../graphics';`, and drop `LayerHandle` and `Mesh` if they are then unused. Replace everything in the hook after the `covered` effect (from `const covered = ...` to the end of the function) with:

```ts
  const covered = useSiteBasemap((s) => s.covered);
  const active = !!stage && !!projectId && !!manifest && wanted && on && !!covered;
  // the Low tier (the software renderer) draws smaller pictures
  const sizePx = useGraphics((s) => (s.tier === 'low' ? 1024 : 2048));
  // the floor is read from the newest manifest without redrawing the rings for every change of it
  const manifestNow = useRef(manifest);
  useEffect(() => {
    manifestNow.current = manifest;
  }, [manifest]);

  // what the rings cover: the models, clouds, flights, photos and the origin, measured once the
  // scene is up, and again as data is added (the same rings again change nothing)
  useEffect(() => {
    if (!probe || !active) return;
    let live = true;
    const points = contentPoints(projectId, manifest).catch((): Vec3[] => []);
    const stop = settledBox(
      () => stage.contentBounds(),
      (box) => {
        void points.then((p) => {
          if (!live) return;
          const near = streetMapExtent([...p, ...(box ? boxPoints(box) : [])]);
          siteBasemap.getState().setRings(projectId, JSON.stringify(streetMapRings(near)));
        });
      },
    );
    return () => {
      live = false;
      stop();
    };
  }, [probe, active, stage, projectId, manifest]);

  const rings = useSiteBasemap((s) => (s.rings?.projectId === projectId ? s.rings.json : null));

  useEffect(() => {
    if (!active || !rings) return;
    let handle: GroundRingsHandle | null = null;
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const offs: (() => void)[] = [];
    const layer = {
      kind: 'basemap',
      id: SITE_BASEMAP_ID,
      name: 'Street map',
      visible: true,
      pack: 'auto',
      style: 'dark',
    } as Extract<Layer, { kind: 'basemap' }>;
    const ctx = {
      url: (ref: Parameters<typeof assetUrl>[1]) => assetUrl(projectId, ref),
      scene: stage,
    };
    createStreetRings(layer, ctx, {
      extents: JSON.parse(rings) as GroundExtent[],
      sizePx,
      onRing(mesh, index) {
        if (disposed) return;
        // never pickable: clicks on the street map are clicks on empty ground
        mesh.raycast = () => undefined;
        // projected video lands on the streets
        offs.push(stage.addProjectionReceiver(mesh));
        const group = mesh.parent;
        if (index > 0 || !group) return;
        // it is the ground now, from the first ring on: the plain ground goes
        group.userData.aioGround = true;
        offs.push(stage.addRaycastTarget(group, SITE_BASEMAP_ID));
        // terrain loads in its own time: settle under it as it arrives
        let tries = 0;
        const place = () => {
          const floor = manifestNow.current ? contentFloor(stage, manifestNow.current) : null;
          const y = Math.min(-0.25, (floor ?? 0) - 0.4);
          if (group.position.y !== y + 0.2) {
            // the rings are built at y = -0.2
            group.position.y = y + 0.2;
            group.updateMatrixWorld(true);
            stage.requestRender();
          }
          if (++tries > 20 && timer) clearInterval(timer);
        };
        place();
        timer = setInterval(place, 1500);
      },
    }).then(
      (h) => {
        if (disposed) h.dispose();
        else handle = h;
      },
      (e: unknown) => {
        console.warn('Street map under the site not drawn', e);
      },
    );
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      for (const off of offs) off();
      handle?.dispose();
    };
  }, [active, stage, projectId, rings, sizePx]);
}
```

Update the hook's doc comment: it draws the street map rings in `stage` while `on` (the caller passes `shown` of `useStreetMap3d`); the main view (`probe`) looks up the covering pack and sizes the rings, a second view reads both. Delete the old `extent` state and its effect.

- [ ] **Step 4: Wire the views.** In `Stage.tsx` replace the `streetMap` selector and the hook call with:

```ts
const streetMap = useStreetMap3d();
useSiteBasemapLayer(engine, project, streetMap.shown);
```

In `CompareScene.tsx` the same with `stage` and `false`:

```ts
const streetMap = useStreetMap3d();
useSiteBasemapLayer(stage, project, streetMap.shown, false);
```

Import `useStreetMap3d` from `./streetMap3d` in both and drop the imports that are now unused (`siteBasemapOn`, `useSiteBasemap`).

- [ ] **Step 5: The toolbar.** In `Stage.tsx`'s `StageToolbar`:

The `display` case of `render` becomes:

```tsx
      case 'display':
        return (
          <>
            <DisplayTools stage={stage} map={map} />
            {!map && <StreetMapTool />}
          </>
        );
```

Add the street map to what the fitter measures by, so a folded group is measured again when the button comes or goes: after the `volumeDates` line add

```ts
const streetMapTool = useWorkspace((s) =>
  s.project && wantsSiteBasemap(s.project.manifest) ? 1 : 0,
);
```

and add `streetMapTool` to the `content` array. Import `StreetMapTool` from `./StreetMapTool` and `wantsSiteBasemap` from `./siteBasemap`.

- [ ] **Step 6: Remove what the button replaces.** In `StageTools.tsx` delete `StreetMapRow` with its comment and the `{!map && <StreetMapRow />}` line, and the imports only it used (`siteBasemap`, `siteBasemapOn`, `useSiteBasemap`, `wantsSiteBasemap`, perhaps `useVolumetric`: let the linter say). In `en.ts` delete the `'stage.streetMap'` and `'stage.streetMap.tip'` lines. In `packages/maps/src/index.ts` delete `createStreetGround` and its comment (and the `GroundExtent` type import at the top if nothing else in the file uses it; the re-export line stays).

- [ ] **Step 7: Check.** `pnpm vitest run apps/desktop/src/renderer/workspace packages/maps packages/ui/src/i18n`, then `pnpm typecheck` and `pnpm lint`. Expected: all pass. Search for leftovers: `rg "stage\.streetMap'|stage\.streetMap\.tip|createStreetGround|siteBasemapDefault|hasOwnGround" apps packages` returns nothing.

- [ ] **Step 8: Commit** (controller): `feat(desktop): the 3D scene opens on the street map, with a toolbar button`.

---

### Task 4: End to end (desktop)

**Files:**

- Create: `apps/desktop/e2e/street-map-3d.spec.ts`

**Interfaces:**

- Consumes: `createDataRoot`'s tiny project (`e2e-tiny`, a 1 m quad, EPSG 32639, origin 500000, 3200000), `pmtilesArchive` and `tilesOver` (`../src/main/testing`), the group name `basemap:site-street-map`, `data-testid="street-map-3d"`, the labels of Task 2.

- [ ] **Step 1: Write the spec.**

```ts
/**
 * The 3D scene sits on the street map. The tiny project (a model on the ground, placed on the
 * Earth) with a synthetic street pack over its site (empty vector tiles: valid, nothing drawn)
 * opens with the street map under it: the rings in the scene, nearest first, instead of the plain
 * ground, and the toolbar button pressed. The button takes it away and brings it back, and the
 * choice is kept for the project. In the smallest window the button is under More tools.
 */
import { toWgs84 } from '@aio/geo';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pmtilesArchive, tilesOver } from '../src/main/testing';
import { expect, test as base, tinyManifest, type DataRoot } from './fixtures';

const NAME = 'E2E tiny project';

interface Probe {
  __stratlas: {
    stage(): {
      scene: {
        getObjectByName(n: string): { visible: boolean; children: unknown[] } | undefined;
      };
    } | null;
  };
}

/** A street pack over the tiny project's site, down to street zoom. */
async function writePack(data: DataRoot): Promise<void> {
  const m = tinyManifest();
  const epsg = 'epsg' in m.crs ? m.crs.epsg : 0;
  const [lon, lat] = toWgs84([m.origin[0], m.origin[1], 0], epsg);
  const bbox: [number, number, number, number] = [lon - 0.03, lat - 0.03, lon + 0.03, lat + 0.03];
  const archive = pmtilesArchive({
    tiles: tilesOver(bbox, 0, 14, () => Buffer.alloc(0)),
    bbox,
    minZoom: 0,
    maxZoom: 14,
  });
  await writeFile(join(data.root, 'packs', 'e2e-site.pmtiles'), archive);
  await writeFile(
    join(data.root, 'packs', 'e2e-site.json'),
    JSON.stringify({
      id: 'e2e-site',
      label: 'E2E site streets',
      bbox,
      maxZoom: 14,
      sizeBytes: archive.length,
    }),
  );
}

const test = base.extend<{ dataRoot: DataRoot }>({
  dataRoot: async ({ dataRoot }, use) => {
    await writePack(dataRoot);
    await use(dataRoot);
  },
});

test.setTimeout(180_000);

/** The street map group's rings and whether the plain ground is drawn. */
const ground = (win: Page) =>
  win.evaluate(() => {
    const scene = (window as unknown as Probe).__stratlas.stage()?.scene;
    const group = scene?.getObjectByName('basemap:site-street-map');
    return {
      rings: group?.visible ? group.children.length : 0,
      plain: scene?.getObjectByName('env:ground')?.visible ?? null,
    };
  });

const stageBar = (win: Page) => win.getByRole('toolbar', { name: 'Stage tools' });

async function openProject(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: NAME }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible({ timeout: 30_000 });
}

/** The street map button, on the bar or under More tools when its group is folded there. */
async function streetButton(win: Page) {
  const button = win.getByTestId('street-map-3d');
  if (!(await button.isVisible()))
    await stageBar(win).getByRole('button', { name: 'More tools', exact: true }).click();
  await expect(button).toBeVisible();
  return button;
}

test('a project opens on the street map, and the button takes it away and brings it back', async ({
  win,
}) => {
  await openProject(win);

  // on by default, though the project has a model of its own: the near ring first, then the rest
  await expect.poll(() => ground(win), { timeout: 60_000 }).toMatchObject({ plain: false });
  await expect.poll(async () => (await ground(win)).rings, { timeout: 90_000 }).toBe(3);

  const button = await streetButton(win);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toHaveAccessibleName('Hide the street map under the site');
  // the Layers popover no longer has the checkbox
  await expect(win.getByText('Street map under the site', { exact: true })).toHaveCount(0);

  // off: the rings go and the plain ground is back
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(button).toHaveAccessibleName('Show the street map under the site');
  await expect.poll(() => ground(win), { timeout: 15_000 }).toEqual({ rings: 0, plain: true });

  // the choice is kept for the project: after a reload it opens without the street map
  await win.reload();
  await openProject(win);
  const again = await streetButton(win);
  await expect(again).toHaveAttribute('aria-pressed', 'false');
  // longer than the wait for the scene and the first ring took above
  await win.waitForTimeout(6000);
  expect(await ground(win)).toEqual({ rings: 0, plain: true });

  // and on again
  await again.click();
  await expect(again).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => ground(win), { timeout: 60_000 }).toMatchObject({ plain: false });
  await expect.poll(async () => (await ground(win)).rings, { timeout: 90_000 }).toBe(3);
});

test.describe('the smallest window', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } });

  test('the street map button is under More tools and works from there', async ({ win }) => {
    await openProject(win);
    await expect.poll(() => ground(win), { timeout: 60_000 }).toMatchObject({ plain: false });
    const bar = stageBar(win);
    // Labels and layers is the first group to fold at this width
    const more = bar.getByRole('button', { name: 'More tools', exact: true });
    await expect(more).toBeVisible({ timeout: 30_000 });
    await expect(win.getByTestId('street-map-3d')).toHaveCount(0);
    await more.click();
    const button = win.getByTestId('street-map-3d');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await button.click();
    await expect.poll(() => ground(win), { timeout: 15_000 }).toEqual({ rings: 0, plain: true });
  });
});
```

- [ ] **Step 2: Run it** from `apps/desktop`, default window, on the hardware GPU: `npx playwright test e2e/street-map-3d.spec.ts --workers=1`. Expected: 2 passed. If the app is launched from a build, build first the way the other specs need (`pnpm --filter desktop build` or what `apps/desktop/package.json` names for e2e).

- [ ] **Step 3: Run it the CI way** (PowerShell): `$env:QUADRION_WINDOW_SIZE = '1100x700'; $env:QUADRION_E2E_SWGL = '1'; npx playwright test e2e/street-map-3d.spec.ts e2e/video-first.spec.ts --workers=1`. Expected: all pass. In the 1100 x 700 run the first test finds the button under More tools through `streetButton`.

- [ ] **Step 4: The specs that look at the stage, the CI way, one run at a time:** `perf`, `shell`, `small-window`, `panels`, `measure-tools`, `compare`. Expected: as on `main` (run a failing spec on `main`'s build before blaming this branch).

- [ ] **Step 5: Commit** (controller): `test(desktop): the 3D scene on the street map, end to end`.

---

### Task 5: Docs

**Files:**

- Modify: `docs/guide/03-scene.md` (line 30)
- Modify: `docs/guide/06-maps.md` (line 32)
- Modify: `docs/TESTING.md` (line 290)
- Modify: `docs/KNOWN-LIMITS.md` (line 31)

- [ ] **Step 1: `docs/guide/03-scene.md`.** In the bullet that starts "In the stage toolbar, **Layers and issue pins** turns kinds on and off", end the list at "**Video clips**." (remove ", and **Street map under the site** in 3D") and add this bullet directly after it:

```md
- The 3D view sits on the offline street map wherever an installed map pack covers the site: sharp under the site and running out to the horizon. The street map button in the same toolbar group (**Hide the street map under the site**) takes it away and brings it back; the choice is remembered for the project on this computer. In a narrow window the button is under **More tools**. See [Maps](06-maps.md).
```

- [ ] **Step 2: `docs/guide/06-maps.md`.** Replace the bullet that starts "**Street map under the site** lays the street map" with:

```md
- **The street map under the site in 3D** is on for every project a pack covers. Turn it off and on with the street map button in the stage toolbar (under **More tools** in a narrow window); the choice is remembered for the project on this computer. The button is greyed out when no installed pack covers the site, and while **Imagery around the site** or **Terrain around the site** is on: that landscape follows the terrain and takes the street map's place.
```

- [ ] **Step 3: `docs/TESTING.md`.** Replace the checklist line that starts "- [ ] The street map lies under the site in 3D." with:

```md
- [ ] A project opens in 3D on the street map (also one with its own ortho, model or point cloud): sharp under the site, out to the horizon. The street map button in the stage toolbar (under **More tools** in a narrow window) turns it off and on, and the choice is still there after reopening the project. With **Imagery around the site** or **Terrain around the site** on, the street map gives way and the button is greyed out with the reason.
```

- [ ] **Step 4: `docs/KNOWN-LIMITS.md`.** Replace the line that starts "- The street map under the" (line 31) with:

```md
- The street map under a site in 3D is flat: it lies just under the lowest model and does not follow the terrain (turn on **Terrain around the site** for a landscape that does). It is drawn as up to three nested pictures, so street names can be cut where two of them meet, and far from the site it is coarser.
```

- [ ] **Step 5: Check.** `pnpm prettier --check docs/guide/03-scene.md docs/guide/06-maps.md docs/TESTING.md docs/KNOWN-LIMITS.md` and `node tools/agent/check-public-text.mjs docs/guide/03-scene.md docs/guide/06-maps.md docs/TESTING.md docs/KNOWN-LIMITS.md docs/plans/2026-10-11-street-map-3d-design.md docs/plans/2026-10-11-street-map-3d.md`. Expected: both clean. If the guide has a check for links or headings (`pnpm check` runs it), the new link `06-maps.md` exists.

- [ ] **Step 6: Report.** Do not commit. Controller's commit message: `docs: the 3D scene sits on the street map`.

---

## Hand-off

After Task 4: `pnpm check` green in the worktree, the CI-way runs of Task 4 listed with their results, then `node tools/agent/finish-task.mjs` (after the Orchestrator says `fix/split-view-parity` is on `main`, so the rebase lands on it) and the hand-off message to the Orchestrator.

## How to test (for the founder)

1. Open any project that has a street map pack over its site (Settings, Offline maps shows which do). The 3D view opens with the dark street map under the model, sharp close up, reaching to the horizon.
2. In the stage toolbar, in the **Labels and layers** group (or under **More tools** when the window is narrow), click the map button: "Hide the street map under the site". The map goes and the plain ground is back. Click again: it returns.
3. Turn it off, go back to Projects and open the project again: it is still off. Turn it back on.
4. In **Layers and issue pins**, turn on **Terrain around the site** (needs a terrain pack and Medium graphics): the street map gives way to the landscape and the button is greyed out with the reason. Turn it off: the street map is back.
5. Open **Compare dates** on a project with two survey dates: both panes show the street map, or neither.
