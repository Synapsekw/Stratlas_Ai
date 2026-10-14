import { fromWgs84 } from '@aio/geo';
import { parseManifest, type ProjectManifest } from '@aio/schema';
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProject,
  ensureCapture,
  updateCapture,
  updateLayers,
  writeManifestFile,
} from './create';
import {
  NO_PIPELINE,
  importDay,
  importRawFiles,
  isImportableExtension,
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

describe('writeManifestFile (M10 G0)', () => {
  it('keeps a layer of a kind from a newer Stratlas when this build saves the project', async () => {
    const root = await project();
    const file = join(root, 'manifest.json');
    const newer = { kind: 'gaussian-splat', id: 'splat-1', name: 'Splat', later: { x: [1, 'ü'] } };
    const raw = JSON.parse(await readFile(file, 'utf8')) as { layers: unknown[] };
    await writeFile(file, JSON.stringify({ ...raw, layers: [...raw.layers, newer] }));

    const m = await readManifest(root);
    expect(m.layers.map((l) => l.id)).not.toContain('splat-1');
    await writeManifestFile(root, { ...m, name: 'Renamed here' });

    const saved = JSON.parse(await readFile(file, 'utf8')) as { name: string; layers: unknown[] };
    expect(saved.name).toBe('Renamed here');
    expect(saved.layers.at(-1)).toEqual(newer);
    expect(JSON.parse(await readFile(`${file}.bak`, 'utf8'))).toMatchObject({ name: 'EBSM flare' });
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
        dateTimeOriginal: '2019:01:24 09:00:00',
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
    expect(photos.items[1]?.takenAt).toBe('2019-01-24T09:00:00+03:00');
    expect(m.captures.map((c) => c.date)).toEqual(['2019-01-24']);
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
    const photos = m.layers.flatMap((l) => (l.kind === 'photos' ? l.items.map((p) => p.id) : []));
    expect(photos).toEqual(['p', 'p-2']);
  });

  it('hands a point cloud to the pipeline pack, or says it is missing', async () => {
    const root = await project();
    const las = join(dir, 'site.laz');
    await writeFile(las, new Uint8Array([1, 2, 3]));
    const none = await importRawFiles(root, [las], deps());
    expect(none.items[0]).toMatchObject({ kind: 'pointcloud', status: 'needs-pipeline' });
    expect(none.items[0]?.message).toMatch(/processing tools/i);
    expect(none.items[0]?.message).toContain('Settings, Processing tools');
    expect(none.items[0]?.message).not.toMatch(/pipeline pack/i);

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

  it('hands a DXF plan to drawing.import and refuses a DWG with what to do', async () => {
    const root = await project();
    const dxf = join(dir, 'plot.dxf');
    const dwg = join(dir, 'plot.dwg');
    await writeFile(dxf, '0\nEOF\n');
    await writeFile(dwg, new Uint8Array([1, 2, 3]));
    const started: { method: string; params: Record<string, unknown> }[] = [];
    const jobs: PipelineJobs = {
      available: () => Promise.resolve(true),
      start: (method, params) => {
        started.push({ method, params });
        return Promise.resolve({ jobId: 'job-d' });
      },
    };
    const r = await importRawFiles(root, [dxf, dwg], deps({ jobs }));
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ kind: 'drawing', status: 'queued', jobId: 'job-d' });
    expect(r.items[1]).toMatchObject({ kind: 'drawing', status: 'skipped' });
    expect(r.items[1]?.message).toMatch(/DXF/);
    expect(started).toEqual([expect.objectContaining({ method: 'drawing.import' })]);
    expect(started[0]?.params.src).toBe(dxf);
  });

  it('hands a LandXML or 12da design to design.import and leaves other XML alone', async () => {
    const root = await project();
    const xml = join(dir, 'pad.xml');
    const twelve = join(dir, 'pad.12da');
    const other = join(dir, 'notes.xml');
    await writeFile(xml, '<?xml version="1.0"?>\n<LandXML version="1.2"></LandXML>\n');
    await writeFile(twelve, 'model "design"\n');
    await writeFile(other, '<?xml version="1.0"?>\n<notes/>\n');
    const started: { method: string; params: Record<string, unknown> }[] = [];
    const jobs: PipelineJobs = {
      available: () => Promise.resolve(true),
      start: (method, params) => {
        started.push({ method, params });
        return Promise.resolve({ jobId: `job-${String(started.length)}` });
      },
    };
    const r = await importRawFiles(root, [xml, twelve, other], deps({ jobs }));
    expect(r.items.map((i) => [i.kind, i.status])).toEqual([
      ['design', 'queued'],
      ['design', 'queued'],
      ['unknown', 'skipped'],
    ]);
    expect(started.map((s) => [s.method, s.params.src])).toEqual([
      ['design.import', xml],
      ['design.import', twelve],
    ]);
  });

  it('hands an OPF project to opf.import', async () => {
    const root = await project();
    const opf = join(dir, 'project.opf');
    await writeFile(opf, '{"format":"application/opf-project+json","version":"1.0","items":[]}');
    const started: { method: string; params: Record<string, unknown> }[] = [];
    const jobs: PipelineJobs = {
      available: () => Promise.resolve(true),
      start: (method, params) => {
        started.push({ method, params });
        return Promise.resolve({ jobId: 'job-o' });
      },
    };
    const r = await importRawFiles(root, [opf], deps({ jobs }));
    expect(r.items).toEqual([
      expect.objectContaining({
        file: 'project.opf',
        kind: 'opf',
        status: 'queued',
        jobId: 'job-o',
      }),
    ]);
    expect(started).toEqual([expect.objectContaining({ method: 'opf.import' })]);
    expect(started[0]?.params.src).toBe(opf);
    // without the pack: what to do, kind still opf
    const none = await importRawFiles(root, [opf], deps());
    expect(none.items[0]).toMatchObject({ kind: 'opf', status: 'needs-pipeline' });
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

  describe('a GeoTIFF over the size limits', () => {
    const TOO_LARGE =
      'This GeoTIFF is too large to import yet (over 300 MB, over 12,000 x 12,000 pixels, or a BigTIFF). Reduce or split it in other software, then import the parts.';

    /** A valid 4 x 2 ortho (classic TIFF, Deflate). */
    const smallTiff = () =>
      makeTiff(
        {
          width: 4,
          height: 2,
          samples: 3,
          bits: 8,
          values: Array.from({ length: 4 * 2 * 3 }, (_, i) => (i * 40) % 256),
          epsg: 32639,
          pixelScale: [0.5, 0.5],
          tiepoint: [ORIGIN[0] - 1, ORIGIN[1] + 1],
          compression: 8,
        },
        (x) => new Uint8Array(deflateSync(x)),
      );

    /** The same file with the image size in its first IFD changed to `w` x `h` (header only). */
    function declareSize(b: Uint8Array, w: number, h: number): Uint8Array {
      const out = b.slice();
      const v = new DataView(out.buffer);
      const at = v.getUint32(4, true);
      for (let i = 0; i < v.getUint16(at, true); i++) {
        const e = at + 2 + i * 12;
        const tag = v.getUint16(e, true);
        if (tag !== 256 && tag !== 257) continue;
        const value = tag === 256 ? w : h;
        if (v.getUint16(e + 2, true) === 3) v.setUint16(e + 8, value, true);
        else v.setUint32(e + 8, value, true);
      }
      return out;
    }

    /** A job runner that records every start. */
    function recorder() {
      const started: string[] = [];
      const jobs: PipelineJobs = {
        available: () => Promise.resolve(true),
        start: (method) => {
          started.push(method);
          return Promise.resolve({ jobId: 'job-r' });
        },
      };
      return { started, jobs };
    }

    async function expectRefused(file: string) {
      const root = await project();
      const { started, jobs } = recorder();
      const r = await importRawFiles(root, [file], deps({ jobs }));
      expect(r.items).toEqual([
        { file: 'big.tif', kind: 'raster', status: 'error', message: TOO_LARGE },
      ]);
      expect(started).toEqual([]);
      expect((await readManifest(root)).layers.filter((l) => l.kind === 'raster')).toEqual([]);
      expect(await readdir(join(root, 'rasters'))).toEqual([]);
    }

    it('refuses a file over the byte limit, with no job and no layer', async () => {
      const tif = join(dir, 'big.tif');
      await writeFile(tif, smallTiff());
      const fh = await open(tif, 'r+');
      await fh.truncate(300 * 1024 * 1024 + 1);
      await fh.close();
      await expectRefused(tif);
    });

    it('refuses a file over the pixel limit, with no job and no layer', async () => {
      const tif = join(dir, 'big.tif');
      await writeFile(tif, declareSize(smallTiff(), 12_001, 12_000));
      await expectRefused(tif);
    });

    it('refuses a BigTIFF, with no job and no layer', async () => {
      const tif = join(dir, 'big.tif');
      const b = new Uint8Array(64);
      new DataView(b.buffer).setUint16(0, 0x4949);
      new DataView(b.buffer).setUint16(2, 43, true);
      await writeFile(tif, b);
      await expectRefused(tif);
    });

    it('says the same when the processing tools are not installed', async () => {
      const root = await project();
      const tif = join(dir, 'big.tif');
      await writeFile(tif, declareSize(smallTiff(), 13_000, 13_000));
      const r = await importRawFiles(root, [tif], deps());
      expect(r.items[0]).toMatchObject({ status: 'error', message: TOO_LARGE });
    });

    it('still imports a small file as a layer, with no job', async () => {
      const root = await project();
      const tif = join(dir, 'ok.tif');
      await writeFile(tif, smallTiff());
      const { started, jobs } = recorder();
      const r = await importRawFiles(root, [tif], deps({ jobs }));
      expect(r.items[0]).toMatchObject({ kind: 'raster', status: 'imported' });
      expect(started).toEqual([]);
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
    // every import files its photos in a layer of its own
    return m.layers.flatMap((l) => (l.kind === 'photos' ? l.items.map((p) => p.pos?.[1]) : []));
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

  it('clears the positions of a photos layer and refuses it on other layers', async () => {
    const root = await project();
    const a = join(dir, 'DSC00001.JPG');
    await writeFile(
      a,
      withExif({ make: 'SONY', focal35: 35, width: 64, height: 48, lat: 29.0276, lon: 48.1352 }),
    );
    await writeFile(join(dir, 'm.glb'), glb());
    await importRawFiles(root, [a, join(dir, 'm.glb')], deps());
    const before = (await readManifest(root)).layers.find((l) => l.kind === 'photos');
    expect(before?.kind === 'photos' && before.items.every((p) => p.pos)).toBe(true);
    const id = before?.id ?? '';
    const r = await updateLayers(root, [id], { photoPositions: 'clear' });
    const l = r.manifest.layers.find((x) => x.id === id);
    expect(l?.kind === 'photos' && l.items.length > 0 && l.items.every((p) => !p.pos && !p.q)).toBe(
      true,
    );
    expect(r.backup).toMatch(/manifest\.json\.bak$/);
    await expect(updateLayers(root, ['mesh-m'], { photoPositions: 'clear' })).rejects.toThrow(
      /not photos/,
    );
  });

  it('saves and clears a video orientation bias without touching the other fields', async () => {
    const root = await project();
    const m = await readManifest(root);
    const clip = {
      kind: 'video' as const,
      id: 'clip-a',
      name: 'Clip A',
      visible: true,
      src: { path: 'video/a.mp4' },
      flight: { src: { path: 'flights/a.json' }, startUtcMs: 1676974958000 },
      lens: { model: 'pinhole' as const, hfovDeg: 72.2, aspect: 1.8972 },
      offsetMs: 144000,
    };
    await writeManifestFile(root, { ...m, layers: [...m.layers, clip] });
    const r = await updateLayers(root, ['clip-a'], {
      orientation: { yawDeg: 0.41234, pitchDeg: -7.98765, rollDeg: 0.2 },
    });
    expect(r.manifest.layers.find((l) => l.id === 'clip-a')).toMatchObject({
      offsetMs: 144000,
      lens: clip.lens,
      orientation: { yawDeg: 0.412, pitchDeg: -7.988, rollDeg: 0.2 },
    });
    const moved = await updateLayers(root, ['clip-a'], { positionOffsetM: [1.23456, 40, -2] });
    expect(moved.manifest.layers.find((l) => l.id === 'clip-a')).toMatchObject({
      positionOffsetM: [1.235, 40, -2],
      orientation: { pitchDeg: -7.988 },
    });
    const cleared = await updateLayers(root, ['clip-a'], {
      orientation: null,
      positionOffsetM: null,
    });
    const after = cleared.manifest.layers.find((l) => l.id === 'clip-a');
    expect(after && 'orientation' in after).toBe(false);
    expect(after && 'positionOffsetM' in after).toBe(false);
    expect((await readManifest(root)).layers.find((l) => l.id === 'clip-a')).toMatchObject({
      offsetMs: 144000,
    });
  });

  it('sets and clears the capture of any layer, and refuses an unknown capture', async () => {
    const root = await project();
    await writeFile(join(dir, 'm.glb'), glb());
    await importRawFiles(root, [join(dir, 'm.glb')], deps());
    const m = await readManifest(root);
    await writeManifestFile(root, {
      ...m,
      captures: [{ id: 'c1', label: 'First survey', date: '2026-01-10' }],
    });
    const set = await updateLayers(root, ['mesh-m'], { capture: 'c1' });
    expect(set.manifest.layers.find((l) => l.id === 'mesh-m')).toMatchObject({ capture: 'c1' });
    await expect(updateLayers(root, ['mesh-m'], { capture: 'c9' })).rejects.toThrow(/c9/);
    const cleared = await updateLayers(root, ['mesh-m'], { capture: null });
    const after = cleared.manifest.layers.find((l) => l.id === 'mesh-m');
    expect(after && 'capture' in after).toBe(false);
  });

  it('sets and clears the placement of a walk, and refuses it on another kind', async () => {
    const root = await project();
    await writeFile(join(dir, 'm.glb'), glb());
    await importRawFiles(root, [join(dir, 'm.glb')], deps());
    const m = await readManifest(root);
    await writeManifestFile(root, {
      ...m,
      layers: [
        ...m.layers,
        {
          kind: 'walk',
          id: 'walk-a',
          name: 'A',
          visible: true,
          record: { path: 'walks/a/walk.json' },
          src: { path: 'walks/a/playback.mp4' },
          durationS: 12,
        },
      ],
    });
    const place = {
      pins: [{ t: 1, surface: '@model', at: [0, 0] as [number, number] }],
      yawOffsetDeg: 5,
      quality: 'unplaced' as const,
    };
    const set = await updateLayers(root, ['walk-a'], { walk: place });
    expect(set.manifest.layers.find((l) => l.id === 'walk-a')).toMatchObject({
      place: { ...place, heightM: 1.7 },
    });
    await expect(updateLayers(root, ['mesh-m'], { walk: place })).rejects.toThrow(/360 walk/);
    const cleared = await updateLayers(root, ['walk-a'], { walk: null });
    const after = cleared.manifest.layers.find((l) => l.id === 'walk-a');
    expect(after && 'place' in after).toBe(false);
  });
});

describe('updateCapture', () => {
  const dated = async () => {
    const root = await project();
    await writeFile(join(dir, 'm.glb'), glb());
    await importRawFiles(root, [join(dir, 'm.glb')], deps());
    const m = await readManifest(root);
    await writeManifestFile(root, {
      ...m,
      captures: [
        { id: 'c1', label: 'First survey', date: '2026-01-10' },
        { id: 'c2', label: 'Second survey', date: '2026-02-10' },
      ],
    });
    return root;
  };

  it('renames a survey date and leaves its date, the other dates and the layers alone', async () => {
    const root = await dated();
    const before = await readManifest(root);
    const r = await updateCapture(root, 'c1', { label: '  Baseline  ' });
    expect(r.backup).toMatch(/manifest\.json\.bak$/);
    expect(r.manifest.captures).toEqual([
      { id: 'c1', label: 'Baseline', date: '2026-01-10' },
      { id: 'c2', label: 'Second survey', date: '2026-02-10' },
    ]);
    expect(r.manifest.layers).toEqual(before.layers);
    expect((await readManifest(root)).captures[0]?.label).toBe('Baseline');
  });

  it('sets the colour and icon of a date and puts them back to automatic', async () => {
    const root = await dated();
    const set = await updateCapture(root, 'c2', { colour: 5, icon: 'flag' });
    expect(set.manifest.captures[1]).toEqual({
      id: 'c2',
      label: 'Second survey',
      date: '2026-02-10',
      colour: 5,
      icon: 'flag',
    });
    const reset = await updateCapture(root, 'c2', { colour: null, icon: null });
    expect(reset.manifest.captures[1]).toEqual({
      id: 'c2',
      label: 'Second survey',
      date: '2026-02-10',
    });
    expect((await readManifest(root)).captures[1]).toEqual(reset.manifest.captures[1]);
  });

  it('refuses a date the project does not have', async () => {
    const root = await dated();
    await expect(updateCapture(root, 'c9', { label: 'Nope' })).rejects.toThrow(/c9/);
  });
});

describe('ensureCapture', () => {
  const dated = async () => {
    const root = await project();
    const m = await readManifest(root);
    await writeManifestFile(root, {
      ...m,
      captures: [
        { id: 'c1', label: 'First survey', date: '2026-01-10' },
        { id: 'c2', label: 'Second survey', date: '2026-03-10' },
      ],
    });
    return root;
  };

  it('adds a survey date for a new day, in date order, named Survey', async () => {
    const root = await dated();
    const r = await ensureCapture(root, '2026-02-10');
    expect(r.created).toBe(true);
    expect(r.captureId).toBe('capture-2026-02-10');
    expect(r.manifest.captures.map((c) => c.date)).toEqual([
      '2026-01-10',
      '2026-02-10',
      '2026-03-10',
    ]);
    expect(r.manifest.captures[1]).toEqual({
      id: 'capture-2026-02-10',
      label: 'Survey',
      date: '2026-02-10',
    });
    expect((await readManifest(root)).captures).toEqual(r.manifest.captures);
  });

  it('finds the date that is already there and writes nothing', async () => {
    const root = await dated();
    const before = await readFile(join(root, 'manifest.json'), 'utf8');
    const r = await ensureCapture(root, '2026-03-10');
    expect(r).toMatchObject({ captureId: 'c2', created: false });
    expect(await readFile(join(root, 'manifest.json'), 'utf8')).toBe(before);
  });

  it('asked twice for the same new day, makes one date', async () => {
    const root = await dated();
    const a = await ensureCapture(root, '2026-05-01');
    const b = await ensureCapture(root, '2026-05-01');
    expect(b).toMatchObject({ captureId: a.captureId, created: false });
    expect(b.manifest.captures.filter((c) => c.date === '2026-05-01')).toHaveLength(1);
  });

  it('refuses a day that is not a date', async () => {
    const root = await dated();
    await expect(ensureCapture(root, '10 March')).rejects.toThrow('is not a date');
  });

  it('adds the date while something else is reading the manifest', async () => {
    // Windows refuses the rename while a handle is open (EPERM). The app's journal reads the
    // manifest when a job ends, which is when the maps of a photo run ask for their survey date:
    // a refused write left those maps without a date. The write waits the reader out.
    const root = await dated();
    const reader = await open(join(root, 'manifest.json'), 'r');
    const added = ensureCapture(root, '2026-03-14');
    setTimeout(() => void reader.close(), 50);
    const r = await added;
    expect(r).toMatchObject({ captureId: 'capture-2026-03-14', created: true });
    expect((await readManifest(root)).captures.map((c) => c.id)).toContain('capture-2026-03-14');
    // every save has a temporary file of its own name now: none of them may stay
    expect((await readdir(root)).filter((n) => n.endsWith('.partial'))).toEqual([]);
  });
});

describe('isImportableExtension', () => {
  it('knows what the builder takes and what it leaves out', () => {
    expect(isImportableExtension('.lrf')).toBe(false);
    expect(isImportableExtension('.db')).toBe(false);
    expect(isImportableExtension('.srt')).toBe(true);
    expect(isImportableExtension('.jpg')).toBe(true);
    expect(isImportableExtension('.mp4')).toBe(true);
    expect(isImportableExtension('.glb')).toBe(true);
    expect(isImportableExtension('.dxf')).toBe(true);
    expect(isImportableExtension('.dwg')).toBe(true);
    expect(isImportableExtension('.insv')).toBe(true);
    expect(isImportableExtension('.lrv')).toBe(true);
  });
});

describe('importDay', () => {
  it('is the most frequent day, a tie to the earlier, null for none', () => {
    expect(importDay([])).toBeNull();
    expect(importDay(['2019-01-25', '2019-01-24', '2019-01-25'])).toBe('2019-01-25');
    expect(importDay(['2019-01-25', '2019-01-24'])).toBe('2019-01-24');
  });
});

describe('one import is one survey date', () => {
  const photo = async (name: string, taken: string | undefined): Promise<string> => {
    const f = join(dir, name);
    await writeFile(
      f,
      withExif({
        ...(taken ? { dateTimeOriginal: taken } : {}),
        lat: 29.0276,
        lon: 48.1352,
        alt: 100,
      }),
    );
    return f;
  };
  const photosOf = (m: ProjectManifest) =>
    m.layers.flatMap((l) => (l.kind === 'photos' ? [l] : []));

  it('files every layer of a dated import under the day most files carry', async () => {
    const root = await project();
    const files = [
      await photo('a.jpg', '2019:01:24 10:00:00'),
      await photo('b.jpg', '2019:01:24 10:01:00'),
      await photo('c.jpg', '2019:01:24 10:02:00'),
      await photo('d.jpg', '2019:01:25 10:00:00'),
    ];
    await writeFile(join(dir, 'flare.glb'), glb());
    const r = await importRawFiles(root, [...files, join(dir, 'flare.glb')], deps());
    const m = await readManifest(root);
    expect(m.captures.map((c) => c.date)).toEqual(['2019-01-24']);
    const id = m.captures[0]?.id;
    expect(m.layers.find((l) => l.kind === 'mesh')?.capture).toBe(id);
    const photos = photosOf(m);
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({ id: 'photos-2019-01-24', capture: id });
    expect(photos[0]?.items.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(r.items.filter((i) => i.kind === 'photo').map((i) => i.layerId)).toEqual(
      Array(4).fill('photos-2019-01-24'),
    );
  });

  it('a tie goes to the earlier day', async () => {
    const root = await project();
    const files = [
      await photo('a.jpg', '2019:01:25 10:00:00'),
      await photo('b.jpg', '2019:01:24 10:00:00'),
    ];
    await importRawFiles(root, files, deps());
    expect((await readManifest(root)).captures.map((c) => c.date)).toEqual(['2019-01-24']);
  });

  it('a second import on the same day gets a photos layer of its own and adds no date', async () => {
    const root = await project();
    const first = await importRawFiles(root, [await photo('a.jpg', '2019:01:24 10:00:00')], deps());
    const second = await importRawFiles(
      root,
      [await photo('b.jpg', '2019:01:24 11:00:00')],
      deps(),
    );
    const m = await readManifest(root);
    expect(m.captures).toHaveLength(1);
    const id = m.captures[0]?.id ?? '';
    expect(first.createdCaptures).toEqual([id]);
    expect(second.createdCaptures).toEqual([]);
    const photos = photosOf(m);
    expect(photos.map((l) => [l.id, l.name, l.capture, l.items.map((p) => p.id)])).toEqual([
      ['photos-2019-01-24', 'Photos, 24 Jan 2019', id, ['a']],
      ['photos-2019-01-24-2', 'Photos 2, 24 Jan 2019', id, ['b']],
    ]);
    expect(second.items.map((i) => i.layerId)).toEqual(['photos-2019-01-24-2']);
  });

  it('names each photos layer after its import: the date, then a number for the same day', async () => {
    const root = await project();
    await importRawFiles(root, [await photo('a.jpg', '2024:11:06 10:00:00')], deps());
    await importRawFiles(root, [await photo('b.jpg', '2024:11:06 11:00:00')], deps());
    await importRawFiles(root, [await photo('c.jpg', undefined)], deps());
    await importRawFiles(root, [await photo('d.jpg', undefined)], deps());
    expect(photosOf(await readManifest(root)).map((l) => [l.id, l.name])).toEqual([
      ['photos-2024-11-06', 'Photos, 6 Nov 2024'],
      ['photos-2024-11-06-2', 'Photos 2, 6 Nov 2024'],
      ['photos', 'Photos'],
      ['photos-2', 'Photos 2'],
    ]);
  });

  it('an import with no dated file adds no date, tags nothing and files its photos in a layer of its own', async () => {
    const root = await project();
    await writeFile(join(dir, 'flare.glb'), glb());
    const r = await importRawFiles(
      root,
      [await photo('a.jpg', undefined), join(dir, 'flare.glb')],
      deps(),
    );
    expect(r.createdCaptures).toEqual([]);
    const again = await importRawFiles(root, [await photo('b.jpg', undefined)], deps());
    expect(again.items.map((i) => i.layerId)).toEqual(['photos-2']);
    const m = await readManifest(root);
    expect(m.captures).toEqual([]);
    expect(m.layers.every((l) => l.capture === undefined)).toBe(true);
    const photos = photosOf(m);
    expect(photos.map((l) => [l.id, l.items.map((p) => p.id)])).toEqual([
      ['photos', ['a']],
      ['photos-2', ['b']],
    ]);
  });

  it('names no created date when the day had one, or another save added it meanwhile', async () => {
    const root = await project();
    await ensureCapture(root, '2019-01-24');
    const had = await importRawFiles(root, [await photo('a.jpg', '2019:01:24 10:00:00')], deps());
    expect(had.createdCaptures).toEqual([]);
    expect(photosOf(had.manifest)[0]).toMatchObject({
      id: 'photos-2019-01-24',
      capture: 'capture-2019-01-24',
    });
    // the day has no date when the import reads the project; another writer adds it meanwhile
    let added = false;
    const meanwhile = await importRawFiles(
      root,
      [await photo('b.jpg', '2019:01:25 10:00:00')],
      deps({
        images: {
          resizeJpeg: async (src, dst) => {
            if (!added) await ensureCapture(root, '2019-01-25');
            added = true;
            await copyFile(src, dst);
          },
        },
      }),
    );
    expect(meanwhile.createdCaptures).toEqual([]);
    expect(meanwhile.manifest.captures.filter((c) => c.date === '2019-01-25')).toHaveLength(1);
    const made = await importRawFiles(root, [await photo('c.jpg', '2019:01:26 10:00:00')], deps());
    expect(made.createdCaptures).toEqual(['capture-2019-01-26']);
  });

  it("a video's day is its local start day", async () => {
    const root = await project();
    await writeFile(join(dir, 'DJI_0498.MP4'), new Uint8Array(16));
    await writeFile(join(dir, 'DJI_0498.SRT'), 'srt text');
    const video: VideoTools = {
      probe: () =>
        Promise.resolve({
          width: 3840,
          height: 2160,
          codec: 'avc1',
          durationMs: 9009,
          frameTimesMs: [0, 33.4],
        }),
      flightFromSrt: () => ({
        doc: {
          startUtcMs: Date.UTC(2024, 10, 5, 22, 30),
          lens: { model: 'pinhole', hfovDeg: 71.59, aspect: 1.7778 },
          samples: [{ t: 0, pos: [0, 100, 0], q: [0, 0, 0, 1] }],
          heights: { source: 'relative', absOffsetM: 0, takeoffH: 30 },
        },
        warnings: [],
        timing: { withinOneFrame: true, maxErrorMs: 1.3, frameMs: 33.4 },
        orientation: 'estimated',
        heightSource: 'relative',
      }),
      srtAltitudes: () => ({ readings: [] }),
    };
    await importRawFiles(root, [join(dir, 'DJI_0498.MP4')], deps({ video }));
    const m = await readManifest(root);
    expect(m.captures.map((c) => c.date)).toEqual(['2024-11-06']);
    expect(m.layers.find((l) => l.kind === 'video')?.capture).toBe(m.captures[0]?.id);
  });

  it('a cancelled import files what it read', async () => {
    const root = await project();
    const stop = new AbortController();
    const files = [
      await photo('a.jpg', '2019:01:24 10:00:00'),
      await photo('b.jpg', '2019:01:24 10:01:00'),
    ];
    const r = await importRawFiles(
      root,
      files,
      deps({
        signal: stop.signal,
        onProgress: () => {
          stop.abort();
        },
      }),
    );
    expect(r.items.map((i) => i.status)).toEqual(['imported', 'skipped']);
    const m = await readManifest(root);
    expect(m.captures.map((c) => c.date)).toEqual(['2019-01-24']);
    expect(photosOf(m)[0]).toMatchObject({ id: 'photos-2019-01-24', capture: m.captures[0]?.id });
    expect(photosOf(m)[0]?.items.map((p) => p.id)).toEqual(['a']);
  });
});

describe('model textures with spaces in their names', () => {
  it('imports an OBJ with a spaced texture and does not file its JPEG as a photo', async () => {
    const root = await project();
    const src = join(dir, 'src');
    await mkdir(src, { recursive: true });
    const quad = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\n';
    await writeFile(
      join(src, 'tower.obj'),
      `mtllib tower.mtl\nusemtl a\n${quad}f 1/1 2/2 3/3 4/4\n`,
    );
    await writeFile(join(src, 'tower.mtl'), 'newmtl a\nmap_Kd tower stack_texture.jpg\n');
    const tex = join(src, 'tower stack_texture.jpg');
    await writeFile(tex, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
    const r = await importRawFiles(root, [join(src, 'tower.obj'), tex], deps());
    const mesh = r.items.find((i) => i.kind === 'mesh');
    expect(mesh?.status).toBe('imported');
    expect(mesh?.message).not.toContain('not found');
    expect(r.items.find((i) => i.file === 'tower stack_texture.jpg')?.status).toBe('skipped');
    expect(r.manifest.layers.some((l) => l.kind === 'photos')).toBe(false);
  });
});

describe('obj placement', () => {
  it('stands a Pix4D OBJ export up and places it by its offset', async () => {
    const root = await project();
    const mesh = join(dir, 'tower', '2_densification', '3d_mesh');
    const params = join(dir, 'tower', '1_initial', 'params');
    await mkdir(mesh, { recursive: true });
    await mkdir(params, { recursive: true });
    const off = [ORIGIN[0] + 300, ORIGIN[1] - 200, 12];
    await writeFile(join(params, 'tower_offset.xyz'), `${off.join(' ')}\n`);
    const obj = join(mesh, 'tower.obj');
    await writeFile(obj, 'v 0 0 0\nv 1 0 0\nv 0 0 10\nf 1 2 3\n');
    const r = await importRawFiles(root, [obj], deps());
    const layer = r.manifest.layers.find((l) => l.kind === 'mesh');
    expect(layer?.kind === 'mesh' ? layer.transform : []).toEqual([
      1,
      0,
      0,
      0,
      0,
      0,
      -1,
      0,
      0,
      1,
      0,
      0,
      300,
      12 - ORIGIN[2],
      200,
      1,
    ]);
    expect(r.items[0]?.message).toContain('Pix4D export: stood upright (Z up)');
  });
  it('leaves a small OBJ outside a Pix4D layout as it is', async () => {
    const root = await project();
    const obj = join(dir, 'pad.obj');
    await writeFile(obj, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    const r = await importRawFiles(root, [obj], deps());
    const layer = r.manifest.layers.find((l) => l.kind === 'mesh');
    expect(layer?.kind === 'mesh' ? layer.transform : []).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    expect(r.items[0]?.message).toContain('Up axis');
  });
});
