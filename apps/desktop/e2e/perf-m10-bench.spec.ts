/**
 * The opt-in M10 benchmark on real hardware (D7, plan 2026-10-12-m10-hardening-and-docs.md): the
 * frame-rate targets CI cannot show. Skipped unless QUADRION_BENCH=1, and refused on the software
 * GPU (QUADRION_E2E_SWGL=1). Runs only in a window the founder gives: it holds the GPU, the CPU
 * and several GB of memory for minutes.
 *
 * Data: `node tools/bench/m10-bench-data.mjs --out <folder>` (a 20 M triangle quadtree tileset
 * and a 100 M point COPC by default, `--points 500e6` for the full target), then
 * QUADRION_BENCH_ROOT=<folder>. Tier as detected, or QUADRION_BENCH_TIER=medium to force Medium.
 *
 * Site view: the real budgets (no scale): tile cache under the tier cap (384 MB at Medium),
 * points drawn under the tier budget (4 M at Medium), frame p95 at or under 33.3 ms (30 fps).
 * Globe: the synthetic library in the same data root with the bench project placed at site A,
 * frame p95 at or under 33.3 ms. Writes `bench-report.json` into QUADRION_BENCH_ROOT.
 *
 * pnpm --filter @aio/desktop exec playwright test e2e/perf-m10-bench.spec.ts --workers=1
 */
import {
  ProjectManifest,
  SCHEMA_VERSION,
  TilesetsFile,
  type ProjectManifestInput,
} from '@aio/schema';
import { test as base, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, tinyGlb, type DataRoot } from './fixtures';
import { TILES_BUDGETS } from '@aio/tiles';
import { createGlobeLibrary, GLOBE_SITES } from './m10Fixtures';
import { QUADTREE_TO_LOCAL } from './quadtreeTileset';

const ROOT = process.env.QUADRION_BENCH_ROOT ?? '';
const TIER = process.env.QUADRION_BENCH_TIER;
const P95_MS = 1000 / 30;
const MB = 2 ** 20;
/** The Medium caps (packages/tiles/src/budgets.ts, renderer graphics.ts). */
const MEDIUM = { cacheBytes: TILES_BUDGETS.medium.maxBytes, points: 4_000_000 };
const PROJECT = 'm10-bench';

base.skip(
  process.env.QUADRION_BENCH !== '1',
  'opt-in benchmark: QUADRION_BENCH=1 and a window from the founder',
);
base.skip(process.env.QUADRION_E2E_SWGL === '1', 'needs the hardware GPU');

interface View {
  position: [number, number, number];
  target: [number, number, number];
}
interface BenchW {
  __stratlas: {
    stage(): {
      restoreView(v: View, animate?: boolean): void;
      perfStats(): { points: number };
    } | null;
    graphics(): {
      getState(): { tier: string; renderer: string | null; setOverride(t: string | null): void };
    };
    tiles: { stats(): { cachedBytes: number; maxBytes: number }[] };
  };
}

const report: Record<string, unknown> = {};

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

/** The bench data root: the project m10-bench-data.mjs wrote, with its manifest and tilesets. */
async function benchRoot(): Promise<DataRoot> {
  const root = join(ROOT, 'data');
  const projectDir = join(root, 'projects', PROJECT);
  if (!existsSync(join(projectDir, 'tiles', 'bench-mesh', 'tileset.json')))
    throw new Error(
      `no bench data in ${ROOT}: run node tools/bench/m10-bench-data.mjs --out <folder>`,
    );
  const userData = join(ROOT, 'user');
  await rm(userData, { recursive: true, force: true });
  await mkdir(join(root, 'packs'), { recursive: true });
  const siteA = GLOBE_SITES[0];
  if (!siteA) throw new Error('no site A');
  const stamp = JSON.parse(readFileSync(join(ROOT, 'bench.json'), 'utf8')) as {
    cloud?: { points: number };
  };
  const manifest: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: PROJECT,
    name: 'M10 benchmark (synthetic)',
    // placed at the Globe library's site A so the Globe shows it there
    crs: siteA.crs,
    origin: siteA.origin,
    captures: [],
    layers: [
      ...(stamp.cloud
        ? [
            {
              kind: 'pointcloud' as const,
              id: 'bench-cloud',
              name: 'Benchmark cloud (synthetic)',
              src: { path: 'clouds/bench.copc.laz' },
              format: 'copc' as const,
              pointCount: stamp.cloud.points,
            },
          ]
        : []),
    ],
  };
  await writeFile(
    join(projectDir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(manifest), null, 2),
  );
  const file = TilesetsFile.parse({
    schema: 'aio.tilesets/1',
    entries: [
      {
        id: 'bench-mesh',
        name: 'Benchmark mesh (synthetic)',
        kind: 'mesh',
        src: 'tiles/bench-mesh/tileset.json',
        visible: true,
        transform: QUADTREE_TO_LOCAL,
      },
    ],
  });
  await writeFile(join(projectDir, 'tilesets.json'), JSON.stringify(file, null, 2));
  return { base: ROOT, root, userData, projectId: PROJECT, projectDir };
}

async function flySite(win: Page, keys: View[], durationMs: number) {
  const raw = await win.evaluate(
    async ({ keys: ks, durationMs: d }) => {
      const w = window as unknown as BenchW;
      const stage = w.__stratlas.stage();
      if (!stage) throw new Error('no stage');
      const lerp = (a: number[], b: number[], t: number) =>
        a.map((v, i) => v + ((b[i] ?? v) - v) * t);
      const stamps: number[] = [];
      let points = 0;
      let cache = 0;
      let cap = 0;
      await new Promise<void>((done) => {
        let t0 = -1;
        const step = (now: number) => {
          if (t0 < 0) t0 = now;
          const t = Math.min(1, (now - t0) / d);
          const seg = Math.min(ks.length - 2, Math.floor(t * (ks.length - 1)));
          const u = t * (ks.length - 1) - seg;
          const a = ks[seg];
          const b = ks[seg + 1];
          if (a && b)
            stage.restoreView(
              {
                position: lerp(a.position, b.position, u) as View['position'],
                target: lerp(a.target, b.target, u) as View['target'],
              },
              false,
            );
          stamps.push(now);
          points = Math.max(points, stage.perfStats().points);
          for (const s of w.__stratlas.tiles.stats()) {
            cache = Math.max(cache, s.cachedBytes);
            cap = Math.max(cap, s.maxBytes);
          }
          if (t < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
      return { dts: stamps.slice(1).map((s, i) => s - (stamps[i] ?? s)), points, cache, cap };
    },
    { keys, durationMs },
  );
  return { ...summary(raw.dts), pointsPeak: raw.points, cachePeak: raw.cache, cacheCap: raw.cap };
}

base.describe('M10 benchmark on this computer @bench', () => {
  base.describe.configure({ mode: 'serial' });
  base.setTimeout(900_000);

  base.afterAll(async () => {
    if (ROOT) await writeFile(join(ROOT, 'bench-report.json'), JSON.stringify(report, null, 2));
  });

  base(
    'site view: 20 M triangles and the cloud at 30 fps within the tier budgets @bench',
    async () => {
      const root = await benchRoot();
      const network = new NetworkGuard();
      const app = await launchApp(root);
      await network.attach(app);
      try {
        const win = await app.firstWindow();
        if (TIER)
          await win.evaluate((t) => {
            (window as unknown as BenchW).__stratlas.graphics().getState().setOverride(t);
          }, TIER);
        await win.getByTestId('project-card').filter({ hasText: 'M10 benchmark' }).first().click();
        await expect(win.locator('[data-scene-view] canvas')).toBeVisible({ timeout: 120_000 });
        const keys: View[] = [
          { position: [0, 900, 700], target: [0, 4, 0] },
          { position: [-300, 120, -200], target: [-350, 4, -350] },
          { position: [200, 40, 150], target: [400, 4, 400] },
          { position: [600, 200, 0], target: [0, 4, 0] },
          { position: [0, 900, 700], target: [0, 4, 0] },
        ];
        await win.evaluate((v) => {
          (window as unknown as BenchW).__stratlas.stage()?.restoreView(v, false);
        }, keys[0]);
        await win.waitForTimeout(20_000);
        const r = await flySite(win, keys, 30_000);
        const g = await win.evaluate(() =>
          (window as unknown as BenchW).__stratlas.graphics().getState(),
        );
        report.site = { ...r, tier: g.tier, renderer: g.renderer };
        const line = `site view (${g.tier}, ${g.renderer ?? '?'}): p95 ${r.p95.toFixed(1)} ms, ${r.fps.toFixed(1)} fps, cache peak ${(r.cachePeak / MB).toFixed(0)} MB, points peak ${String(r.pointsPeak)}`;
        process.stdout.write(`${line}\n`);
        if (g.tier === 'medium') {
          expect(r.cachePeak, line).toBeLessThan(MEDIUM.cacheBytes);
          expect(r.pointsPeak, line).toBeLessThan(MEDIUM.points);
        } else {
          expect(r.cachePeak, line).toBeLessThanOrEqual(r.cacheCap * 1.05);
        }
        expect(r.p95, line).toBeLessThanOrEqual(P95_MS);
        expect(await network.outbound()).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );

  base('Globe: the library and the bench tileset at site A at 30 fps @bench', async () => {
    const root = await benchRoot();
    await createGlobeLibrary(root.root, tinyGlb());
    const network = new NetworkGuard();
    const app = await launchApp(root);
    await network.attach(app);
    try {
      const win = await app.firstWindow();
      if (TIER)
        await win.evaluate((t) => {
          (window as unknown as BenchW).__stratlas.graphics().getState().setOverride(t);
        }, TIER);
      await win.getByTestId('project-card').filter({ hasText: 'M10 benchmark' }).first().click();
      await win.locator('.sb-nav .nav-item', { hasText: 'Globe' }).click();
      await expect(win.getByTestId('globe-canvas').locator('canvas')).toBeVisible({
        timeout: 120_000,
      });
      await win.waitForTimeout(20_000);
      const a = GLOBE_SITES[0]?.lonLat ?? [0, 0];
      const b = GLOBE_SITES[1]?.lonLat ?? [0, 0];
      const dts = await win.evaluate(
        async ({ a: pa, b: pb }) => {
          interface Camera {
            position: {
              constructor: { fromDegrees(lon: number, lat: number, h: number): unknown };
            };
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
          const keys = [
            [pa[0], pa[1], 1500, -40],
            [pa[0], pa[1], 2_000_000, -90],
            [pb[0], pb[1], 2_000_000, -90],
            [pa[0], pa[1], 1500, -40],
          ] as const;
          const stamps: number[] = [];
          await new Promise<void>((done) => {
            let t0 = -1;
            const step = (now: number) => {
              if (t0 < 0) t0 = now;
              const t = Math.min(1, (now - t0) / 30_000);
              const seg = Math.min(keys.length - 2, Math.floor(t * (keys.length - 1)));
              const u = t * (keys.length - 1) - seg;
              const k0 = keys[seg];
              const k1 = keys[seg + 1];
              if (k0 && k1) {
                const m = (i: 0 | 1 | 3) => k0[i] + (k1[i] - k0[i]) * u;
                const h = Math.exp(Math.log(k0[2]) + (Math.log(k1[2]) - Math.log(k0[2])) * u);
                scene.camera.setView({
                  destination: C.fromDegrees(m(0), m(1), h),
                  orientation: { heading: 0, pitch: (m(3) * Math.PI) / 180, roll: 0 },
                });
                scene.requestRender();
              }
              stamps.push(now);
              if (t < 1) requestAnimationFrame(step);
              else done();
            };
            requestAnimationFrame(step);
          });
          return stamps.slice(1).map((s, i) => s - (stamps[i] ?? s));
        },
        { a, b },
      );
      const r = summary(dts);
      report.globe = r;
      const line = `Globe: p95 ${r.p95.toFixed(1)} ms, ${r.fps.toFixed(1)} fps`;
      process.stdout.write(`${line}\n`);
      expect(r.p95, line).toBeLessThanOrEqual(P95_MS);
      expect(await network.outbound()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
