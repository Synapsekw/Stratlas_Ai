import { fromWgs84 } from '@aio/geo';
import { parseManifest, type ProjectManifest } from '@aio/schema';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, updateLayers, writeManifestFile } from './create';
import {
  NO_PIPELINE,
  importRawFiles,
  planRawAltitudes,
  type ImportDeps,
  type PipelineJobs,
  type VideoTools,
} from './raw';
import { makeTiff, withExif } from './testing';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-builder-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ORIGIN = (() => {
  const p = fromWgs84([48.1352, 29.0276, 0], 32639);
  return [Math.round(p[0]), Math.round(p[1]), 30] as [number, number, number];
})();

const deps = (over: Partial<ImportDeps> = {}): ImportDeps => ({
  images: { resizeJpeg: (src, dst) => copyFile(src, dst) },
  jobs: NO_PIPELINE,
  utcOffsetMin: 180,
  ...over,
});

async function project(): Promise<string> {
  const r = await createProject(dir, {
    name: 'EBSM flare',
    type: 'inspection',
    epsg: 32639,
    origin: ORIGIN,
    severityTemplate: null,
  });
  return r.root;
}

const readManifest = async (root: string): Promise<ProjectManifest> => {
  const r = parseManifest(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')));
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

/** A tiny but valid GLB (an empty scene). */
function glb(): Uint8Array {
  const json = new TextEncoder().encode('{"asset":{"version":"2.0"},"scenes":[{"nodes":[]}]}  ');
  const out = new Uint8Array(12 + 8 + json.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, json.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  return out;
}

describe('createProject', () => {
  it('creates the package folders, a valid manifest and an empty issue register', async () => {
    const r = await createProject(dir, {
      name: 'EBSM flare',
      type: 'inspection',
      epsg: 32639,
      origin: ORIGIN,
      severityTemplate: null,
    });
    expect(r.root).toBe(join(dir, 'projects', 'ebsm-flare'));
    expect(r.manifest.id).toBe('ebsm-flare');
    expect((await readManifest(r.root)).type).toBe('inspection');
    const issues = JSON.parse(await readFile(join(r.root, 'issues.json'), 'utf8')) as unknown;
    expect(issues).toEqual({ schema: 'aio.issues/1', issues: [] });
    expect(await readdir(r.root)).toEqual(
      expect.arrayContaining(['models', 'photos', 'video', 'flights']),
    );
  });

  it('never overwrites an existing project folder', async () => {
    const req = {
      name: 'Same',
      type: 'fusion' as const,
      epsg: 32639,
      origin: ORIGIN,
      severityTemplate: null,
    };
    const a = await createProject(dir, req);
    const b = await createProject(dir, req);
    expect(a.manifest.id).toBe('same');
    expect(b.manifest.id).toBe('same-2');
  });
});

describe('importRawFiles', () => {
  it('imports GPS photos with poses, a GLB and captures, and backs up the manifest', async () => {
    const root = await project();
    const a = join(dir, 'DSC00001.JPG');
    const b = join(dir, 'DJI_0461.JPG');
    await writeFile(
      a,
      withExif({
        make: 'SONY',
        dateTimeOriginal: '2019:01:24 11:45:58',
        focal35: 200,
        width: 7952,
        height: 5304,
        lat: 29.0276,
        lon: 48.1352,
        alt: 140,
      }),
    );
    await writeFile(
      b,
      withExif({
        make: 'Hasselblad',
        dateTimeOriginal: '2019:01:25 09:00:00',
        focal35: 24,
        width: 4000,
        height: 3000,
        lat: 29.0277,
        lon: 48.1353,
        alt: 90,
        dji: {
          GimbalYawDegree: '+10',
          GimbalPitchDegree: '-40',
          GimbalRollDegree: '0',
          AbsoluteAltitude: '+90.5',
        },
      }),
    );
    await writeFile(join(dir, 'flare.glb'), glb());
    const progress: number[] = [];
    const r = await importRawFiles(
      root,
      [a, b, join(dir, 'flare.glb')],
      deps({ onProgress: (d) => progress.push(d) }),
    );
    expect(r.items.map((i) => [i.kind, i.status])).toEqual([
      ['photo', 'imported'],
      ['photo', 'imported'],
      ['mesh', 'imported'],
    ]);
    expect(progress.at(-1)).toBe(3);
    const m = await readManifest(root);
    const photos = m.layers.find((l) => l.kind === 'photos');
    expect(photos?.kind === 'photos' && photos.items.map((p) => p.id)).toEqual([
      'dsc00001',
      'dji-0461',
    ]);
    if (photos?.kind !== 'photos') throw new Error('no photos layer');
    expect(photos.items[0]?.pos?.[1]).toBeCloseTo(110, 3);
    expect(photos.items[0]?.q).toBeUndefined();
    expect(photos.items[1]?.q).toBeDefined();
    expect(photos.items[1]?.takenAt).toBe('2019-01-25T09:00:00+03:00');
    expect(m.captures.map((c) => c.date)).toEqual(['2019-01-24', '2019-01-25']);
    expect(m.layers.find((l) => l.kind === 'mesh')).toMatchObject({
      id: 'mesh-flare',
      src: { path: 'models/flare.glb' },
    });
    expect(await readdir(join(root, 'photos', 'thumbs'))).toEqual(['dji-0461.jpg', 'dsc00001.jpg']);
    expect(r.backup).toMatch(/manifest\.json\.bak$/);
  });

  it('imports the same photo twice as two items, never clobbering the first', async () => {
    const root = await project();
    const a = join(dir, 'p.jpg');
    await writeFile(a, withExif({ lat: 29.0276, lon: 48.1352 }));
    await importRawFiles(root, [a], deps());
    await importRawFiles(root, [a], deps());
    const m = await readManifest(root);
    const photos = m.layers.find((l) => l.kind === 'photos');
    expect(photos?.kind === 'photos' && photos.items.map((p) => p.id)).toEqual(['p', 'p-2']);
  });

  it('hands point clouds and large rasters to the pipeline pack, or says it is missing', async () => {
    const root = await project();
    const las = join(dir, 'site.laz');
    await writeFile(las, new Uint8Array([1, 2, 3]));
    const none = await importRawFiles(root, [las], deps());
    expect(none.items[0]).toMatchObject({ kind: 'pointcloud', status: 'needs-pipeline' });
    expect(none.items[0]?.message).toMatch(/pipeline pack/i);

    const started: unknown[] = [];
    const jobs: PipelineJobs = {
      available: () => Promise.resolve(true),
      start: (method, params) => {
        started.push({ method, params });
        return Promise.resolve({ jobId: 'job-1' });
      },
    };
    const queued = await importRawFiles(root, [las], deps({ jobs }));
    expect(queued.items[0]).toMatchObject({ status: 'queued', jobId: 'job-1' });
    expect(started[0]).toMatchObject({
      method: 'pointcloud.toCopc',
      params: { src: las, epsg: 32639 },
    });
  });

  it('imports a small GeoTIFF ortho as a placed image raster', async () => {
    const root = await project();
    const tif = join(dir, 'ortho.tif');
    const values = Array.from({ length: 4 * 2 * 3 }, (_, i) => (i * 40) % 256);
    await writeFile(
      tif,
      makeTiff(
        {
          width: 4,
          height: 2,
          samples: 3,
          bits: 8,
          values,
          epsg: 32639,
          pixelScale: [0.5, 0.5],
          tiepoint: [ORIGIN[0] - 1, ORIGIN[1] + 1],
          compression: 8,
        },
        (x) => new Uint8Array(deflateSync(x)),
      ),
    );
    const r = await importRawFiles(root, [tif], deps());
    expect(r.items[0]).toMatchObject({ kind: 'raster', status: 'imported' });
    const m = await readManifest(root);
    const layer = m.layers.find((l) => l.kind === 'raster');
    expect(layer).toMatchObject({
      role: 'ortho',
      format: 'image',
      src: { path: 'rasters/ortho.png' },
      corners: { tl: [-1, 0, -1], tr: [1, 0, -1], bl: [-1, 0, 0] },
    });
  });

  it('imports a video with its SRT as a clip, a flight file and the timing check', async () => {
    const root = await project();
    await writeFile(join(dir, 'DJI_0498.MP4'), new Uint8Array(16));
    await writeFile(join(dir, 'DJI_0498.SRT'), 'srt text');
    const seen: unknown[] = [];
    const video: VideoTools = {
      probe: () =>
        Promise.resolve({
          width: 3840,
          height: 2160,
          codec: 'avc1',
          durationMs: 9009,
          frameTimesMs: [0, 33.4],
        }),
      flightFromSrt: (srt, o) => {
        seen.push({ srt, aspect: o.aspect, utc: o.utcOffsetMin });
        return {
          doc: {
            startUtcMs: Date.UTC(2023, 11, 25, 8, 35, 42, 772),
            lens: { model: 'pinhole', hfovDeg: 71.59, aspect: 1.7778 },
            samples: [{ t: 0, pos: [0, 100, 0], q: [0, 0, 0, 1] }],
            heights: { source: 'relative', absOffsetM: 0, takeoffH: o.heights.takeoffH },
          },
          warnings: ['No gimbal angles.'],
          timing: { withinOneFrame: true, maxErrorMs: 1.3, frameMs: 33.4 },
          orientation: 'estimated',
          heightSource: 'relative',
        };
      },
      srtAltitudes: () => ({ readings: [] }),
    };
    // only the MP4 is given: the SRT next to it is found on disk
    const r = await importRawFiles(root, [join(dir, 'DJI_0498.MP4')], deps({ video }));
    expect(r.items[0]).toMatchObject({
      kind: 'video',
      status: 'imported',
      layerId: 'clip-dji-0498',
    });
    expect(r.items[0]?.message).toMatch(/within 1\.3 ms.*No gimbal/);
    expect(seen).toEqual([{ srt: 'srt text', aspect: 3840 / 2160, utc: 180 }]);
    const m = await readManifest(root);
    expect(m.layers.find((l) => l.kind === 'video')).toMatchObject({
      src: { path: 'video/dji-0498.mp4' },
      flight: {
        src: { path: 'flights/dji-0498.json' },
        startUtcMs: Date.UTC(2023, 11, 25, 8, 35, 42, 772),
      },
      offsetMs: 0,
      name: 'DJI_0498 · 11:35',
    });
    const flight = JSON.parse(await readFile(join(root, 'flights', 'dji-0498.json'), 'utf8')) as {
      schema: string;
    };
    expect(flight.schema).toBe('aio.flight/1');
    expect(m.captures.map((c) => c.date)).toContain('2023-12-25');
  });

  const djiVideo = (codec: string): VideoTools => ({
    probe: () =>
      Promise.resolve({ width: 5120, height: 2700, codec, durationMs: 4000, frameTimesMs: [0] }),
    flightFromSrt: () => ({
      doc: {
        startUtcMs: Date.UTC(2023, 1, 21, 13, 22, 38),
        lens: { model: 'pinhole', hfovDeg: 72.2, aspect: 1.8963 },
        samples: [{ t: 0, pos: [0, 100, 0], q: [0, 0, 0, 1] }],
        heights: { source: 'relative', absOffsetM: 0, takeoffH: 30 },
      },
      warnings: [],
      timing: { withinOneFrame: true, maxErrorMs: 1, frameMs: 20 },
      orientation: 'gimbal',
      heightSource: 'relative',
    }),
    srtAltitudes: () => ({ readings: [] }),
  });

  it('writes a review proxy instead of copying the original when a proxy step is given', async () => {
    const root = await project();
    await writeFile(join(dir, 'DJI_0658.MOV'), new Uint8Array(16));
    await writeFile(join(dir, 'DJI_0658.SRT'), 'srt');
    const calls: string[][] = [];
    const posters: string[] = [];
    const r = await importRawFiles(
      root,
      [join(dir, 'DJI_0658.MOV'), join(dir, 'DJI_0658.SRT')],
      deps({
        video: djiVideo('apch'),
        proxy: async (src, out) => {
          calls.push([src, out]);
          await writeFile(out, 'proxy');
        },
        poster: async (video, _at, out) => {
          posters.push(video);
          await writeFile(out, 'jpg');
        },
      }),
    );
    expect(r.items[0]).toMatchObject({ kind: 'video', status: 'imported' });
    expect(r.items[0]?.message).toMatch(/1920 px/);
    expect(calls).toEqual([[join(dir, 'DJI_0658.MOV'), join(root, 'video', 'dji-0658.mp4')]]);
    expect(posters).toEqual([join(root, 'video', 'dji-0658.mp4')]);
    expect(await readdir(join(root, 'video'))).toEqual(['dji-0658.mp4']);
    const m = await readManifest(root);
    expect(m.layers.find((l) => l.kind === 'video')).toMatchObject({
      src: { path: 'video/dji-0658.mp4' },
      poster: { path: 'posters/dji-0658.jpg' },
    });
  });

  it('copies a playable original when the proxy fails, and fails an unplayable one', async () => {
    const root = await project();
    for (const n of ['A.MP4', 'A.SRT', 'B.MOV', 'B.SRT'])
      await writeFile(join(dir, n), new Uint8Array(4));
    const failing = () => Promise.reject(new Error('ffmpeg missing'));
    const a = await importRawFiles(
      root,
      [join(dir, 'A.MP4')],
      deps({ video: djiVideo('hvc1'), proxy: failing }),
    );
    expect(a.items[0]).toMatchObject({ status: 'imported' });
    expect(a.items[0]?.message).toMatch(/ffmpeg missing.*original was copied/);
    expect(await readdir(join(root, 'video'))).toEqual(['a.mp4']);
    const b = await importRawFiles(
      root,
      [join(dir, 'B.MOV')],
      deps({ video: djiVideo('apch'), proxy: failing }),
    );
    expect(b.items[0]).toMatchObject({ status: 'error' });
  });

  it('skips a video without SRT telemetry and an unknown file, and reports both', async () => {
    const root = await project();
    await writeFile(join(dir, 'clip.mp4'), new Uint8Array(16));
    await writeFile(join(dir, 'notes.docx'), new Uint8Array(4));
    const r = await importRawFiles(root, [join(dir, 'clip.mp4'), join(dir, 'notes.docx')], deps());
    expect(r.items.map((i) => [i.kind, i.status])).toEqual([
      ['video', 'skipped'],
      ['unknown', 'skipped'],
    ]);
    expect(r.items[0]?.message).toMatch(/SRT/);
  });
});

describe('camera heights of a raw import (data-conventions 3a)', () => {
  // a DJI photo 113.7 m above its take-off point; the aircraft logs absolute = relative + 41.9
  const djiPhoto = (rel: string | null, abs: string | null) =>
    withExif({
      make: 'DJI',
      lat: 29.0276,
      lon: 48.1352,
      ...(abs ? { alt: Number(abs) } : {}),
      dji: {
        GimbalYawDegree: '+10',
        GimbalPitchDegree: '-40',
        GimbalRollDegree: '0',
        ...(abs ? { AbsoluteAltitude: abs } : {}),
        ...(rel ? { RelativeAltitude: rel } : {}),
      },
    });
  const photoY = async (root: string) => {
    const m = await readManifest(root);
    const l = m.layers.find((x) => x.kind === 'photos');
    return l?.kind === 'photos' ? l.items.map((p) => p.pos?.[1]) : [];
  };

  it('relative altitude plus the confirmed take-off height when the project has no datum', async () => {
    const root = await project();
    const f = join(dir, 'DJI_0001.JPG');
    await writeFile(f, djiPhoto('+113.70', '+155.60'));
    const r = await importRawFiles(
      root,
      [f],
      deps({ altitude: { source: 'auto', takeoffH: 41.5, takeoffFrom: 'terrain' } }),
    );
    expect(r.items[0]?.heightSource).toBe('relative');
    expect(r.heights).toEqual({ source: 'relative', offsetM: 41.5, from: 'terrain' });
    // H = 41.5 + 113.7, origin H 30
    expect((await photoY(root))[0]).toBeCloseTo(125.2, 6);
  });

  it('takes the origin height as take-off height when nothing is confirmed, and says so', async () => {
    const root = await project();
    const f = join(dir, 'DJI_0001.JPG');
    await writeFile(f, djiPhoto('+113.70', '+155.60'));
    const r = await importRawFiles(root, [f], deps());
    expect(r.heights).toEqual({ source: 'relative', offsetM: 30, from: 'origin' });
    expect((await photoY(root))[0]).toBeCloseTo(113.7, 6);
  });

  it('absolute altitude plus the project datum when the project defines one', async () => {
    const root = await project();
    const m = await readManifest(root);
    await writeManifestFile(root, {
      ...m,
      verticalDatum: { absAltOffsetM: 100, note: 'Plant EL = absolute + 100' },
    });
    const f = join(dir, 'DJI_0001.JPG');
    await writeFile(f, djiPhoto('+113.70', '+155.60'));
    const r = await importRawFiles(root, [f], deps());
    expect(r.items[0]?.heightSource).toBe('absolute');
    expect(r.heights).toEqual({
      source: 'absolute',
      offsetM: 100,
      from: 'datum',
      note: 'Plant EL = absolute + 100',
    });
    // H = 155.6 + 100, origin H 30
    expect((await photoY(root))[0]).toBeCloseTo(225.6, 6);
  });

  it('saves an offset picked at import as the project datum', async () => {
    const root = await project();
    const f = join(dir, 'DJI_0001.JPG');
    await writeFile(f, djiPhoto('+113.70', '+155.60'));
    const r = await importRawFiles(
      root,
      [f],
      deps({ altitude: { source: 'absolute', absAltOffsetM: -18.5 } }),
    );
    expect(r.heights).toMatchObject({ source: 'absolute', offsetM: -18.5, from: 'datum' });
    expect((await readManifest(root)).verticalDatum?.absAltOffsetM).toBe(-18.5);
    expect((await photoY(root))[0]).toBeCloseTo(155.6 - 18.5 - 30, 6);
  });

  it('falls back per file and reports absolute altitude without a datum as uncorrected', async () => {
    const root = await project();
    const abs = join(dir, 'ABS.JPG');
    const none = join(dir, 'NONE.JPG');
    await writeFile(abs, djiPhoto(null, '+155.60'));
    await writeFile(none, djiPhoto(null, null));
    const r = await importRawFiles(root, [abs], deps());
    expect(r.items[0]?.heightSource).toBe('absolute');
    expect(r.items[0]?.message).toMatch(/no datum correction/);
    expect(r.heights).toEqual({ source: 'absolute', offsetM: 0, from: 'uncorrected' });
    const n = await importRawFiles(root, [none], deps());
    expect(n.items[0]?.heightSource).toBe('none');
    expect(n.items[0]?.message).toMatch(/No altitude logged/);
    expect(await photoY(root)).toEqual([125.6, 0]);
  });

  it('plans the rule from what the files carry, with the take-off point', async () => {
    const root = await project();
    const a = join(dir, 'DJI_0001.JPG');
    const b = join(dir, 'DJI_0002.JPG');
    await writeFile(a, djiPhoto('+113.70', '+155.60'));
    await writeFile(b, djiPhoto('+2.00', '+43.90'));
    await writeFile(join(dir, 'DJI_0498.MP4'), new Uint8Array(16));
    await writeFile(join(dir, 'DJI_0498.SRT'), 'srt');
    const video: VideoTools = {
      probe: () => Promise.reject(new Error('unused')),
      flightFromSrt: () => {
        throw new Error('unused');
      },
      srtAltitudes: () => ({
        readings: [{ lat: 29.0277, lon: 48.1352, abs: 60, rel: 18 }],
      }),
    };
    const plan = await planRawAltitudes(root, [a, b, join(dir, 'DJI_0498.MP4')], { video });
    expect(plan).toMatchObject({
      files: 3,
      absolute: 3,
      relative: 3,
      datum: null,
      recommended: 'relative',
      takeoffAbsAlt: 41.9,
    });
    // the lowest logged position (photo b, 2 m above take-off) at the origin
    expect(plan.takeoff?.relAltM).toBe(2);
    expect(Math.abs(plan.takeoff?.x ?? 99)).toBeLessThan(1);
    const m = await readManifest(root);
    await writeManifestFile(root, { ...m, verticalDatum: { absAltOffsetM: 100 } });
    const withDatum = await planRawAltitudes(root, [a], { video });
    expect(withDatum.recommended).toBe('absolute');
  });
});

describe('updateLayers', () => {
  it('saves a mesh transform after a backup and refuses a lens on a mesh', async () => {
    const root = await project();
    await writeFile(join(dir, 'm.glb'), glb());
    await importRawFiles(root, [join(dir, 'm.glb')], deps());
    const t = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, 6, 7, 1];
    const r = await updateLayers(root, ['mesh-m'], { transform: t });
    expect(r.manifest.layers.find((l) => l.id === 'mesh-m')).toMatchObject({ transform: t });
    expect(r.backup).toMatch(/manifest\.json\.bak$/);
    await expect(
      updateLayers(root, ['mesh-m'], { lens: { model: 'pinhole', hfovDeg: 70, aspect: 1.5 } }),
    ).rejects.toThrow(/video/);
    await expect(updateLayers(root, ['nope'], { transform: t })).rejects.toThrow(/nope/);
  });
});
