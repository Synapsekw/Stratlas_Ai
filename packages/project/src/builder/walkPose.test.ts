import {
  WALK_ORIENT_SCHEMA,
  WALK_PATH_SCHEMA,
  type Layer,
  type ProjectManifest,
  type WalkCalibration,
  type WalkLayer,
  type WalkRawPath,
} from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, readManifestFile, updateLayers, updateManifestFile } from './create';
import { placementFor } from './drawingPlacement';
import { readWalkInputs, surfacesOf, walkStartUtcMs, writeWalkPose } from './walkPose';

/*
 * A walk 20 s long, straight along raw +x at 0.5 raw units a second; a drawing 100 m x 50 m
 * (1000 x 500 px, 0.1 m a pixel) with its top-left corner at the origin. Pins at t = 0 and t = 20
 * on the drawing's pixels [0, 250] and [200, 250]: the model path runs from (0, 25) to (20, 25).
 */

let dir: string;
let root: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-walk-pose-'));
  root = (
    await createProject(dir, {
      name: 'Walk pose',
      type: 'inspection',
      epsg: 32639,
      origin: [500000, 3200000, 0],
      severityTemplate: null,
    })
  ).root;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DURATION = 20;
const CORNERS = {
  tl: [0, 0, 0] as [number, number, number],
  tr: [100, 0, 0] as [number, number, number],
  bl: [0, 0, 50] as [number, number, number],
};

const rawPath = (): WalkRawPath => ({
  schema: WALK_PATH_SCHEMA,
  walk: 'w',
  source: 'sfm',
  up: [0, 1, 0],
  stills: Array.from({ length: DURATION + 1 }, (_, t) => ({
    n: t * 30,
    t,
    pos: [t * 0.5, 0, 0] as [number, number, number],
    q: [0, 0, 0, 1] as [number, number, number, number],
    segment: 0,
    steps: t * 2,
  })),
});

const cal = (): WalkCalibration => ({
  // given out of order: the save sorts them
  pins: [
    { t: 20, surface: 'sheet-a', at: [200, 250] },
    { t: 0, surface: 'sheet-a', at: [0, 250] },
  ],
  yawOffsetDeg: 0,
  heightM: 1.7,
  quality: 'poor',
});

const walkLayer = (): WalkLayer => ({
  kind: 'walk',
  id: 'walk-w',
  name: 'Walk w',
  visible: true,
  record: { path: 'walks/w/walk.json' },
  src: { path: 'walks/w/playback.mp4' },
  durationS: DURATION,
});

const sheet = (corners = CORNERS): Layer => ({
  kind: 'raster',
  id: 'sheet-a',
  name: 'Sheet A',
  visible: true,
  src: { path: 'drawings/sheet-a/plan.png' },
  format: 'image',
  role: 'plan',
  corners,
});

async function setUp(
  o: { raw?: string | null; capturedAt?: string; orient?: { rateHz: number } } = {},
): Promise<void> {
  const folder = join(root, 'walks', 'w');
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, 'walk.json'),
    JSON.stringify({ source: o.capturedAt ? { capturedAt: o.capturedAt } : {} }),
  );
  const raw = o.raw === undefined ? JSON.stringify(rawPath()) : o.raw;
  if (raw !== null) await writeFile(join(folder, 'raw-path.json'), raw);
  if (o.orient) {
    const count = DURATION * o.orient.rateHz + 1;
    const bytes = new Uint8Array(count * 20);
    const v = new DataView(bytes.buffer);
    for (let i = 0; i < count; i++) {
      v.setFloat32(i * 20, i / o.orient.rateHz, true);
      v.setFloat32(i * 20 + 16, 1, true);
    }
    await writeFile(join(folder, 'orientation.bin'), bytes);
    await writeFile(
      join(folder, 'orientation.json'),
      JSON.stringify({
        schema: WALK_ORIENT_SCHEMA,
        rateHz: o.orient.rateHz,
        count,
        convention: 'xyzw-camera-threejs',
        frame: 'raw',
        startOffsetS: 0,
        data: 'orientation.bin',
        layout: 'f32le-t-xyzw',
      }),
    );
  }
  await mkdir(join(root, 'drawings', 'sheet-a'), { recursive: true });
  await writeFile(
    join(root, 'drawings', 'sheet-a', 'placement.json'),
    JSON.stringify(placementFor('sheet-a.png', CORNERS, 1000, 500, false)),
  );
  await updateManifestFile(root, (m) => ({
    manifest: { ...m, layers: [...m.layers, sheet(), walkLayer()] },
  }));
}

interface PoseDoc {
  schema: string;
  startUtcMs: number;
  lens: unknown;
  samples: { t: number; pos: [number, number, number] }[];
}
const readPose = async (): Promise<PoseDoc> =>
  JSON.parse(await readFile(join(root, 'walks', 'w', 'pose.json'), 'utf8')) as PoseDoc;
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
const walkOf = (m: ProjectManifest) => {
  const l = m.layers.find((x) => x.id === 'walk-w');
  if (l?.kind !== 'walk') throw new Error('no walk layer');
  return l;
};

describe('walk pose file', () => {
  it('writes aio.flight/1 with pinhole 90 x 2 and samples from the fit', async () => {
    await setUp();
    await updateLayers(root, ['walk-w'], { walk: cal() });
    const doc = await readPose();
    expect(doc.schema).toBe('aio.flight/1');
    expect(doc.lens).toEqual({ model: 'pinhole', hfovDeg: 90, aspect: 2 });
    // no orientation file: 10 a second
    expect(doc.samples).toHaveLength(DURATION * 10 + 1);
    const first = doc.samples[0];
    const last = doc.samples[doc.samples.length - 1];
    expect(first?.t).toBe(0);
    expect(first?.pos[0]).toBeCloseTo(0, 6);
    expect(first?.pos[1]).toBeCloseTo(1.7, 6);
    expect(first?.pos[2]).toBeCloseTo(25, 6);
    expect(last?.t).toBeCloseTo(DURATION * 1000, 6);
    expect(last?.pos[0]).toBeCloseTo(20, 6);
    expect(last?.pos[2]).toBeCloseTo(25, 6);
    expect(await exists(join(root, 'walks', 'w', 'pose.json.tmp'))).toBe(false);
  });

  it('samples at 30 a second with an orientation file', async () => {
    await setUp({ orient: { rateHz: 100 } });
    await updateLayers(root, ['walk-w'], { walk: cal() });
    expect((await readPose()).samples).toHaveLength(DURATION * 30 + 1);
  });

  it('sets flight on the layer and the computed quality', async () => {
    await setUp();
    const r = await updateLayers(root, ['walk-w'], { walk: cal() });
    const l = walkOf(await readManifestFile(root));
    expect(l.flight).toEqual({ src: { path: 'walks/w/pose.json' }, startUtcMs: 0 });
    // quality from walkQuality, not from the patch ('poor')
    expect(l.place?.quality).toBe('good');
    expect(l.place?.pins.map((p) => p.t)).toEqual([0, 20]);
    expect(walkOf(r.manifest).place?.quality).toBe('good');
    expect(r.problems).toEqual([]);
  });

  it('clears flight and deletes pose.json when the walk patch is null', async () => {
    await setUp();
    await updateLayers(root, ['walk-w'], { walk: cal() });
    expect(await exists(join(root, 'walks', 'w', 'pose.json'))).toBe(true);
    await updateLayers(root, ['walk-w'], { walk: null });
    const l = walkOf(await readManifestFile(root));
    expect(l.place).toBeUndefined();
    expect(l.flight).toBeUndefined();
    expect(await exists(join(root, 'walks', 'w', 'pose.json'))).toBe(false);
  });

  it('writes no pose for a walk with one pin, quality unplaced', async () => {
    await setUp();
    const one = {
      ...cal(),
      pins: [{ t: 0, surface: 'sheet-a', at: [0, 250] as [number, number] }],
    };
    await updateLayers(root, ['walk-w'], { walk: one });
    const l = walkOf(await readManifestFile(root));
    expect(l.flight).toBeUndefined();
    expect(l.place?.quality).toBe('unplaced');
    expect(await exists(join(root, 'walks', 'w', 'pose.json'))).toBe(false);
  });

  it('rewrites the pose when a pinned drawing gets new corners', async () => {
    await setUp();
    await updateLayers(root, ['walk-w'], { walk: cal() });
    const before = await readPose();
    const shift = (p: [number, number, number]): [number, number, number] => [
      p[0] + 10,
      p[1],
      p[2],
    ];
    await updateLayers(root, ['sheet-a'], {
      corners: { tl: shift(CORNERS.tl), tr: shift(CORNERS.tr), bl: shift(CORNERS.bl) },
    });
    const after = await readPose();
    expect(after.samples).toHaveLength(before.samples.length);
    for (let i = 0; i < after.samples.length; i += 37) {
      const a = after.samples[i];
      const b = before.samples[i];
      expect((a?.pos[0] ?? 0) - (b?.pos[0] ?? 0)).toBeCloseTo(10, 6);
      expect(a?.pos[2]).toBeCloseTo(b?.pos[2] ?? NaN, 6);
    }
    expect(walkOf(await readManifestFile(root)).flight?.src).toEqual({ path: 'walks/w/pose.json' });
  });

  it('leaves the pose alone when a drawing without pins moves', async () => {
    await setUp();
    await updateLayers(root, ['walk-w'], { walk: { ...cal(), pins: [] } });
    await updateLayers(root, ['sheet-a'], { corners: CORNERS });
    expect(await exists(join(root, 'walks', 'w', 'pose.json'))).toBe(false);
  });

  it('reads a corrupt raw path as missing (pins-only) and reports it', async () => {
    await setUp({ raw: '{ not json' });
    const r = await readWalkInputs(root, walkLayer());
    expect(r.raw).toBeNull();
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('walks/w/raw-path.json');
    // the save still places the walk, by its pins only
    const u = await updateLayers(root, ['walk-w'], { walk: cal() });
    expect(u.problems).toHaveLength(1);
    expect(walkOf(u.manifest).place?.quality).toBe('check');
    expect((await readPose()).samples.length).toBeGreaterThan(0);
  });

  it('reads aio.walkpath/2 as missing', async () => {
    await setUp({ raw: JSON.stringify({ ...rawPath(), schema: 'aio.walkpath/2' }) });
    const r = await readWalkInputs(root, walkLayer());
    expect(r.raw).toBeNull();
    expect(r.problems[0]).toContain('aio.walkpath/2');
  });

  it('reads a missing raw path as null without a problem', async () => {
    await setUp({ raw: null });
    const r = await readWalkInputs(root, walkLayer());
    expect(r).toEqual({ raw: null, orient: null, rows: null, problems: [] });
  });

  it('refuses an orientation file of the wrong length and a newer header', async () => {
    await setUp({ orient: { rateHz: 10 } });
    const ok = await readWalkInputs(root, walkLayer());
    expect(ok.rows).toHaveLength(DURATION * 10 + 1);
    expect(ok.orient?.rateHz).toBe(10);
    await writeFile(join(root, 'walks', 'w', 'orientation.bin'), new Uint8Array(30));
    const short = await readWalkInputs(root, walkLayer());
    expect(short.orient).toBeNull();
    expect(short.rows).toBeNull();
    expect(short.problems[0]).toContain('walks/w/orientation.bin');
    const head = JSON.parse(
      await readFile(join(root, 'walks', 'w', 'orientation.json'), 'utf8'),
    ) as Record<string, unknown>;
    await writeFile(
      join(root, 'walks', 'w', 'orientation.json'),
      JSON.stringify({ ...head, schema: 'aio.walkorient/2' }),
    );
    const newer = await readWalkInputs(root, walkLayer());
    expect(newer.orient).toBeNull();
    expect(newer.problems[0]).toContain('aio.walkorient/2');
  });

  it('startUtcMs from capturedAt read as UTC; 0 when absent', async () => {
    expect(walkStartUtcMs('2026-10-10T08:30:00')).toBe(Date.UTC(2026, 9, 10, 8, 30, 0));
    expect(walkStartUtcMs(undefined)).toBe(0);
    expect(walkStartUtcMs('not a time')).toBe(0);
    await setUp({ capturedAt: '2026-10-10T08:30:00' });
    const m = await readManifestFile(root);
    const placed: ProjectManifest = {
      ...m,
      layers: m.layers.map((l) => (l.id === 'walk-w' ? { ...walkLayer(), place: cal() } : l)),
    };
    const r = await writeWalkPose(root, placed, 'walk-w');
    expect(r.flight?.startUtcMs).toBe(Date.UTC(2026, 9, 10, 8, 30, 0));
    expect((await readPose()).startUtcMs).toBe(Date.UTC(2026, 9, 10, 8, 30, 0));
  });

  it('surfacesOf: a drawing without corners or placement size is gone', () => {
    const m = { layers: [sheet()] } as unknown as ProjectManifest;
    expect(surfacesOf(m, new Map()).drawing('sheet-a')).toBeNull();
    const s = surfacesOf(m, new Map([['sheet-a', { sizePx: [1000, 500], provisional: true }]]));
    expect(s.drawing('sheet-a')).toMatchObject({ a: 0.1, d: 0.1, baseY: 0, provisional: true });
    expect(s.drawing('nope')).toBeNull();
  });
});

describe('walk pose file: record paths stay inside the project', () => {
  for (const record of ['walks/../walk.json', 'walks/../evil/walk.json']) {
    it(`writes and removes nothing for ${record}`, async () => {
      await setUp();
      // a hand edited record pointing outside walks/<id>/, with a pose.json already there
      const outside = join(root, record.replace(/walk\.json$/, ''));
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'walk.json'), JSON.stringify({ source: {} }));
      await writeFile(join(outside, 'raw-path.json'), JSON.stringify(rawPath()));
      await writeFile(join(outside, 'pose.json'), 'keep');
      await updateManifestFile(root, (m) => ({
        manifest: {
          ...m,
          layers: m.layers.map((l) =>
            l.id === 'walk-w' && l.kind === 'walk' ? { ...l, record: { path: record } } : l,
          ),
        },
      }));
      // placing writes nothing outside, clearing removes nothing outside
      const placed = await writeWalkPose(
        root,
        {
          ...(await readManifestFile(root)),
          layers: (await readManifestFile(root)).layers.map((l) =>
            l.id === 'walk-w' && l.kind === 'walk' ? { ...l, place: cal() } : l,
          ),
        },
        'walk-w',
      );
      expect(placed.flight).toBeNull();
      expect(await readFile(join(outside, 'pose.json'), 'utf8')).toBe('keep');
      expect(await exists(join(outside, 'pose.json.tmp'))).toBe(false);
      await writeWalkPose(root, await readManifestFile(root), 'walk-w');
      expect(await readFile(join(outside, 'pose.json'), 'utf8')).toBe('keep');
      const inputs = await readWalkInputs(root, walkOf(await readManifestFile(root)));
      expect(inputs.raw).toBeNull();
    });
  }
});
