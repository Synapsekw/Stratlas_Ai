import { createProject, readManifestFile, updateManifestFile } from '@aio/project/builder';
import { withExif } from '@aio/project/builder/testing';
import type { JobEvent, JobRecord, PanoStitchFile, ProjectManifest } from '@aio/schema';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PANO_IMPORT_BUSY,
  panoThumbs,
  relayJobEvent,
  fileLaneRun,
  fileThenSend,
  laneSphere,
  stitchLane,
  panoImportAnswer,
  panoPackRefusal,
  panoScanCache,
  panoStitchFiler,
  scanPanoPaths,
  startPanoStitches,
  stitchOutcome,
  withPanoStitches,
  type PanoImportAnswerDeps,
} from './panos';

let dir: string;
let root: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-main-panos-'));
  root = (
    await createProject(dir, {
      name: 'P',
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

/** A card folder with one sphere (rows at 0 and -35, 8 yaws each) and two mapping photos. */
async function card(): Promise<string> {
  const folder = join(dir, 'card', '100MEDIA');
  await mkdir(folder, { recursive: true });
  let n = 0;
  const shot = async (yaw: number, pitch: number, s: number, lon = 51.0) => {
    n++;
    const time = `2026:09:10 10:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    await writeFile(
      join(folder, `SYN_${String(n).padStart(4, '0')}.JPG`),
      withExif({
        make: 'DJI',
        dateTimeOriginal: time,
        width: 5472,
        height: 3648,
        dji: {
          GpsLatitude: '28.9',
          GpsLongitude: String(lon),
          AbsoluteAltitude: '620',
          RelativeAltitude: '70',
          GimbalYawDegree: String(yaw),
          GimbalPitchDegree: String(pitch),
          GimbalRollDegree: '0',
        },
      }),
    );
  };
  let s = 0;
  for (const pitch of [0, -35])
    for (let yaw = -180; yaw < 180; yaw += 45) await shot(yaw, pitch, (s += 6));
  await shot(90, -90, 600, 51.01);
  await shot(90, -90, 602, 51.0102);
  return join(dir, 'card');
}

const noThumb = { thumb: () => Promise.resolve(undefined) };

describe('scanPanoPaths', () => {
  it('finds the sphere, lists the mapping photos and keeps thumbnails and the day', async () => {
    const seen: number[] = [];
    const r = await scanPanoPaths(root, [await card()], {
      thumb: () => Promise.resolve('data:image/jpeg;base64,AAAA'),
      onProgress: (d) => seen.push(d),
      newId: () => 'scan-1',
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.scan).toMatchObject({ scanId: 'scan-1', files: 18, day: '2026-09-10' });
    expect(r.scan.spheres).toHaveLength(1);
    expect(r.scan.spheres[0]).toMatchObject({
      key: 's1',
      shape: 'sphere',
      frames: 16,
      incomplete: false,
      relAlt: 70,
      thumb: 'data:image/jpeg;base64,AAAA',
    });
    expect(r.scan.spheres[0]?.alreadyIn).toBeUndefined();
    expect(r.scan.skipped.map((s) => s.reason)).toEqual(['few-frames', 'few-frames']);
    expect(seen.at(-1)).toBe(18);
    expect(r.grouping.spheres[0]?.frames).toHaveLength(16);
    expect(r.scan.spheres[0]?.files[0]).toMatch(/SYN_0001\.JPG$/);
  });

  it('gives every scan its own id, a rescan of the same folder too', async () => {
    const folder = await card();
    const a = await scanPanoPaths(root, [folder], noThumb);
    const b = await scanPanoPaths(root, [folder], noThumb);
    if ('error' in a || 'error' in b) throw new Error('scan failed');
    expect(a.scan.scanId).not.toBe(b.scan.scanId);
    expect(a.scan.scanId.length).toBeLessThanOrEqual(64);
  });

  it('says so when there is nothing to read', async () => {
    await mkdir(join(dir, 'empty'));
    expect(await scanPanoPaths(root, [join(dir, 'empty')], noThumb)).toEqual({
      error: 'There are no JPEG files there.',
    });
  });
});

describe('panoScanCache', () => {
  it('keeps the newest scans per project and forgets the oldest', () => {
    const c = panoScanCache(2);
    const g = { spheres: [], ready: [] };
    const scan = (id: string) => ({
      scanId: id,
      spheres: [],
      ready: [],
      skipped: [],
      files: 0,
      day: null,
    });
    c.put('p', scan('a'), g);
    c.put('p', scan('b'), g);
    c.put('p', scan('c'), g);
    expect(c.get('a', 'p')).toBeNull();
    expect(c.get('c', 'p')).toBe(g);
    expect(c.get('c', 'other')).toBeNull();
    c.drop('c');
    expect(c.get('c', 'p')).toBeNull();
  });
});

describe('pack gate', () => {
  it('asks for processing tools 0.7.0 for pano.stitch only', () => {
    expect(panoPackRefusal('pano.stitch', '0.6.0')).toBe(
      'Stitching drone panoramas needs processing tools 0.7.0 or later (these are 0.6.0). Update them in Settings, Processing tools.',
    );
    expect(panoPackRefusal('pano.stitch', '0.7.0')).toBeNull();
    expect(panoPackRefusal('pano.stitch', 'dev')).toBeNull();
    expect(panoPackRefusal('pano.stitch', null)).toBeNull();
    expect(panoPackRefusal('walk.process', '0.6.0')).toBeNull();
  });
});

describe('startPanoStitches', () => {
  it('starts one job per sphere and stops at the first refusal', async () => {
    const start = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, job: { id: 'j1' } })
      .mockResolvedValueOnce({ ok: false, error: 'No processing tools.' });
    const r = await startPanoStitches({
      root,
      layerId: 'l',
      panos: ['p01', 'p02', 'p03'],
      quality: 'standard',
      jobs: { start },
      packVersion: () => Promise.resolve('0.7.0'),
    });
    expect(r).toEqual({ runs: { p01: 'j1' }, queued: 0, refused: 'No processing tools.' });
    expect(start).toHaveBeenCalledWith({
      pipeline: 'pano.stitch',
      project: root,
      params: { layer: 'l', pano: 'p01', quality: 'standard' },
    });
  });

  it("passes the scan's shape of each sphere", async () => {
    const start = vi.fn().mockResolvedValue({ ok: true, job: { id: 'j' } });
    await startPanoStitches({
      root,
      layerId: 'l',
      panos: ['p01', 'p02'],
      quality: 'standard',
      shapes: { p01: 'sphere', p02: 'wide' },
      jobs: { start },
      packVersion: () => Promise.resolve('0.7.0'),
    });
    expect(start.mock.calls.map((c) => (c[0] as { params: unknown }).params)).toEqual([
      { layer: 'l', pano: 'p01', quality: 'standard', shape: 'sphere' },
      { layer: 'l', pano: 'p02', quality: 'standard', shape: 'wide' },
    ]);
  });

  it('starts nothing on a pack that is too old', async () => {
    const start = vi.fn();
    const r = await startPanoStitches({
      root,
      layerId: 'l',
      panos: ['p01'],
      quality: 'high',
      jobs: { start },
      packVersion: () => Promise.resolve('0.6.0'),
    });
    expect(r.runs).toEqual({});
    expect(r.refused).toMatch(/needs processing tools 0.7.0/);
    expect(start).not.toHaveBeenCalled();
  });
});

describe('panoImportAnswer', () => {
  const answerDeps = (
    scans: ReturnType<typeof panoScanCache>,
    start = vi
      .fn()
      .mockResolvedValue({ ok: true, job: { id: '20261013-101500-pano-stitch-a1b2' } }),
  ): PanoImportAnswerDeps => ({
    root: (id) => (id === 'p' ? root : undefined),
    scans,
    images: { resizeJpeg: (src, dst) => copyFile(src, dst) },
    jobs: { start },
    packVersion: () => Promise.resolve('0.7.0'),
    progress: () => undefined,
    freeBytes: () => Promise.resolve(1e15),
  });

  async function scanned(scans: ReturnType<typeof panoScanCache>) {
    const r = await scanPanoPaths(root, [await card()], noThumb);
    if ('error' in r) throw new Error(r.error);
    scans.put('p', r.scan, r.grouping);
    return r.scan;
  }

  it('imports, starts each stitch with its shape and marks the frames already in on a rescan (Review Focus 1)', async () => {
    const scans = panoScanCache();
    const scan = await scanned(scans);
    const start = vi
      .fn()
      .mockResolvedValue({ ok: true, job: { id: '20261013-101500-pano-stitch-a1b2' } });
    const r = await panoImportAnswer(
      {
        projectId: 'p',
        scanId: scan.scanId,
        keys: ['s1'],
        layerName: 'Spheres',
        quality: 'standard',
      },
      answerDeps(scans, start),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.started).toBe(1);
    expect(start).toHaveBeenCalledWith({
      pipeline: 'pano.stitch',
      project: root,
      params: { layer: r.layerId, pano: 'p01', shape: 'sphere', quality: 'standard' },
    });
    const layer = r.manifest.layers.find((l) => l.id === r.layerId);
    expect(layer?.kind === 'panoramas' && layer.items[0]?.stitch).toEqual({
      run: '20261013-101500-pano-stitch-a1b2',
      status: 'queued',
    });
    // the scan is used up
    expect(scans.get(scan.scanId, 'p')).toBeNull();
    // the same folder again: the sphere is already in that layer
    const again = await scanPanoPaths(root, [join(dir, 'card')], noThumb);
    if ('error' in again) throw new Error(again.error);
    expect(again.scan.spheres[0]?.alreadyIn).toBe('Spheres');
  });

  it('runs one panorama import per project at a time', async () => {
    const scans = panoScanCache();
    const scan = await scanned(scans);
    const second = await scanned(scans);
    const deps = answerDeps(scans);
    const req = (scanId: string) => ({
      projectId: 'p',
      scanId,
      keys: ['s1'],
      layerName: 'Spheres',
      quality: 'standard' as const,
    });
    const first = panoImportAnswer(req(scan.scanId), deps);
    const busy = await panoImportAnswer(req(second.scanId), deps);
    expect(busy).toEqual({ ok: false, error: PANO_IMPORT_BUSY });
    expect((await first).ok).toBe(true);
    // free again once the first returned
    expect((await panoImportAnswer(req(second.scanId), deps)).ok).toBe(true);
  });

  it('answers a stale scan and a closed project', async () => {
    const deps = answerDeps(panoScanCache());
    const req = { scanId: 'gone', keys: ['s1'], layerName: 'L', quality: 'standard' as const };
    expect(await panoImportAnswer({ projectId: 'p', ...req }, deps)).toMatchObject({
      ok: false,
      code: 'stale-scan',
    });
    expect(await panoImportAnswer({ projectId: 'x', ...req }, deps)).toMatchObject({ ok: false });
  });
});

const job = (over: Partial<JobRecord>): JobRecord => ({
  id: '20261013-101500-pano-stitch-a1b2',
  pipeline: 'pano.stitch',
  project: 'D:/p',
  params: { layer: 'l', pano: 'p01' },
  status: 'running',
  progress: 0.5,
  steps: [],
  artifacts: [],
  createdAt: '2026-10-13T10:15:00Z',
  updatedAt: '2026-10-13T10:16:00Z',
  ...over,
});

describe('stitchOutcome', () => {
  it('maps job states to item states and leaves running jobs to the live view', () => {
    expect(stitchOutcome(job({ status: 'done' }))).toEqual({
      layer: 'l',
      pano: 'p01',
      run: job({}).id,
      status: 'done',
    });
    expect(stitchOutcome(job({ status: 'failed', error: 'Too few frames' }))).toMatchObject({
      status: 'failed',
      error: 'Too few frames',
    });
    expect(stitchOutcome(job({ status: 'interrupted' }))).toMatchObject({
      status: 'failed',
      error: 'The stitch stopped when the app closed. Stitch again.',
    });
    expect(stitchOutcome(job({ status: 'cancelled' }))).toMatchObject({ status: 'queued' });
    expect(stitchOutcome(job({ status: 'running' }))).toBeNull();
    expect(stitchOutcome(job({ pipeline: 'walk.process', status: 'done' }))).toBeNull();
    expect(stitchOutcome(job({ status: 'done', params: { layer: 'l' } }))).toBeNull();
  });
});

describe('panoStitchFiler and fileThenSend (Review Focus 5)', () => {
  const done: JobEvent = { type: 'update', job: job({ status: 'done' }) };

  it('files a finished stitch once, with its record, before the renderer hears of it', async () => {
    const order: string[] = [];
    const update = vi.fn(() => {
      order.push('file');
      return Promise.resolve();
    });
    const readRecord = vi.fn(() => Promise.resolve({ run: job({}).id } as PanoStitchFile));
    const filer = panoStitchFiler({ update, readRecord });
    expect(filer.files(done)).toBe(true);
    expect(filer.files({ type: 'update', job: job({}) })).toBe(false);
    await fileThenSend(filer, done, () => order.push('send'));
    await fileThenSend(filer, done, () => order.push('send'));
    expect(order).toEqual(['file', 'send', 'send']);
    expect(readRecord).toHaveBeenCalledWith('D:/p', 'l', 'p01');
  });

  it('still sends the event when filing fails', async () => {
    const filer = panoStitchFiler({
      update: () => Promise.reject(new Error('disk')),
      readRecord: () => Promise.resolve(null),
      log: () => undefined,
    });
    const send = vi.fn();
    await fileThenSend(filer, done, send);
    expect(send).toHaveBeenCalledOnce();
  });

  it('files into the fresh manifest and keeps an edit the renderer saved meanwhile', async () => {
    const scans = panoScanCache();
    const r0 = await scanPanoPaths(root, [await card()], noThumb);
    if ('error' in r0) throw new Error(r0.error);
    scans.put('p', r0.scan, r0.grouping);
    const imported = await panoImportAnswer(
      { projectId: 'p', scanId: r0.scan.scanId, keys: ['s1'], layerName: 'S', quality: 'standard' },
      {
        root: () => root,
        scans,
        images: { resizeJpeg: (src, dst) => copyFile(src, dst) },
        jobs: {
          start: () =>
            Promise.resolve({ ok: true as const, job: { id: '20261013-101500-pano-stitch-a1b2' } }),
        },
        packVersion: () => Promise.resolve('0.7.0'),
        progress: () => undefined,
        freeBytes: () => Promise.resolve(1e15),
      },
    );
    if (!imported.ok) throw new Error(imported.error);
    const layerId = imported.layerId;
    const panoLayer = imported.manifest.layers.find((l) => l.id === layerId);
    const pano = panoLayer?.kind === 'panoramas' ? (panoLayer.items[0]?.id ?? '') : '';
    // the renderer hides the layer just before the stitch fails
    await updateManifestFile(root, (m) => ({
      manifest: {
        ...m,
        layers: m.layers.map((l) => (l.id === layerId ? { ...l, visible: false } : l)),
      },
    }));
    const filer = panoStitchFiler({
      update: async (at, change) => {
        await updateManifestFile(at, (m) => ({ manifest: change(m) }));
      },
      readRecord: () => Promise.resolve(null),
    });
    const failed: JobEvent = {
      type: 'update',
      job: job({
        project: root,
        params: { layer: layerId, pano },
        status: 'failed',
        error: 'x'.repeat(500),
      }),
    };
    // what the renderer reloads when the event reaches it
    const reloads: Promise<ProjectManifest>[] = [];
    await fileThenSend(filer, failed, () => {
      reloads.push(readManifestFile(root));
    });
    const [reload] = reloads;
    if (!reload) throw new Error('the event was not sent');
    const l = (await reload).layers.find((x) => x.id === layerId);
    expect(l?.visible).toBe(false);
    const item = l?.kind === 'panoramas' ? l.items[0] : undefined;
    expect(item?.stitch?.status).toBe('failed');
    expect(item?.stitch?.error).toHaveLength(400);
  });
});

describe('withPanoStitches', () => {
  it('leaves a project without pano layers alone and never fails the open', async () => {
    const m = await readManifestFile(root);
    const reread = vi.fn();
    expect(await withPanoStitches(root, { ok: true, value: m }, () => undefined, reread)).toEqual({
      ok: true,
      value: m,
    });
    expect(reread).not.toHaveBeenCalled();
    expect(
      await withPanoStitches(root, { ok: false, error: 'bad' }, () => undefined, reread),
    ).toEqual({ ok: false, error: 'bad' });
  });

  it('files a stitch that finished while the app was closed, then reads the manifest again', async () => {
    const scans = panoScanCache();
    const r0 = await scanPanoPaths(root, [await card()], noThumb);
    if ('error' in r0) throw new Error(r0.error);
    scans.put('p', r0.scan, r0.grouping);
    const run = '20261013-101500-pano-stitch-a1b2';
    const imported = await panoImportAnswer(
      { projectId: 'p', scanId: r0.scan.scanId, keys: ['s1'], layerName: 'S', quality: 'standard' },
      {
        root: () => root,
        scans,
        images: { resizeJpeg: (src, dst) => copyFile(src, dst) },
        jobs: { start: () => Promise.resolve({ ok: true as const, job: { id: run } }) },
        packVersion: () => Promise.resolve('0.7.0'),
        progress: () => undefined,
        freeBytes: () => Promise.resolve(1e15),
      },
    );
    if (!imported.ok) throw new Error(imported.error);
    const fixture: unknown = JSON.parse(
      await readFile(
        join(__dirname, '../../../../packages/schema/src/__fixtures__/pano/stitch.synthetic.json'),
        'utf8',
      ),
    );
    await writeFile(
      join(root, 'panoramas', imported.layerId, 'p01', 'stitch.json'),
      JSON.stringify({ ...(fixture as object), run, layer: imported.layerId, pano: 'p01' }),
    );
    const reread = vi.fn(async (at: string) => ({
      ok: true as const,
      value: await readManifestFile(at),
    }));
    const r = await withPanoStitches(
      root,
      { ok: true, value: imported.manifest },
      () => undefined,
      reread,
    );
    expect(reread).toHaveBeenCalledOnce();
    if (!r.ok) throw new Error(r.error);
    const l = r.value.layers.find((x) => x.id === imported.layerId);
    expect(l?.kind === 'panoramas' && l.items[0]?.stitch).toEqual({ run, status: 'done' });
  });
});

describe('stitchLane: one drone panorama stitch at a time', () => {
  const req = (pano: string, layer = 'l') => ({
    pipeline: 'pano.stitch',
    project: 'D:/p',
    params: { layer, pano, quality: 'standard' },
  });
  const sphere = (pano: string, layer = 'l') => ({ project: 'D:/p', layer, pano });
  const ended = (id: string, status: JobRecord['status']): JobEvent => ({
    type: 'update',
    job: job({ id, status }),
  });

  function lane(refuse: ReadonlySet<string> = new Set()) {
    const started: string[] = [];
    const filed: string[] = [];
    const l = stitchLane({
      start: (r) => {
        const pano = 'params' in r ? String(r.params.pano) : r.resume;
        started.push(pano);
        if (refuse.has(pano)) return Promise.resolve({ ok: false as const, error: 'no tools' });
        return Promise.resolve({
          ok: true as const,
          job: job({ id: `j-${pano}`, status: 'starting' }),
        });
      },
      started: (s, j) => {
        filed.push(`${String(s.pano)}:${j.id}`);
      },
      log: () => undefined,
    });
    return { l, started, filed };
  }

  it('runs three spheres one after the other, in order', async () => {
    const { l, started, filed } = lane();
    expect(await l.start(req('p01'), sphere('p01'))).toMatchObject({
      ok: true,
      job: { id: 'j-p01' },
    });
    expect(await l.start(req('p02'), sphere('p02'))).toEqual({ ok: true, queued: true });
    expect(await l.start(req('p03'), sphere('p03'))).toEqual({ ok: true, queued: true });
    expect(started).toEqual(['p01']);
    // an update of the running job that is not an end, and another job's end: nothing moves
    await l.settled({ type: 'update', job: job({ id: 'j-p01', status: 'running' }) });
    await l.settled(ended('other', 'done'));
    expect(started).toEqual(['p01']);
    await l.settled(ended('j-p01', 'done'));
    expect(started).toEqual(['p01', 'p02']);
    expect(l.running()).toBe('j-p02');
    // a failure moves on to the next
    await l.settled(ended('j-p02', 'failed'));
    expect(started).toEqual(['p01', 'p02', 'p03']);
    await l.settled(ended('j-p03', 'cancelled'));
    expect(l.running()).toBeNull();
    // the waiting ones had their run filed when they started
    expect(filed).toEqual(['p02:j-p02', 'p03:j-p03']);
    // free again: the next start runs at once
    expect(await l.start(req('p04'), sphere('p04'))).toMatchObject({
      ok: true,
      job: { id: 'j-p04' },
    });
  });

  it('goes on past a waiting stitch that cannot start', async () => {
    const { l, started } = lane(new Set(['p02']));
    await l.start(req('p01'), sphere('p01'));
    await l.start(req('p02'), sphere('p02'));
    await l.start(req('p03'), sphere('p03'));
    await l.settled(ended('j-p01', 'failed'));
    expect(started).toEqual(['p01', 'p02', 'p03']);
    expect(l.running()).toBe('j-p03');
  });

  it('cancels a waiting stitch, keeps a sphere asked twice in its place, and drops a layer', async () => {
    const { l, started } = lane();
    await l.start(req('p01'), sphere('p01'));
    await l.start(req('p02'), sphere('p02'));
    await l.start(req('p03'), sphere('p03'));
    await l.start(req('p02'), sphere('p02'));
    await l.start(req('q01', 'other'), sphere('q01', 'other'));
    expect(l.waiting().map((r) => ('params' in r ? r.params.pano : r.resume))).toEqual([
      'p02',
      'p03',
      'q01',
    ]);
    expect(l.waitingLayers('d:\\p')).toEqual(
      process.platform === 'win32' ? ['l', 'l', 'other'] : [],
    );
    // the cancel of one waiting sphere
    expect(l.drop('D:/p', new Set(['l']), 'p02')).toBe(1);
    // a removed layer leaves the line
    expect(l.drop('D:/p', new Set(['other']))).toBe(1);
    await l.settled(ended('j-p01', 'done'));
    expect(started).toEqual(['p01', 'p03']);
  });

  it('names the sphere of a request and of a resume', () => {
    expect(laneSphere(req('p01'), () => undefined)).toEqual(sphere('p01'));
    expect(laneSphere({ resume: 'j1' }, () => job({ project: 'D:/p' }))).toEqual(sphere('p01'));
    expect(laneSphere({ resume: 'j1' }, () => undefined)).toBeNull();
    expect(
      laneSphere({ pipeline: 'walk.process', project: 'D:/p', params: {} }, () => undefined),
    ).toBeNull();
  });

  it('files the run of a waiting sphere when it starts', async () => {
    const scans = panoScanCache();
    const r0 = await scanPanoPaths(root, [await card()], noThumb);
    if ('error' in r0) throw new Error(r0.error);
    scans.put('p', r0.scan, r0.grouping);
    // another stitch runs: this import's sphere waits in line
    const imported = await panoImportAnswer(
      { projectId: 'p', scanId: r0.scan.scanId, keys: ['s1'], layerName: 'S', quality: 'standard' },
      {
        root: () => root,
        scans,
        images: { resizeJpeg: (src, dst) => copyFile(src, dst) },
        jobs: { start: () => Promise.resolve({ ok: true as const, queued: true as const }) },
        packVersion: () => Promise.resolve('0.7.0'),
        progress: () => undefined,
        freeBytes: () => Promise.resolve(1e15),
      },
    );
    if (!imported.ok) throw new Error(imported.error);
    expect(imported.started).toBe(1);
    const itemOf = (m: ProjectManifest) => {
      const l = m.layers.find((x) => x.id === imported.layerId);
      return l?.kind === 'panoramas' ? l.items[0] : undefined;
    };
    expect(itemOf(imported.manifest)?.stitch).toEqual({ status: 'queued' });
    await fileLaneRun(
      { project: root, layer: imported.layerId, pano: 'p01' },
      job({ id: '20261013-101500-pano-stitch-a1b2' }),
    );
    expect(itemOf(await readManifestFile(root))?.stitch).toEqual({
      run: '20261013-101500-pano-stitch-a1b2',
      status: 'queued',
    });
  });
});

describe('relayJobEvent (the stitch queue never stalls)', () => {
  const req = (pano: string) => ({
    pipeline: 'pano.stitch',
    project: 'D:/p',
    params: { layer: 'l', pano },
  });
  function queued() {
    const started: string[] = [];
    const lane = stitchLane({
      start: (r) => {
        const pano = 'params' in r ? String(r.params.pano) : r.resume;
        started.push(pano);
        return Promise.resolve({
          ok: true as const,
          job: job({ id: `j-${pano}`, status: 'starting' }),
        });
      },
    });
    return { lane, started };
  }
  const noFiling = panoStitchFiler({
    update: () => Promise.resolve(),
    readRecord: () => Promise.resolve(null),
  });

  it('starts the next stitch when the window cannot take the event', async () => {
    const { lane, started } = queued();
    await lane.start(req('p01'), { project: 'D:/p', layer: 'l', pano: 'p01' });
    await lane.start(req('p02'), { project: 'D:/p', layer: 'l', pano: 'p02' });
    const logged: string[] = [];
    const journaled: string[] = [];
    const end: JobEvent = {
      type: 'update',
      job: job({ id: 'j-p01', status: 'failed', error: 'x' }),
    };
    await relayJobEvent(end, end, {
      filer: noFiling,
      send: () => {
        throw new Error('Render frame was disposed');
      },
      after: [
        (e) => {
          journaled.push(e.type);
          return Promise.resolve();
        },
      ],
      lane,
      log: (line) => logged.push(line),
    });
    expect(started).toEqual(['p01', 'p02']);
    expect(journaled).toEqual(['update']);
    expect(logged.join(' ')).toMatch(/Render frame was disposed/);
  });

  it('starts the next stitch when validation drops the end of the running one', async () => {
    const { lane, started } = queued();
    await lane.start(req('p01'), { project: 'D:/p', layer: 'l', pano: 'p01' });
    await lane.start(req('p02'), { project: 'D:/p', layer: 'l', pano: 'p02' });
    const send = vi.fn();
    const end: JobEvent = { type: 'update', job: job({ id: 'j-p01', status: 'done' }) };
    await relayJobEvent(end, null, {
      filer: noFiling,
      send,
      after: [],
      lane,
      log: () => undefined,
    });
    expect(send).not.toHaveBeenCalled();
    expect(started).toEqual(['p01', 'p02']);
  });

  it('starts the next stitch when the journal fails', async () => {
    const { lane, started } = queued();
    await lane.start(req('p01'), { project: 'D:/p', layer: 'l', pano: 'p01' });
    await lane.start(req('p02'), { project: 'D:/p', layer: 'l', pano: 'p02' });
    const end: JobEvent = { type: 'update', job: job({ id: 'j-p01', status: 'cancelled' }) };
    await relayJobEvent(end, end, {
      filer: noFiling,
      send: () => undefined,
      after: [() => Promise.reject(new Error('journal'))],
      lane,
      log: () => undefined,
    });
    expect(started).toEqual(['p01', 'p02']);
  });
});

describe('panoThumbs', () => {
  it('asks the async thumbnail maker for a small image and answers a data URL', async () => {
    const create = vi.fn(() =>
      Promise.resolve({ isEmpty: () => false, toJPEG: () => Buffer.from('jpg') }),
    );
    expect(await panoThumbs(create)('D:/card/SYN_0001.JPG')).toBe(
      `data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}`,
    );
    expect(create).toHaveBeenCalledWith('D:/card/SYN_0001.JPG', { width: 160, height: 120 });
  });

  it('answers nothing for an empty image or a failure', async () => {
    const empty = () => Promise.resolve({ isEmpty: () => true, toJPEG: () => Buffer.from('') });
    expect(await panoThumbs(empty)('a.jpg')).toBeUndefined();
    expect(await panoThumbs(() => Promise.reject(new Error('no')))('a.jpg')).toBeUndefined();
  });
});

describe('scan progress throttle', () => {
  it('sends at the end only when the files come fast', async () => {
    const seen: number[] = [];
    const r = await scanPanoPaths(root, [await card()], {
      ...noThumb,
      now: () => 0,
      onProgress: (d) => seen.push(d),
    });
    if ('error' in r) throw new Error(r.error);
    expect(seen).toEqual([18]);
  });

  it('sends at most every 100 ms while files come slowly', async () => {
    const seen: number[] = [];
    let t = 0;
    const r = await scanPanoPaths(root, [await card()], {
      ...noThumb,
      // 60 ms per file: every second file
      now: () => (t += 60) - 60,
      onProgress: (d) => seen.push(d),
    });
    if ('error' in r) throw new Error(r.error);
    expect(seen).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });
});
