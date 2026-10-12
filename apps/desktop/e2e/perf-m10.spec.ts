/**
 * M10 performance budgets, the CI-sized proxy (D7, plan 2026-10-12-m10-hardening-and-docs.md).
 *
 * CI renders on the software GPU (SwiftShader) on two vCPUs, so it cannot show the 30 fps target
 * nor hold a 500 M point cloud or a 20 M triangle tileset. What it can show is that the budgets
 * hold however large the data is, so the tier is forced to Medium and the data is made larger
 * than the caps:
 *
 * - Tiles: an 85 tile quadtree of the 12 800 triangle `gridGlb` (about 1.1 M triangles, 20 MB) in
 *   the tiny project, with the Medium tile cache scaled to 1 % (3.8 MB) through the renderer hook
 *   `window.__stratlas.tiles`, so the data is about five times the cap. A recorded path
 *   (e2e/perf/tiles-quad.path.json) is flown; every frame the cache stays under the scaled cap
 *   (four tiles of slack: tiles in view are never evicted, and downloads under way land past the cap) and the error target
 *   is Medium's 12 px; loading settles; the frame p95 stays under QUADRION_PERF_M10_P95_MS.
 * - Points: the 16 000 point COPC fixture with the point cap at 4 000: drawn points never pass it.
 * - Globe: the synthetic library (five placed sites, two region packs, terrain on at Medium)
 *   flown over sites A, B and C (e2e/perf/globe.path.json); the frame p95 stays under
 *   QUADRION_PERF_GLOBE_P95_MS; no network.
 *
 * Ceilings: both start at 400 ms (the Low synthetic budget in perf.spec.ts is 250 ms). Once three
 * CI runs of the shard holding this spec exist, set both to twice the median CI p95 (never below
 * the worst measured) and note the runs here. Three local runs on 12 Oct 2026 (Windows
 * workstation, SwiftShader, 1100 x 720, scale 1): tiles p95 50.0, 33.4 and 33.4 ms (cache peak
 * 3.99 MB of 3.84 MB, one tile over); Globe p95 100.0, 116.6 and 100.1 ms; points peak 2,297.
 *
 * The real targets (30 fps, 500 M points, 20 M triangles) are the opt-in benchmark
 * perf-m10-bench.spec.ts on real hardware. Run with --workers=1.
 */
import { TilesetsFile, ProjectManifest, type ProjectManifestInput } from '@aio/schema';
import { test as base, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDataRoot,
  expect,
  launchApp,
  NetworkGuard,
  SOFTWARE_GPU,
  tinyGlb,
  tinyManifest,
  type DataRoot,
} from './fixtures';
import { TILES_BUDGETS } from '@aio/tiles';
import { gridGlb } from './gridGlb';
import { createGlobeLibrary, GLOBE_SITES } from './m10Fixtures';
import { QUADTREE_TO_LOCAL, writeQuadtreeTileset } from './quadtreeTileset';

const TILES_P95_MS = Number(process.env.QUADRION_PERF_M10_P95_MS ?? 400);
const GLOBE_P95_MS = Number(process.env.QUADRION_PERF_GLOBE_P95_MS ?? 400);
/** The Medium tile cache scaled to 1 %: 3.84 MB, about a fifth of the quadtree. */
const BUDGET_SCALE = 0.01;
const MEDIUM_ERROR_TARGET = 12;
/** Tiles the cache may hold past its cap (see the cache assertion). */
const SLACK_TILES = 4;
const POINT_CAP = 4000;
const COPC = join(import.meta.dirname, '../../../packages/pointcloud/test-data/synthetic.copc.laz');
const TILESET_ID = 'perf-quad';
const DEPTH = 4;
const HALF_M = 30;

interface View {
  position: [number, number, number];
  target: [number, number, number];
}
interface CameraPath {
  durationMs: number;
  keys: View[];
}
interface GlobeKey {
  site: number;
  height: number;
  heading: number;
  pitch: number;
}
interface GlobePath {
  durationMs: number;
  keys: GlobeKey[];
}
interface TileStats {
  cachedBytes: number;
  maxBytes: number;
  errorTarget: number;
  loadProgress: number;
}
interface Flight {
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  fps: number;
  maxPoints: number;
  maxCached: number;
  maxBytes: number;
  errorTargets: number[];
}

interface PerfW {
  __stratlas: {
    stage(): {
      restoreView(v: View, animate?: boolean): void;
      perfStats(): { points: number; calls: number; gpuBytes: number };
    } | null;
    graphics(): {
      getState(): { tier: string; renderer: string | null; setOverride(t: string | null): void };
    };
    tiles: { stats(): TileStats[]; setBudgetScale(s: number): void; budgetScale(): number };
    pointcloud: { getState(): { setBudgetCap(n: number): void; budgetCap: number } };
  };
}

const readPath = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'perf', name), 'utf8'));

/** The 95th percentile and friends of sorted frame times. */
function summary(dts: number[]) {
  const s = [...dts].sort((a, b) => a - b);
  const pct = (q: number) => s[Math.min(s.length - 1, Math.ceil((q / 100) * s.length) - 1)] ?? 0;
  const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
  return {
    frames: s.length,
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    worst: s.at(-1) ?? 0,
    fps: 1000 / mean,
  };
}

/**
 * Fly the site view along `path` inside the page, one view per animation frame (the sampler of
 * perf.spec.ts), reading the tile stats and the drawn points every frame.
 */
async function flySite(win: Page, path: CameraPath): Promise<Flight> {
  const raw = await win.evaluate(async (p) => {
    const w = window as unknown as PerfW;
    const stage = w.__stratlas.stage();
    if (!stage) throw new Error('no stage');
    const lerp = (a: number[], b: number[], t: number) =>
      a.map((v, i) => v + ((b[i] ?? v) - v) * t);
    const smooth = (t: number) => t * t * (3 - 2 * t);
    const at = (t: number): View => {
      const seg = Math.min(p.keys.length - 2, Math.floor(t * (p.keys.length - 1)));
      const k0 = p.keys[seg];
      const k1 = p.keys[seg + 1];
      if (!k0 || !k1) throw new Error('bad path');
      const u = smooth(t * (p.keys.length - 1) - seg);
      return {
        position: lerp(k0.position, k1.position, u) as View['position'],
        target: lerp(k0.target, k1.target, u) as View['target'],
      };
    };
    const stamps: number[] = [];
    let maxPoints = 0;
    let maxCached = 0;
    let maxBytes = 0;
    const errorTargets = new Set<number>();
    await new Promise<void>((done) => {
      let t0 = -1;
      const step = (now: number) => {
        if (t0 < 0) t0 = now;
        const t = Math.min(1, (now - t0) / p.durationMs);
        stamps.push(now);
        maxPoints = Math.max(maxPoints, stage.perfStats().points);
        for (const s of w.__stratlas.tiles.stats()) {
          maxCached = Math.max(maxCached, s.cachedBytes);
          maxBytes = Math.max(maxBytes, s.maxBytes);
          errorTargets.add(s.errorTarget);
        }
        stage.restoreView(at(t), false);
        if (t < 1) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    const dts = stamps.slice(1).map((s, i) => s - (stamps[i] ?? s));
    return { dts, maxPoints, maxCached, maxBytes, errorTargets: [...errorTargets] };
  }, path);
  return { ...summary(raw.dts), ...raw };
}

/** The tiny project with the COPC fixture and the quadtree tileset, written before launch. */
async function tilesRoot(): Promise<{ root: DataRoot; bytesPerTile: number }> {
  const root = await createDataRoot();
  const dir = root.projectDir;
  await mkdir(join(dir, 'clouds'), { recursive: true });
  await copyFile(COPC, join(dir, 'clouds', 'synthetic.copc.laz'));
  const glb = gridGlb();
  await writeQuadtreeTileset(join(dir, 'tiles', TILESET_ID), { depth: DEPTH, glb, halfM: HALF_M });
  const file = TilesetsFile.parse({
    schema: 'aio.tilesets/1',
    entries: [
      {
        id: TILESET_ID,
        name: 'Performance quadtree (synthetic)',
        kind: 'mesh',
        src: `tiles/${TILESET_ID}/tileset.json`,
        visible: true,
        transform: QUADTREE_TO_LOCAL,
      },
    ],
  });
  await writeFile(join(dir, 'tilesets.json'), JSON.stringify(file, null, 2));
  const m = tinyManifest();
  const manifest: ProjectManifestInput = {
    ...m,
    layers: [
      ...m.layers,
      {
        kind: 'pointcloud',
        id: 'synthetic',
        name: 'Synthetic COPC cloud',
        src: { path: 'clouds/synthetic.copc.laz' },
        format: 'copc',
        pointCount: 16000,
      },
    ],
  };
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(manifest), null, 2),
  );
  return { root, bytesPerTile: glb.length };
}

async function launch(root: DataRoot) {
  const network = new NetworkGuard();
  const app = await launchApp(root, {}, SOFTWARE_GPU);
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, network };
}

/** Force the Medium tier (the person's own override) and wait for it. */
async function forceMedium(win: Page) {
  await win.evaluate(() => {
    (window as unknown as PerfW).__stratlas.graphics().getState().setOverride('medium');
  });
  await expect
    .poll(() =>
      win.evaluate(() => (window as unknown as PerfW).__stratlas.graphics().getState().tier),
    )
    .toBe('medium');
}

base('the quadtree tileset is written as planned (no app)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aio-quadtree-'));
  try {
    const r = await writeQuadtreeTileset(dir, { depth: DEPTH, glb: gridGlb(), halfM: HALF_M });
    expect(r.tiles).toBe(85);
    expect(r.leaves).toBe(64);
    expect(r.triangles).toBe(85 * 12_800);
    expect(r.triangles).toBeGreaterThan(1_000_000);
    expect(r.bytes / 2 ** 20).toBeGreaterThan(15);
    const json = JSON.parse(await readFile(join(dir, 'tileset.json'), 'utf8')) as {
      asset: { version: string };
      root: { children?: unknown[]; refine: string; content: { uri: string } };
    };
    expect(json.asset.version).toBe('1.1');
    expect(json.root.refine).toBe('REPLACE');
    expect(json.root.children).toHaveLength(4);
    const leaves = await readdir(join(dir, 't', String(DEPTH - 1)));
    expect(leaves).toHaveLength(64);
    expect(() =>
      TilesetsFile.parse({
        schema: 'aio.tilesets/1',
        entries: [
          {
            id: 'q',
            name: 'q',
            kind: 'mesh',
            src: 'tiles/q/tileset.json',
            visible: true,
            transform: QUADTREE_TO_LOCAL,
          },
        ],
      }),
    ).not.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

base.describe('M10 budgets on the software GPU, Medium forced', () => {
  base.describe.configure({ mode: 'serial' });
  base.setTimeout(240_000);

  base(
    `site view: the tile cache holds a 1 % budget, Medium's error target, p95 under ${String(TILES_P95_MS)} ms; points stay under a ${String(POINT_CAP)} cap`,
    async () => {
      const testInfo = base.info();
      const { root, bytesPerTile } = await tilesRoot();
      const { app, win, network } = await launch(root);
      try {
        await win
          .getByTestId('project-card')
          .filter({ hasText: 'E2E tiny project' })
          .first()
          .click();
        await expect(win.locator('[data-scene-view] canvas')).toBeVisible({ timeout: 60_000 });
        await forceMedium(win);
        const stats = () =>
          win.evaluate(() => (window as unknown as PerfW).__stratlas.tiles.stats());
        await expect.poll(async () => (await stats()).length, { timeout: 60_000 }).toBe(1);
        await win.evaluate((s) => {
          (window as unknown as PerfW).__stratlas.tiles.setBudgetScale(s);
        }, BUDGET_SCALE);
        const path = readPath('tiles-quad.path.json') as CameraPath;
        await win.evaluate((v) => {
          (window as unknown as PerfW).__stratlas.stage()?.restoreView(v, false);
        }, path.keys[0]);
        await expect
          .poll(async () => (await stats())[0]?.cachedBytes ?? 0, { timeout: 60_000 })
          .toBeGreaterThan(0);

        const tiles = await flySite(win, path);
        await expect
          .poll(async () => (await stats())[0]?.loadProgress ?? 0, { timeout: 90_000 })
          .toBe(1);
        const after = (await stats())[0];
        const cap = after?.maxBytes ?? 0;
        const line =
          `tiles (Medium, cache ${(cap / 2 ** 20).toFixed(2)} MB): ${String(tiles.frames)} frames, ` +
          `${tiles.fps.toFixed(1)} fps, p50 ${tiles.p50.toFixed(1)} ms, p95 ${tiles.p95.toFixed(1)} ms, ` +
          `cache peak ${(tiles.maxCached / 2 ** 20).toFixed(2)} MB`;
        process.stdout.write(`${line}\n`);
        await testInfo.attach('m10-tiles-perf.json', {
          body: JSON.stringify({ ...tiles, after, budgetMs: TILES_P95_MS, bytesPerTile }, null, 2),
        });
        expect(cap).toBe(Math.round(TILES_BUDGETS.medium.maxBytes * BUDGET_SCALE));
        expect(tiles.maxBytes).toBe(cap);
        expect(tiles.errorTargets).toEqual([MEDIUM_ERROR_TARGET]);
        // tiles in view are never evicted and downloads already under way land past the cap, so a
        // few tiles of slack (cachedBytes is an in-memory estimate, about the GLB size here)
        const slack = SLACK_TILES * bytesPerTile;
        expect(tiles.maxCached, line).toBeLessThanOrEqual(cap + slack);
        expect(after?.cachedBytes ?? 0, line).toBeLessThanOrEqual(cap + slack);
        expect(tiles.frames).toBeGreaterThan(8);
        expect(tiles.p95, line).toBeLessThan(TILES_P95_MS);

        // points: the cap holds whatever the cloud holds
        await win.evaluate((n) => {
          (window as unknown as PerfW).__stratlas.pointcloud.getState().setBudgetCap(n);
        }, POINT_CAP);
        const synthetic: CameraPath = readPath('synthetic.path.json') as CameraPath;
        await win.evaluate((v) => {
          (window as unknown as PerfW).__stratlas.stage()?.restoreView(v, false);
        }, synthetic.keys[0]);
        const points = () =>
          win.evaluate(
            () => (window as unknown as PerfW).__stratlas.stage()?.perfStats().points ?? 0,
          );
        await expect.poll(points, { timeout: 60_000 }).toBeGreaterThan(0);
        const cloud = await flySite(win, synthetic);
        process.stdout.write(
          `points: peak ${String(cloud.maxPoints)} drawn, cap ${String(POINT_CAP)}\n`,
        );
        await testInfo.attach('m10-points.json', {
          body: JSON.stringify({ maxPoints: cloud.maxPoints, cap: POINT_CAP }, null, 2),
        });
        expect(cloud.maxPoints).toBeGreaterThan(0);
        expect(cloud.maxPoints).toBeLessThanOrEqual(POINT_CAP);
        expect(await network.outbound(), 'the app made network requests').toEqual([]);
      } finally {
        await win
          .evaluate(() => {
            (window as unknown as PerfW).__stratlas.tiles.setBudgetScale(1);
          })
          .catch(() => undefined);
        await app.close();
        await rm(root.base, { recursive: true, force: true });
      }
    },
  );

  base(
    `Globe: three sites and the region packs at Medium, p95 under ${String(GLOBE_P95_MS)} ms`,
    async () => {
      const testInfo = base.info();
      const root = await createDataRoot();
      await createGlobeLibrary(root.root, tinyGlb());
      const { app, win, network } = await launch(root);
      try {
        await forceMedium(win);
        await win.locator('.sb-nav .nav-item', { hasText: 'Globe' }).click();
        await expect(win.getByTestId('globe-canvas').locator('canvas')).toBeVisible({
          timeout: 60_000,
        });
        await expect
          .poll(
            () =>
              win.evaluate(() => {
                const el = document.querySelector('[data-testid="globe-canvas"]');
                const c = (el as { __aioGlobe?: { inspect(): { sites: unknown[] } } } | null)
                  ?.__aioGlobe;
                return c?.inspect().sites.length ?? 0;
              }),
            { timeout: 60_000 },
          )
          .toBeGreaterThan(0);
        const path = readPath('globe.path.json') as GlobePath;
        const sites = path.keys.map((k) => {
          const s = GLOBE_SITES[k.site]?.lonLat;
          if (!s) throw new Error(`site ${String(k.site)} is not placed`);
          return { lon: s[0], lat: s[1], height: k.height, heading: k.heading, pitch: k.pitch };
        });
        const raw = await win.evaluate(
          async ({ keys, durationMs }) => {
            interface Cartesian3Class {
              fromDegrees(lon: number, lat: number, h: number): unknown;
            }
            interface Camera {
              position: { constructor: Cartesian3Class };
              setView(v: {
                destination: unknown;
                orientation: { heading: number; pitch: number; roll: number };
              }): void;
            }
            const el = document.querySelector('[data-testid="globe-canvas"]');
            const scene = (
              el as unknown as {
                __aioGlobe: { widget: { scene: { camera: Camera; requestRender(): void } } };
              }
            ).__aioGlobe.widget.scene;
            const C = scene.camera.position.constructor;
            const r = Math.PI / 180;
            const smooth = (t: number) => t * t * (3 - 2 * t);
            const view = (t: number) => {
              const seg = Math.min(keys.length - 2, Math.floor(t * (keys.length - 1)));
              const a = keys[seg];
              const b = keys[seg + 1];
              if (!a || !b) throw new Error('bad path');
              const u = smooth(t * (keys.length - 1) - seg);
              const mix = (x: number, y: number) => x + (y - x) * u;
              // heights mix in log space so a dive from orbit is not over in the first frames
              const h = Math.exp(mix(Math.log(a.height), Math.log(b.height)));
              scene.camera.setView({
                destination: C.fromDegrees(mix(a.lon, b.lon), mix(a.lat, b.lat), h),
                orientation: {
                  heading: mix(a.heading, b.heading) * r,
                  pitch: mix(a.pitch, b.pitch) * r,
                  roll: 0,
                },
              });
              scene.requestRender();
            };
            const stamps: number[] = [];
            await new Promise<void>((done) => {
              let t0 = -1;
              const step = (now: number) => {
                if (t0 < 0) t0 = now;
                const t = Math.min(1, (now - t0) / durationMs);
                stamps.push(now);
                view(t);
                if (t < 1) requestAnimationFrame(step);
                else done();
              };
              requestAnimationFrame(step);
            });
            return stamps.slice(1).map((s, i) => s - (stamps[i] ?? s));
          },
          { keys: sites, durationMs: path.durationMs },
        );
        const g = summary(raw);
        const tier = await win.evaluate(() =>
          (window as unknown as PerfW).__stratlas.graphics().getState(),
        );
        const line =
          `Globe (${tier.tier}, ${tier.renderer ?? 'unknown GPU'}): ${String(g.frames)} frames, ` +
          `${g.fps.toFixed(1)} fps, p50 ${g.p50.toFixed(1)} ms, p95 ${g.p95.toFixed(1)} ms`;
        process.stdout.write(`${line}\n`);
        await testInfo.attach('m10-globe-perf.json', {
          body: JSON.stringify(
            { ...g, tier: tier.tier, renderer: tier.renderer, budgetMs: GLOBE_P95_MS },
            null,
            2,
          ),
        });
        expect(tier.tier).toBe('medium');
        expect(g.frames).toBeGreaterThan(8);
        expect(g.p95, line).toBeLessThan(GLOBE_P95_MS);
        expect(await network.outbound(), 'the app made network requests').toEqual([]);
      } finally {
        await app.close();
        await rm(root.base, { recursive: true, force: true });
      }
    },
  );
});
