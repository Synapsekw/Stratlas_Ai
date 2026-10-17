import { gridConvergenceDeg, toWgs84 } from '@aio/geo';
import type { PanoStitchFile } from '@aio/schema';
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, readManifestFile, writeManifestFile } from './create';
import type { PanoFrameMeta, PanoGrouping } from './panoGroups';
import {
  applyStitchOutcome,
  importPanoGroups,
  keyGrouping,
  knownPanoFrames,
  markAlreadyImported,
  PanoImportError,
  reconcilePanoStitches,
  setPanoRuns,
  type PanoImportDeps,
} from './panos';

let dir: string;
let root: string;
let card: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-panos-'));
  root = (
    await createProject(dir, {
      name: 'Panos',
      type: 'inspection',
      epsg: 32639,
      origin: [500000, 3200000, 0],
      severityTemplate: null,
    })
  ).root;
  card = join(dir, 'card');
  await mkdir(card);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A point `e` m east and `n` m north of the project origin, as GPS. */
const gps = (e: number, n: number) => {
  const [lon, lat] = toWgs84([500000 + e, 3200000 + n, 0], 32639);
  return { lat, lon };
};

async function frames(prefix: string, count: number): Promise<PanoFrameMeta[]> {
  const out: PanoFrameMeta[] = [];
  for (let i = 1; i <= count; i++) {
    const file = join(card, `${prefix}_${String(i).padStart(4, '0')}.JPG`);
    await writeFile(file, `frame ${prefix} ${String(i)}`);
    out.push({ file, bytes: (await stat(file)).size, takenAt: '2026-09-10T10:00:00' });
  }
  return out;
}

async function grouping(): Promise<PanoGrouping> {
  const a = await frames('SYN', 9);
  const b = await frames('SYM', 8);
  const readyFile = join(card, 'pano.jpg');
  await writeFile(readyFile, 'ready');
  return {
    spheres: [
      {
        shape: 'sphere',
        frames: a,
        ...gps(100, 50),
        relAlt: 70,
        absAlt: 620,
        startedAt: '2026-09-10T10:00:00',
        incomplete: false,
        bytes: a.reduce((n, f) => n + f.bytes, 0),
      },
      {
        shape: 'wide',
        frames: b,
        ...gps(-80, 10),
        relAlt: 65,
        startedAt: '2026-09-10T10:05:00',
        incomplete: false,
        bytes: b.reduce((n, f) => n + f.bytes, 0),
      },
    ],
    ready: [{ file: readyFile, bytes: 5, ...gps(0, 0), width: 4000, height: 2000 }],
    skipped: [],
  };
}

function ok<T>(v: T | null): T {
  if (v === null) throw new Error('expected a manifest');
  return v;
}

const deps = (over: Partial<PanoImportDeps> = {}): PanoImportDeps => ({
  images: {
    resizeJpeg: async (_src, dst) => {
      await writeFile(dst, 'thumb');
    },
  },
  freeBytes: () => Promise.resolve(1e12),
  ...over,
});

const choice = {
  keys: ['s1', 's2', 'r1'],
  layerName: 'Panoramas 10 Sep',
  date: '2026-09-10',
  quality: 'standard' as const,
};

describe('importPanoGroups', () => {
  it('copies frames per sphere, saves one queued layer and names the spheres to stitch', async () => {
    const seen: number[] = [];
    const r = await importPanoGroups(
      root,
      keyGrouping(await grouping()),
      choice,
      deps({ onProgress: (d) => seen.push(d) }),
    );
    expect(r.layerId).toBe('panos-2026-09-10');
    expect(r.stitch).toEqual(['p01', 'p02']);
    expect(seen).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect((await readdir(join(root, 'panoramas', r.layerId, 'p01', 'frames'))).length).toBe(9);
    expect(await readFile(join(root, 'panoramas', r.layerId, 'p03', 'pano.jpg'), 'utf8')).toBe(
      'ready',
    );
    const m = await readManifestFile(root);
    const layer = m.layers.find((l) => l.id === r.layerId);
    expect(layer?.kind).toBe('panoramas');
    if (layer?.kind !== 'panoramas') return;
    expect(layer.name).toBe('Panoramas 10 Sep');
    expect(layer.capture).toBe(m.captures.find((c) => c.date === '2026-09-10')?.id);
    expect(layer.items.map((p) => [p.id, p.name, p.stitch?.status])).toEqual([
      ['p01', 'Pano 1', 'queued'],
      ['p02', 'Pano 2', 'queued'],
      ['p03', 'Pano 3', undefined],
    ]);
    const [p1] = layer.items;
    expect(p1?.src).toEqual({ path: 'panoramas/panos-2026-09-10/p01/pano.jpg' });
    expect(p1?.pos?.[0]).toBeCloseTo(100, 1);
    expect(p1?.pos?.[1]).toBeCloseTo(70, 1); // relative altitude over the origin height
    expect(p1?.pos?.[2]).toBeCloseTo(-50, 1);
    const at = gps(100, 50);
    expect(p1?.headingDeg).toBeCloseTo(-gridConvergenceDeg(at.lon, at.lat, 32639), 3); // true north in the grid
    expect(p1?.capturedAt).toMatch(/^2026-09-10T10:00:00[+-]\d\d:\d\d$/);
    // raw frames are never layer items or manifest entries
    expect(JSON.stringify(m)).not.toContain('SYN_0001');
  });

  it('keeps a ready-made 360 without GPS, and one with half a position, unplaced', () => {
    const g = keyGrouping({
      spheres: [],
      ready: [
        { file: 'g.jpg', bytes: 1, width: 2560, height: 1280 },
        { file: 'h.jpg', bytes: 1, width: 2560, height: 1280, lat: 28.9 },
      ],
      skipped: [],
    });
    expect(g.ready.map((r) => [r.key, r.lat, r.lon])).toEqual([
      ['r1', undefined, undefined],
      ['r2', undefined, undefined],
    ]);
  });

  it('writes an unplaced 360 without pos and heading 0; a placed one keeps its pos', async () => {
    const g = await grouping();
    const lone = join(card, 'ground.jpg');
    await writeFile(lone, 'ground');
    g.ready.push({ file: lone, bytes: 6, width: 2560, height: 1280 });
    const r = await importPanoGroups(
      root,
      keyGrouping(g),
      { ...choice, keys: ['r1', 'r2'] },
      deps(),
    );
    const layer = (await readManifestFile(root)).layers.find((l) => l.id === r.layerId);
    if (layer?.kind !== 'panoramas') throw new Error('expected a panoramas layer');
    const [placed, unplaced] = layer.items;
    expect(placed?.pos?.[0]).toBeCloseTo(0, 1);
    expect(placed?.pos?.[2]).toBeCloseTo(0, 1);
    expect(unplaced).toBeDefined();
    expect(unplaced && 'pos' in unplaced).toBe(false);
    expect(unplaced?.headingDeg).toBe(0);
    expect(r.stitch).toEqual([]);
  });

  it('writes a sphere whose frames give no camera place without pos, not at the origin', async () => {
    const g = await grouping();
    const [s1] = g.spheres;
    if (!s1) throw new Error('expected a sphere');
    // a sphere group always carries a place; one that is no number gives the camera no pos
    g.spheres = [{ ...s1, lat: Number.NaN, lon: Number.NaN }];
    const r = await importPanoGroups(root, keyGrouping(g), { ...choice, keys: ['s1'] }, deps());
    const layer = (await readManifestFile(root)).layers.find((l) => l.id === r.layerId);
    if (layer?.kind !== 'panoramas') throw new Error('expected a panoramas layer');
    expect(layer.items[0] && 'pos' in layer.items[0]).toBe(false);
  });

  it('refuses before copying when the drive is too full (Review Focus 2)', async () => {
    const g = keyGrouping(await grouping());
    const err = await importPanoGroups(
      root,
      g,
      choice,
      deps({ freeBytes: () => Promise.resolve(1000) }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PanoImportError);
    expect((err as PanoImportError).code).toBe('space');
    expect((err as Error).message).toMatch(/needs .* free, and .* is free/);
    expect(await readdir(join(root, 'panoramas'))).toEqual([]);
    expect((await readManifestFile(root)).layers.some((l) => l.kind === 'panoramas')).toBe(false);
  });

  it('removes what it copied when cancelled', async () => {
    const ctl = new AbortController();
    const g = keyGrouping(await grouping());
    const err = await importPanoGroups(
      root,
      g,
      choice,
      deps({
        signal: ctl.signal,
        onProgress: (d) => {
          if (d === 3) ctl.abort();
        },
      }),
    ).catch((e: unknown) => e);
    expect((err as PanoImportError).code).toBe('cancelled');
    expect(await readdir(join(root, 'panoramas'))).toEqual([]);
    expect((await readManifestFile(root)).layers.some((l) => l.kind === 'panoramas')).toBe(false);
  });

  it('keeps the cancel error when the cleanup cannot remove a locked file', async () => {
    const ctl = new AbortController();
    const g = keyGrouping(await grouping());
    let handle: FileHandle | undefined;
    const err = await importPanoGroups(
      root,
      g,
      { ...choice, keys: ['s1'] },
      deps({
        signal: ctl.signal,
        onProgress: (d) => {
          if (d === 2) {
            // hold the first copied frame open: on Windows its removal then fails
            void open(join(root, 'panoramas', 'panos-2026-09-10', 'p01', 'frames', 'SYN_0001.JPG'))
              .then((h) => (handle = h))
              .catch(() => undefined);
          }
          if (d === 3) ctl.abort();
        },
      }),
    ).catch((e: unknown) => e);
    await handle?.close();
    expect((err as PanoImportError).code).toBe('cancelled');
    await rm(join(root, 'panoramas', 'panos-2026-09-10'), { recursive: true, force: true });
  });

  it('leaves no folder and no layer when a copy fails halfway, and reports that error', async () => {
    const g = keyGrouping(await grouping());
    const sphere = g.spheres[0];
    if (!sphere) throw new Error('no sphere');
    await rm(sphere.frames[4]?.file ?? '');
    const err = await importPanoGroups(root, g, { ...choice, keys: ['s1'] }, deps()).catch(
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(PanoImportError);
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(await readdir(join(root, 'panoramas'))).toEqual([]);
    expect((await readManifestFile(root)).layers.some((l) => l.kind === 'panoramas')).toBe(false);
  });

  it('never shares or removes a folder that already has the candidate id', async () => {
    const orphan = join(root, 'panoramas', 'panos-2026-09-10');
    await mkdir(join(orphan, 'p01', 'frames'), { recursive: true });
    await writeFile(join(orphan, 'p01', 'frames', 'keep.JPG'), 'mine');
    const g = keyGrouping(await grouping());
    const r = await importPanoGroups(root, g, { ...choice, keys: ['s1'] }, deps());
    expect(r.layerId).toBe('panos-2026-09-10-2');
    expect(await readdir(join(orphan, 'p01', 'frames'))).toEqual(['keep.JPG']);
    // and a failed import leaves that folder alone too
    const ctl = new AbortController();
    ctl.abort();
    await importPanoGroups(
      root,
      g,
      { ...choice, keys: ['s2'] },
      deps({ signal: ctl.signal }),
    ).catch(() => undefined);
    expect(await readdir(join(orphan, 'p01', 'frames'))).toEqual(['keep.JPG']);
  });

  it('writes a provisional yaw range on a wide panorama and none on a sphere', async () => {
    const grp = await grouping();
    // the wide one sweeps 340 to 100 degrees (across north), the sphere has no gimbal data here
    grp.spheres[1]?.frames.forEach((f, i) => {
      f.gimbal = { yaw: (340 + i * 20) % 360, pitch: -10, roll: 0 };
    });
    const r = await importPanoGroups(root, keyGrouping(grp), choice, deps());
    const layer = (await readManifestFile(root)).layers.find((l) => l.id === r.layerId);
    if (layer?.kind !== 'panoramas') throw new Error('no layer');
    expect(layer.items[0]?.cov).toBeUndefined();
    expect(layer.items[1]?.cov).toEqual({ top: 90, bottom: 90, left: 340, right: 480 });
    expect(r.shapes).toEqual({ p01: 'sphere', p02: 'wide' });
  });

  it('refuses an empty choice and gives a second import its own layer', async () => {
    const g = keyGrouping(await grouping());
    await expect(importPanoGroups(root, g, { ...choice, keys: [] }, deps())).rejects.toMatchObject({
      code: 'empty',
    });
    await importPanoGroups(root, g, { ...choice, keys: ['s1'] }, deps());
    const again = await importPanoGroups(root, g, { ...choice, keys: ['s2'] }, deps());
    expect(again.layerId).toBe('panos-2026-09-10-2');
  });
});

describe('already imported frames (Review Focus 1)', () => {
  it('marks a sphere whose frames sit in a pano layer already', async () => {
    const g = keyGrouping(await grouping());
    await importPanoGroups(root, g, { ...choice, keys: ['s1'] }, deps());
    const known = await knownPanoFrames(root, await readManifestFile(root));
    expect(known.size).toBe(9);
    expect(markAlreadyImported(g, known)).toEqual(new Map([['s1', 'Panoramas 10 Sep']]));
  });
});

const record = (over: Partial<PanoStitchFile> = {}): PanoStitchFile => ({
  schema: 'aio.pano-stitch/1',
  run: '20261013-101500-pano-stitch-a1b2',
  layer: 'panos-2026-09-10',
  pano: 'p01',
  createdAt: '2026-10-13T10:16:00.000Z',
  engine: { version: '0.7.0' },
  quality: 'standard',
  shape: 'sphere',
  size: { width: 8192, height: 4096 },
  frames: { used: ['SYN_0001.JPG'], dropped: [] },
  aligned: 'features',
  residualPx: 0.8,
  maxDriftDeg: 1.7,
  focalScale: 1.01,
  coverage: { topDeg: 22, bottomDeg: 90 },
  timings: {},
  warnings: [],
  ...over,
});

describe('filing stitch outcomes', () => {
  async function imported() {
    const r = await importPanoGroups(root, keyGrouping(await grouping()), choice, deps());
    return { m: await readManifestFile(root), layer: r.layerId };
  }
  const itemOf = (m: Awaited<ReturnType<typeof readManifestFile>>, id: string) => {
    const l = m.layers.find((x) => x.kind === 'panoramas');
    return l?.kind === 'panoramas' ? l.items.find((p) => p.id === id) : undefined;
  };

  it('records runs on queued items only', async () => {
    const { m, layer } = await imported();
    const next = setPanoRuns(m, layer, { p01: 'run-a', p02: 'run-b' });
    expect(itemOf(ok(next), 'p01')?.stitch).toEqual({ run: 'run-a', status: 'queued' });
    const failed = applyStitchOutcome(ok(next), {
      layer,
      pano: 'p02',
      run: 'run-b',
      status: 'failed',
      error: 'x',
    });
    expect(setPanoRuns(ok(failed), layer, { p02: 'run-c' })).toBeNull();
  });

  it('files done with the full-sphere coverage, and a wide panorama with its yaw range', async () => {
    const { m, layer } = await imported();
    const done = applyStitchOutcome(
      m,
      { layer, pano: 'p01', run: 'r1', status: 'done' },
      record({ run: 'r1' }),
    );
    expect(itemOf(ok(done), 'p01')).toMatchObject({
      stitch: { run: 'r1', status: 'done' },
      cov: { top: 90, bottom: 90 },
    });
    const wide = applyStitchOutcome(
      m,
      { layer, pano: 'p02', run: 'r2', status: 'done' },
      record({
        run: 'r2',
        pano: 'p02',
        shape: 'wide',
        coverage: { topDeg: 24, bottomDeg: 55, leftDeg: -100, rightDeg: 93 },
      }),
    );
    expect(itemOf(ok(wide), 'p02')?.cov).toEqual({ top: 24, bottom: 55, left: -100, right: 93 });
  });

  it('files a failure with its reason and keeps unrelated edits (Review Focus 5)', async () => {
    const { m, layer } = await imported();
    const edited = {
      ...m,
      layers: m.layers.map((l) => (l.id === layer ? { ...l, visible: false } : l)),
    };
    const failed = applyStitchOutcome(edited, {
      layer,
      pano: 'p01',
      run: 'r1',
      status: 'failed',
      error: 'Too few frames',
    });
    expect(itemOf(ok(failed), 'p01')?.stitch).toEqual({
      run: 'r1',
      status: 'failed',
      error: 'Too few frames',
    });
    expect(ok(failed).layers.find((l) => l.id === layer)?.visible).toBe(false);
  });

  it('ignores an older run, an unknown item and a no-op', async () => {
    const { m, layer } = await imported();
    const newer = ok(setPanoRuns(m, layer, { p01: '20261013-120000-pano-stitch-bbbb' }));
    expect(
      applyStitchOutcome(newer, {
        layer,
        pano: 'p01',
        run: '20261013-100000-pano-stitch-aaaa',
        status: 'failed',
      }),
    ).toBeNull();
    expect(
      applyStitchOutcome(newer, { layer, pano: 'p99', run: 'x', status: 'failed' }),
    ).toBeNull();
    // a ready-made panorama never had a stitch: no state is added to it
    expect(
      applyStitchOutcome(newer, { layer, pano: 'p03', run: 'x', status: 'failed' }),
    ).toBeNull();
    expect(
      applyStitchOutcome(newer, {
        layer,
        pano: 'p01',
        run: '20261013-120000-pano-stitch-bbbb',
        status: 'queued',
      }),
    ).toBeNull();
  });

  it('reconciles a finished stitch found on disk when the project opens', async () => {
    const { m, layer } = await imported();
    await writeManifestFile(root, ok(setPanoRuns(m, layer, { p01: 'r1' })));
    const folder = join(root, 'panoramas', layer, 'p01');
    await writeFile(join(folder, 'stitch.json'), JSON.stringify(record({ run: 'r1', layer })));
    const next = await reconcilePanoStitches(root, await readManifestFile(root));
    expect(itemOf(ok(next), 'p01')?.stitch?.status).toBe('done');
    expect(itemOf(ok(next), 'p02')?.stitch?.status).toBe('queued');
    expect(await reconcilePanoStitches(root, ok(next))).toBeNull();
  });
});
