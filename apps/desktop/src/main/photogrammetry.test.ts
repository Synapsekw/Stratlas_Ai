import { withExif } from '@aio/project/builder/testing';
import type { GcpFile, HardwareProbe, PhotoRun, ProjectManifest } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectHandlers } from './notYet';
import {
  estimateRun,
  gpusFromInfo,
  listPhotoFiles,
  poseMoves,
  processingVerdict,
  readPhotoSet,
  registerPhotogrammetryIpc,
  summariseRun,
  utmEpsg,
  type PhotoProjects,
  type PhotoSet,
  type PhotoSystem,
} from './photogrammetry';
import { sampleManifest } from './testing';

const GB = 1024 ** 3;
const RUN = '20261007-0915';

const fakeSystem = (o: Partial<PhotoSystem> = {}): PhotoSystem => ({
  platform: 'win32',
  arch: 'x64',
  cpu: () => ({ model: 'Synthetic 8-core CPU', cores: 8, threads: 16 }),
  memoryBytes: () => 32 * GB,
  freeDiskBytes: () => Promise.resolve(500 * GB),
  gpus: () => Promise.resolve([]),
  packVersion: () => Promise.resolve('0.4.0'),
  ...o,
});

const HW: Pick<HardwareProbe, 'cpu' | 'memoryBytes' | 'freeDiskBytes' | 'cuda'> = {
  cpu: { model: 'x', cores: 8 },
  memoryBytes: 32 * GB,
  freeDiskBytes: 500 * GB,
  cuda: false,
};

const photoSet = (o: Partial<PhotoSet> = {}): PhotoSet => ({
  count: 500,
  megapixels: 20,
  bytes: 500 * 8 * 1024 ** 2,
  groups: [{ label: 'Stratlas Synthetic SYN-20', widthPx: 5472, heightPx: 3648, photos: 500 }],
  sampled: false,
  noGps: 0,
  ...o,
});

function photosManifest(): ProjectManifest {
  const m = sampleManifest({ layers: [] });
  return {
    ...m,
    layers: [
      {
        kind: 'photos',
        id: 'photos',
        name: 'Flight 1',
        visible: true,
        items: [
          { id: 'p1', src: { path: 'photos/p1.jpg' }, pos: [0, 60, 0] },
          { id: 'p2', src: { path: 'photos/p2.jpg' }, pos: [10, 60, 0] },
          { id: 'p3', src: { path: 'photos/p3.jpg' }, pos: [20, 60, 0] },
        ],
      },
    ],
  };
}

function sampleRun(o: Partial<PhotoRun> = {}): PhotoRun {
  return {
    schema: 'aio.photo-run/1',
    id: RUN,
    createdAt: '2026-10-07T09:15:00Z',
    status: 'aligned',
    preset: 'standard',
    photos: { source: { layer: 'photos' }, count: 3, registered: 3 },
    cameras: [{ id: 'cam1', widthPx: 1600, heightPx: 1200, photos: 3 }],
    crs: { epsg: 32639 },
    stages: [
      { name: 'inspect', state: 'done' },
      { name: 'sfm', state: 'done' },
    ],
    outputs: { layers: [], tilesets: [], files: [] },
    versions: { pack: '0.4.0' },
    ...o,
  };
}

const sampleGcp = (): GcpFile => ({
  schema: 'aio.gcp/1',
  crs: { epsg: 32639 },
  importedFrom: 'gcp.csv',
  points: [
    {
      id: 'GCP1',
      role: 'control',
      xyz: [245900, 3179600, 12.3],
      accuracy: { horizontalM: 0.02, verticalM: 0.03 },
      marks: [],
    },
  ],
});

describe('processing verdict and GPUs', () => {
  it('offers processing on Windows x64 and macOS arm64 with pack 0.4.0 or later only', () => {
    expect(processingVerdict('win32', 'x64', '0.4.0')).toBe('available');
    expect(processingVerdict('darwin', 'arm64', '0.4.2')).toBe('available');
    expect(processingVerdict('win32', 'x64', 'dev')).toBe('available');
    expect(processingVerdict('darwin', 'x64', '0.4.0')).toBe('unsupported-platform');
    expect(processingVerdict('win32', 'arm64', '0.4.0')).toBe('unsupported-platform');
    expect(processingVerdict('linux', 'x64', '0.4.0')).toBe('unsupported-platform');
    expect(processingVerdict('win32', 'x64', '0.3.0')).toBe('pack-too-old');
    expect(processingVerdict('win32', 'x64', '0.4.0-rc1')).toBe('pack-too-old');
    expect(processingVerdict('win32', 'x64', null)).toBe('no-pack');
  });

  it('names GPUs from Electron basic info and leaves software renderers out', () => {
    expect(
      gpusFromInfo({
        gpuDevice: [
          { vendorId: 0x10de, deviceId: 0x2786, deviceString: 'NVIDIA GeForce RTX 4070' },
          { vendorId: 0x8086, deviceId: 0x1 },
          { vendorId: 0x1af4, deviceString: 'Google SwiftShader' },
          { vendorId: 0x1414, deviceId: 0x8c, deviceString: 'Microsoft Basic Render Driver' },
        ],
      }),
    ).toEqual([
      { name: 'NVIDIA GeForce RTX 4070', vendor: 'NVIDIA' },
      { name: 'Intel GPU', vendor: 'Intel' },
    ]);
    expect(gpusFromInfo(null)).toEqual([]);
    expect(gpusFromInfo({ gpuDevice: 'x' })).toEqual([]);
  });

  it('picks the UTM zone of a position', () => {
    expect(utmEpsg(29.07, 48.12)).toBe(32639);
    expect(utmEpsg(-33.9, 18.4)).toBe(32734);
    expect(utmEpsg(51.5, -0.1)).toBe(32630);
  });
});

describe('estimate', () => {
  it('reproduces the plan reference: 500 photos of 20 MP on 8 cores', () => {
    const all = ['cloud', 'dsm', 'dtm', 'ortho'] as const;
    expect(estimateRun(photoSet(), 'fast', all, HW).minutes).toEqual([30, 60]);
    expect(estimateRun(photoSet(), 'standard', all, HW).minutes).toEqual([180, 360]);
    const high = estimateRun(photoSet(), 'high', all, HW);
    expect(high.minutes).toEqual([600, 1200]);
    expect(high.notes?.join(' ')).toMatch(/High runs on the CPU here/);
    expect(estimateRun(photoSet(), 'high', all, { ...HW, cuda: true }).minutes).toEqual([120, 240]);
  });

  it('scales with the photos, the cores and the products', () => {
    const base = estimateRun(photoSet(), 'standard', ['ortho'], HW).minutes;
    const twice = estimateRun(photoSet({ count: 1000 }), 'standard', ['ortho'], HW).minutes;
    expect(twice[0]).toBeGreaterThan(base[0] * 2);
    const sixteen = estimateRun(photoSet(), 'standard', ['ortho'], {
      ...HW,
      cpu: { model: 'x', cores: 16 },
    }).minutes;
    expect(sixteen[1]).toBeLessThan(base[1]);
    const mesh = estimateRun(photoSet(), 'standard', ['ortho', 'mesh'], HW).minutes;
    expect(mesh[1]).toBeGreaterThan(base[1]);
    // alignment only: a quarter of Standard
    expect(estimateRun(photoSet(), 'standard', [], HW).minutes).toEqual([45, 90]);
    expect(estimateRun(photoSet({ count: 0 }), 'standard', ['ortho'], HW).minutes).toEqual([0, 0]);
  });

  it('estimates disk from the photos and refuses in words when the drive is short', () => {
    const e = estimateRun(photoSet(), 'standard', ['ortho'], { ...HW, freeDiskBytes: 21 * GB });
    // 4000 MB of photos, 15 times at Standard
    expect(e.diskBytes).toBe(500 * 8 * 1024 ** 2 * 15);
    expect(e.notes?.join(' ')).toMatch(/Needs 59 GB free on the data drive, has 21 GB/);
  });

  it('caps memory on a 16 GB laptop with a plain-words note', () => {
    const e = estimateRun(photoSet(), 'standard', ['ortho'], { ...HW, memoryBytes: 16 * GB });
    expect(e.memoryBytes).toBeLessThanOrEqual(12 * GB);
    expect(e.notes?.join(' ')).toMatch(/Standard on 16 GB: images at half size/);
  });

  it('lists the camera groups and photos without GPS', () => {
    const e = estimateRun(
      photoSet({
        count: 60,
        noGps: 1,
        groups: [
          { label: 'Stratlas Synthetic SYN-20', widthPx: 1600, heightPx: 1200, photos: 58 },
          { label: 'Unknown camera', photos: 2 },
        ],
      }),
      'fast',
      ['ortho'],
      HW,
    );
    const notes = e.notes?.join('\n') ?? '';
    expect(notes).toContain('Camera group: Stratlas Synthetic SYN-20, 1600 × 1200 (58 photos).');
    expect(notes).toContain('Camera group: Unknown camera (2 photos).');
    expect(notes).toContain('Mixed cameras');
    expect(notes).toContain('1 photo has no GPS position');
  });
});

describe('poses and runs', () => {
  it('measures how far each camera moves', () => {
    const m = poseMoves(
      [
        { id: 'a', pos: [0, 0, 0] },
        { id: 'b', pos: [0, 0, 0] },
        { id: 'c', pos: [0, 0, 0] },
        { id: 'd' },
      ],
      new Map([
        ['a', { pos: [3, 4, 0] }],
        ['b', { pos: [0, 1, 0] }],
        ['c', { pos: [0, 0, 2] }],
        ['d', { pos: [9, 9, 9] }],
      ]),
    );
    expect(m).toEqual({ cameras: 3, medianMoveM: 2, maxMoveM: 5 });
  });

  it('summarises a run with its products in the contract order', () => {
    const s = summariseRun(
      sampleRun({
        status: 'done',
        settings: { products: ['mesh', 'ortho', 'nonsense'] },
        stages: [
          { name: 'dsm', state: 'done' },
          { name: 'cloud', state: 'skipped' },
        ],
        accuracy: { meanReprojPx: 0.6 },
      }),
    );
    expect(s).toEqual({
      id: RUN,
      createdAt: '2026-10-07T09:15:00Z',
      status: 'done',
      preset: 'standard',
      photos: 3,
      products: ['dsm', 'ortho', 'mesh'],
      accuracy: { meanReprojPx: 0.6 },
    });
  });
});

describe('photo files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aio-photo-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists photos a few folders deep, skipping hidden folders and other files', async () => {
    await mkdir(join(dir, 'DCIM', '100MEDIA'), { recursive: true });
    await mkdir(join(dir, '.thumbs'), { recursive: true });
    await writeFile(join(dir, 'DCIM', '100MEDIA', 'DJI_0002.JPG'), 'x');
    await writeFile(join(dir, 'DCIM', '100MEDIA', 'DJI_0001.jpg'), 'x');
    await writeFile(join(dir, 'DCIM', '100MEDIA', 'DJI_0001.MP4'), 'x');
    await writeFile(join(dir, '.thumbs', 'a.jpg'), 'x');
    await writeFile(join(dir, 'ortho.tif'), 'x');
    const files = await listPhotoFiles([dir]);
    expect(files.map((f) => f.slice(dir.length + 1).replace(/\\/g, '/'))).toEqual([
      'DCIM/100MEDIA/DJI_0001.jpg',
      'DCIM/100MEDIA/DJI_0002.JPG',
      'ortho.tif',
    ]);
  });

  it('reads camera groups, the frame size and GPS from the photo heads', async () => {
    const a = withExif({
      make: 'Stratlas Synthetic',
      model: 'SYN-20',
      width: 1600,
      height: 1200,
      lat: 29.07,
      lon: 48.12,
    });
    const b = withExif({ make: 'Stratlas Synthetic', model: 'SYN-20', width: 1600, height: 1200 });
    const files = [join(dir, 'a.jpg'), join(dir, 'b.jpg'), join(dir, 'c.jpg')];
    await writeFile(files[0] ?? '', a);
    await writeFile(files[1] ?? '', a);
    await writeFile(files[2] ?? '', b);
    const set = await readPhotoSet(files);
    expect(set.count).toBe(3);
    expect(set.megapixels).toBeCloseTo(1.92, 5);
    expect(set.groups).toEqual([
      { label: 'Stratlas Synthetic SYN-20', widthPx: 1600, heightPx: 1200, photos: 3 },
    ]);
    expect(set.noGps).toBe(1);
    expect(set.centre?.lat).toBeCloseTo(29.07, 5);
    expect(set.bytes).toBe(a.length * 2 + b.length);
  });
});

describe('photo IPC', () => {
  let root: string;
  let pkg: ReturnType<PhotoProjects['package']>;
  const trash = vi.fn((p: string) => rm(p, { recursive: true, force: true }));
  const projects: PhotoProjects = {
    root: (id) => (id === 'p' ? root : undefined),
    package: (id) => (id === 'pkg' ? pkg : undefined),
  };
  let ipc: ReturnType<typeof collectHandlers>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aio-photo-ipc-'));
    await writeFile(join(root, 'manifest.json'), JSON.stringify(photosManifest()));
    await mkdir(join(root, 'photogrammetry', RUN, 'report'), { recursive: true });
    await writeFile(
      join(root, 'photogrammetry', RUN, 'run.json'),
      JSON.stringify(sampleRun({ accuracy: { meanReprojPx: 0.5 } })),
    );
    const files = new Map<string, Buffer>([
      [`photogrammetry/${RUN}/run.json`, Buffer.from(JSON.stringify(sampleRun()))],
    ]);
    pkg = {
      manifest: photosManifest(),
      archive: {
        entries: files,
        read: (n: string) => Promise.resolve(files.get(n) ?? Buffer.alloc(0)),
      },
    };
    trash.mockClear();
    ipc = collectHandlers((handle) => {
      registerPhotogrammetryIpc({
        handle,
        projects,
        system: fakeSystem({
          gpus: () => Promise.resolve([{ name: 'NVIDIA GeForce RTX 4070', vendor: 'NVIDIA' }]),
        }),
        trash,
        now: () => new Date('2026-10-07T10:00:00Z'),
      });
    });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('registers every photo channel', () => {
    expect(ipc.channels()).toEqual([
      'photo:applyPoses',
      'photo:cleanWork',
      'photo:estimate',
      'photo:probe',
      'photo:readGcp',
      'photo:readRun',
      'photo:runs',
      'photo:writeGcp',
    ]);
  });

  it('probes this computer once and measures free disk on each call', async () => {
    const free = vi.fn(() => Promise.resolve(100 * GB));
    const gpus = vi.fn(() => Promise.resolve([]));
    const probed = collectHandlers((handle) => {
      registerPhotogrammetryIpc({ handle, system: fakeSystem({ freeDiskBytes: free, gpus }) });
    });
    const r = await probed.call('photo:probe', {});
    expect(r).toMatchObject({
      ok: true,
      probe: {
        platform: 'win32',
        cpu: { model: 'Synthetic 8-core CPU', cores: 8, threads: 16 },
        memoryBytes: 32 * GB,
        freeDiskBytes: 100 * GB,
        cuda: false,
        processing: 'available',
      },
    });
    await probed.call('photo:probe', {});
    expect(gpus).toHaveBeenCalledTimes(1);
    expect(free.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('answers without a system in tests and old wiring', async () => {
    const bare = collectHandlers((handle) => {
      registerPhotogrammetryIpc({ handle });
    });
    expect(await bare.call('photo:probe', {})).toMatchObject({ ok: false });
    expect(await bare.call('photo:runs', { projectId: 'p' })).toMatchObject({ ok: false });
  });

  it('estimates a photos layer and a folder', async () => {
    await mkdir(join(root, 'photos'));
    const jpeg = withExif({
      make: 'Stratlas Synthetic',
      model: 'SYN-20',
      width: 1600,
      height: 1200,
      lat: 29.07,
      lon: 48.12,
    });
    for (const n of ['p1', 'p2', 'p3']) await writeFile(join(root, 'photos', `${n}.jpg`), jpeg);
    const layer = await ipc.call('photo:estimate', {
      projectId: 'p',
      photos: { layer: 'photos' },
      preset: 'fast',
      products: ['ortho'],
    });
    expect(layer).toMatchObject({ ok: true });
    if (!layer.ok) return;
    expect(layer.estimate.minutes[0]).toBeGreaterThan(0);
    expect(layer.estimate.notes?.[0]).toBe('The photos are in UTM zone 39N (EPSG:32639).');
    expect(layer.estimate.notes).toContain(
      'Camera group: Stratlas Synthetic SYN-20, 1600 × 1200 (3 photos).',
    );
    const folder = await ipc.call('photo:estimate', {
      photos: { folders: [join(root, 'photos')] },
      preset: 'fast',
      products: ['ortho'],
    });
    expect(folder).toMatchObject({ ok: true });
    expect(
      await ipc.call('photo:estimate', {
        photos: { folders: ['photos'] },
        preset: 'fast',
        products: [],
      }),
    ).toMatchObject({ ok: false, error: 'Choose a whole folder path, not "photos".' });
    expect(
      await ipc.call('photo:estimate', {
        projectId: 'p',
        photos: { layer: 'nope' },
        preset: 'fast',
        products: [],
      }),
    ).toMatchObject({ ok: false });
    expect(
      await ipc.call('photo:estimate', {
        projectId: 'pkg',
        photos: { layer: 'photos' },
        preset: 'fast',
        products: [],
      }),
    ).toMatchObject({ ok: false, code: 'read-only' });
  });

  it('lists runs newest first, skipping a broken one, in folders and packages', async () => {
    const later = '20261008-0800';
    await mkdir(join(root, 'photogrammetry', later));
    await writeFile(
      join(root, 'photogrammetry', later, 'run.json'),
      JSON.stringify(sampleRun({ id: later, createdAt: '2026-10-08T08:00:00Z' })),
    );
    await mkdir(join(root, 'photogrammetry', 'broken'));
    await writeFile(join(root, 'photogrammetry', 'broken', 'run.json'), '{');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await ipc.call('photo:runs', { projectId: 'p' });
    warn.mockRestore();
    expect(r.ok && r.runs.map((x) => x.id)).toEqual([later, RUN]);
    const p = await ipc.call('photo:runs', { projectId: 'pkg' });
    expect(p.ok && p.runs.map((x) => x.id)).toEqual([RUN]);
    expect(await ipc.call('photo:runs', { projectId: 'gone' })).toMatchObject({ ok: false });
  });

  it('reads a run with and without its accuracy report', async () => {
    const r = await ipc.call('photo:readRun', { projectId: 'p', run: RUN });
    expect(r).toMatchObject({ ok: true, run: { id: RUN }, accuracy: null });
    const report = {
      schema: 'aio.photo-accuracy/1',
      run: RUN,
      createdAt: '2026-10-07T10:00:00Z',
      crs: { epsg: 32639 },
      images: { total: 3, registered: 3 },
      meanReprojPx: 0.6,
      points: [
        { id: 'GCP1', role: 'check', dxM: 0.01, dyM: -0.02, dzM: 0.03, reprojPx: 0.5, marks: 3 },
      ],
      rmse: { check: { n: 1, horizontalM: 0.022, verticalM: 0.03 } },
      checkpointsInAdjustment: false,
      warnings: [],
    };
    await writeFile(
      join(root, 'photogrammetry', RUN, 'report', 'accuracy.json'),
      JSON.stringify(report),
    );
    expect(await ipc.call('photo:readRun', { projectId: 'p', run: RUN })).toMatchObject({
      ok: true,
      accuracy: { meanReprojPx: 0.6 },
    });
    // a report that claims checkpoints were adjusted is not one this app shows
    await writeFile(
      join(root, 'photogrammetry', RUN, 'report', 'accuracy.json'),
      JSON.stringify({ ...report, checkpointsInAdjustment: true }),
    );
    expect(await ipc.call('photo:readRun', { projectId: 'p', run: RUN })).toMatchObject({
      ok: false,
    });
    expect(await ipc.call('photo:readRun', { projectId: 'p', run: 'nope' })).toMatchObject({
      ok: false,
      error: 'There is no run "nope" in this project.',
    });
  });

  it('writes gcp.json atomically with a .bak and refuses packages', async () => {
    expect(await ipc.call('photo:readGcp', { projectId: 'p', run: RUN })).toEqual({
      ok: true,
      gcp: null,
    });
    const first = sampleGcp();
    expect(await ipc.call('photo:writeGcp', { projectId: 'p', run: RUN, gcp: first })).toEqual({
      ok: true,
    });
    const second: GcpFile = {
      ...first,
      points: first.points.map((p) => ({ ...p, role: 'check' as const })),
    };
    expect(await ipc.call('photo:writeGcp', { projectId: 'p', run: RUN, gcp: second })).toEqual({
      ok: true,
    });
    const file = join(root, 'photogrammetry', RUN, 'gcp.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ points: [{ role: 'check' }] });
    expect(JSON.parse(await readFile(`${file}.bak`, 'utf8'))).toMatchObject({
      points: [{ role: 'control' }],
    });
    expect(await ipc.call('photo:readGcp', { projectId: 'p', run: RUN })).toMatchObject({
      ok: true,
      gcp: { points: [{ id: 'GCP1', role: 'check' }] },
    });
    expect(
      await ipc.call('photo:writeGcp', { projectId: 'pkg', run: RUN, gcp: first }),
    ).toMatchObject({ ok: false, code: 'read-only' });
    expect(
      await ipc.call('photo:writeGcp', { projectId: 'p', run: 'other', gcp: first }),
    ).toMatchObject({ ok: false, error: 'There is no run "other" in this project.' });
  });

  it('refuses a gcp.json changed by someone else since it was read', async () => {
    const file = join(root, 'photogrammetry', RUN, 'gcp.json');
    await writeFile(file, JSON.stringify(sampleGcp()));
    await ipc.call('photo:readGcp', { projectId: 'p', run: RUN });
    await writeFile(file, JSON.stringify({ ...sampleGcp(), importedFrom: 'other.csv' }));
    const r = await ipc.call('photo:writeGcp', { projectId: 'p', run: RUN, gcp: sampleGcp() });
    expect(r).toMatchObject({ ok: false });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ importedFrom: 'other.csv' });
  });

  it('previews and applies refined poses, keeping the old poses and the manifest', async () => {
    const noRefined = await ipc.call('photo:applyPoses', {
      projectId: 'p',
      run: RUN,
      layer: 'photos',
      apply: false,
    });
    expect(noRefined).toMatchObject({ ok: false });
    await writeFile(
      join(root, 'photogrammetry', RUN, 'cameras-sfm.json'),
      JSON.stringify({
        cameras: [
          { id: 'p1', pos: [0.3, 60.4, 0], q: [0, 0, 0, 1] },
          { id: 'p2', pos: [10, 60.1, 0] },
          {
            photo: 'p3',
            pos: [20, 60, 0.2],
            lens: { model: 'pinhole', hfovDeg: 70, aspect: 1.333 },
          },
        ],
      }),
    );
    const preview = await ipc.call('photo:applyPoses', {
      projectId: 'p',
      run: RUN,
      layer: 'photos',
      apply: false,
    });
    expect(preview).toMatchObject({ ok: true, cameras: 3, applied: false });
    if (!preview.ok) return;
    expect(preview.medianMoveM).toBeCloseTo(0.2, 6);
    expect(preview.maxMoveM).toBeCloseTo(0.5, 6);
    const before = await readFile(join(root, 'manifest.json'), 'utf8');
    expect(
      await ipc.call('photo:applyPoses', {
        projectId: 'p',
        run: RUN,
        layer: 'photos',
        apply: true,
      }),
    ).toMatchObject({ ok: true, applied: true, cameras: 3 });
    const m = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as ProjectManifest;
    const items = (m.layers[0] as Extract<ProjectManifest['layers'][number], { kind: 'photos' }>)
      .items;
    expect(items[0]?.pos).toEqual([0.3, 60.4, 0]);
    expect(items[0]?.q).toEqual([0, 0, 0, 1]);
    expect(items[2]?.lens).toEqual({ model: 'pinhole', hfovDeg: 70, aspect: 1.333 });
    expect(await readFile(join(root, 'manifest.json.bak'), 'utf8')).toBe(before);
    const kept = JSON.parse(
      await readFile(join(root, 'photogrammetry', RUN, 'cameras.json.bak'), 'utf8'),
    ) as { layer: string; cameras: { id: string; pos: number[] }[] };
    expect(kept.layer).toBe('photos');
    expect(kept.cameras[0]).toEqual({ id: 'p1', pos: [0, 60, 0] });
    expect(
      await ipc.call('photo:applyPoses', {
        projectId: 'pkg',
        run: RUN,
        layer: 'photos',
        apply: true,
      }),
    ).toMatchObject({ ok: false, code: 'read-only' });
    expect(
      await ipc.call('photo:applyPoses', {
        projectId: 'p',
        run: RUN,
        layer: 'plant',
        apply: false,
      }),
    ).toMatchObject({ ok: false });
  });

  it('moves only the work folder to the recycle bin, with the bytes freed', async () => {
    const work = join(root, 'photogrammetry', RUN, 'work');
    await mkdir(join(work, 'dense'), { recursive: true });
    await writeFile(join(work, 'dense', 'a.bin'), Buffer.alloc(1000));
    await writeFile(join(work, 'b.bin'), Buffer.alloc(24));
    await writeFile(join(root, 'photogrammetry', RUN, 'ortho.tif'), 'keep');
    expect(await ipc.call('photo:cleanWork', { projectId: 'p', run: RUN })).toEqual({
      ok: true,
      freedBytes: 1024,
    });
    expect(trash).toHaveBeenCalledWith(work);
    expect(await readFile(join(root, 'photogrammetry', RUN, 'ortho.tif'), 'utf8')).toBe('keep');
    expect(await ipc.call('photo:cleanWork', { projectId: 'p', run: RUN })).toEqual({
      ok: true,
      freedBytes: 0,
    });
    expect(await ipc.call('photo:cleanWork', { projectId: 'pkg', run: RUN })).toMatchObject({
      ok: false,
      code: 'read-only',
    });
  });
});
