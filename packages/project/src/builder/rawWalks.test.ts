import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, updateCapture } from './create';
import { NO_PIPELINE, importRawFiles, type ImportDeps } from './raw';
import type { WalkTools } from './walks';
import type { WalkTrack } from './walkSource';

/* The raw importer's 360 video branch: camera files, their proxies, and "Add 360 video". */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-raw-walks-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const vide = (w: number, h: number, codec = 'hvc1'): WalkTrack => ({
  handler: 'vide',
  width: w,
  height: h,
  codec,
  fps: 30,
  durationMs: 2000,
  spherical: null,
});

function walkTools(tracksBy: Record<string, WalkTrack[]>): WalkTools {
  return {
    tracks: (file) => {
      const hit = tracksBy[file.split(/[\\/]/).pop() ?? ''];
      return hit ? Promise.resolve(hit) : Promise.reject(new Error('Not an MP4 or MOV file.'));
    },
    check: () => Promise.resolve({ ok: true, v360: true, version: '8.1' }),
    copy: async (out, o) => {
      o.onProgress?.(0.25);
      await writeFile(out, 'video');
      return { width: 256, height: 128, fps: 30, encoder: 'libx264', filter: 'v360=test' };
    },
  };
}

const deps = (over: Partial<ImportDeps> = {}): ImportDeps => ({
  images: { resizeJpeg: (src, dst) => copyFile(src, dst) },
  jobs: NO_PIPELINE,
  utcOffsetMin: 0,
  ...over,
});

async function project(): Promise<string> {
  const r = await createProject(dir, {
    name: 'Walks',
    type: 'inspection',
    epsg: 32639,
    origin: [500000, 3200000, 0],
    severityTemplate: null,
  });
  return r.root;
}

const src = async (name: string) => {
  const p = join(dir, name);
  await writeFile(p, 'source');
  return p;
};

const CLIP = 'VID_20260101_120000_00_001.insv';
const PROXY = 'LRV_20260101_120000_01_001.lrv';

describe('importRawFiles, 360 video', () => {
  it('stores a camera file as a walk and leaves the manifest and its backups alone', async () => {
    const root = await project();
    const before = await readFile(join(root, 'manifest.json'), 'utf8');
    const filesBefore = (await readdir(root)).sort();
    const progress: [string, number][] = [];
    const r = await importRawFiles(root, [await src(CLIP)], {
      ...deps({ walk: walkTools({ [CLIP]: [vide(128, 128), vide(128, 128)] }) }),
      onFileProgress: (file, f) => progress.push([file, f]),
    });
    expect(r.items).toEqual([
      expect.objectContaining({ file: CLIP, kind: 'video', status: 'imported' }),
    ]);
    expect(r.items[0]?.layerId).toBeUndefined();
    expect(r.items[0]?.message).toContain('Stitched to 256 x 128');
    expect(r.backup).toBe('');
    expect(await readFile(join(root, 'manifest.json'), 'utf8')).toBe(before);
    expect((await readdir(root)).sort()).toEqual([...filesBefore, 'walks'].sort());
    expect(await readdir(join(root, 'walks'))).toEqual(['vid-20260101-120000-00-001']);
    expect(progress).toContainEqual([CLIP, 0.25]);
  });

  it('skips the low resolution proxy of a clip in the same import', async () => {
    const root = await project();
    const tools = walkTools({
      [CLIP]: [vide(128, 128), vide(128, 128)],
      [PROXY]: [vide(128, 64, 'avc1')],
    });
    const r = await importRawFiles(
      root,
      [await src(PROXY), await src(CLIP)],
      deps({ walk: tools }),
    );
    expect(r.items.map((i) => [i.file, i.status])).toEqual([
      [PROXY, 'skipped'],
      [CLIP, 'imported'],
    ]);
    expect(r.items[0]?.message).toContain(CLIP);
    expect(await readdir(join(root, 'walks'))).toHaveLength(1);
  });

  it('imports a proxy that comes on its own', async () => {
    const root = await project();
    const r = await importRawFiles(
      root,
      [await src(PROXY)],
      deps({ walk: walkTools({ [PROXY]: [vide(128, 64, 'avc1')] }) }),
    );
    expect(r.items[0]).toMatchObject({ file: PROXY, kind: 'video', status: 'imported' });
    expect(r.items[0]?.message).toContain('low resolution');
  });

  it('says so when this build has no 360 video tools', async () => {
    const root = await project();
    const r = await importRawFiles(root, [await src(CLIP)], deps());
    expect(r.items[0]).toMatchObject({ kind: 'video', status: 'error' });
    expect(r.items[0]?.message).toContain('360 video');
  });

  it('reports a skipped layout and adds nothing', async () => {
    const root = await project();
    const r = await importRawFiles(
      root,
      [await src(CLIP)],
      deps({ walk: walkTools({ [CLIP]: [vide(128, 128)] }) }),
    );
    expect(r.items[0]).toMatchObject({ kind: 'video', status: 'skipped' });
    expect(r.items[0]?.message).toContain('one video track');
  });

  it('takes an MP4 as 360 video only when asked to', async () => {
    const root = await project();
    const tools = walkTools({ 'tour.mp4': [vide(256, 128, 'avc1')] });
    const plain = await importRawFiles(root, [await src('tour.mp4')], deps({ walk: tools }));
    expect(plain.items[0]).toMatchObject({ kind: 'video', status: 'skipped' });
    expect(plain.items[0]?.message).toContain('SRT');
    const as360 = await importRawFiles(
      root,
      [join(dir, 'tour.mp4')],
      deps({ walk: tools, as360: true }),
    );
    expect(as360.items[0]).toMatchObject({ file: 'tour.mp4', kind: 'video', status: 'imported' });
    expect(as360.backup).toBe('');
    expect(await readdir(join(root, 'walks'))).toEqual(['tour']);
  });

  /** A tiny but valid GLB (an empty scene). */
  async function glbFile(name: string): Promise<string> {
    const json = new TextEncoder().encode('{"asset":{"version":"2.0"},"scenes":[{"nodes":[]}]}  ');
    const b = new Uint8Array(20 + json.length);
    const v = new DataView(b.buffer);
    v.setUint32(0, 0x46546c67, true);
    v.setUint32(4, 2, true);
    v.setUint32(8, b.length, true);
    v.setUint32(12, json.length, true);
    v.setUint32(16, 0x4e4f534a, true);
    b.set(json, 20);
    const p = join(dir, name);
    await writeFile(p, b);
    return p;
  }
  const layersOnDisk = async (root: string) =>
    (
      JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
        layers: { kind: string }[];
      }
    ).layers.map((l) => l.kind);

  it('saves the other files of a mixed import before the stitch starts', async () => {
    const root = await project();
    const tools = walkTools({ [CLIP]: [vide(128, 128), vide(128, 128)] });
    const seen: { layers: string[]; walks: boolean }[] = [];
    const copy = tools.copy.bind(tools);
    tools.copy = async (out, o) => {
      // the model given after the clip is already in the saved manifest when the stitch begins
      seen.push({
        layers: await layersOnDisk(root),
        walks: (await readdir(root)).includes('walks'),
      });
      return copy(out, o);
    };
    const ticks: string[] = [];
    const r = await importRawFiles(root, [await src(CLIP), await glbFile('pad.glb')], {
      ...deps({ walk: tools }),
      onProgress: (done, total, file) => ticks.push(`${String(done)}/${String(total)} ${file}`),
    });
    expect(seen).toEqual([{ layers: ['mesh'], walks: true }]);
    // the rows stay in the order the files were given; the clip is counted when it is done
    expect(r.items.map((i) => [i.file, i.status])).toEqual([
      [CLIP, 'imported'],
      ['pad.glb', 'imported'],
    ]);
    expect(r.items[0]?.message).toContain('Stitched to 256 x 128');
    expect(ticks).toEqual(['1/2 pad.glb', `2/2 ${CLIP}`]);
    expect(r.backup).not.toBe('');
    expect(r.manifest.layers.map((l) => l.kind)).toEqual(['mesh']);
  });

  it('hands back the manifest as it is when the stitch ends, not as it was before it', async () => {
    const root = await project();
    const tools = walkTools({ [CLIP]: [vide(128, 128), vide(128, 128)] });
    const copy = tools.copy.bind(tools);
    let captureId = '';
    tools.copy = async (out, o) => {
      // while the clip is stitched, the person adds a survey date
      const added = await import('./create').then((m) => m.ensureCapture(root, '2026-02-03'));
      captureId = added.captureId;
      await updateCapture(root, captureId, { label: 'Renamed while stitching' });
      return copy(out, o);
    };
    const mixed = await importRawFiles(
      root,
      [await glbFile('pad.glb'), await src(CLIP)],
      deps({ walk: tools }),
    );
    expect(mixed.manifest.captures.map((c) => c.label)).toContain('Renamed while stitching');
    expect(mixed.manifest.layers.map((l) => l.kind)).toEqual(['mesh']);
    // and the same for an import of nothing but a clip, which saves no manifest
    tools.copy = async (out, o) => {
      await updateCapture(root, captureId, { label: 'Renamed again' });
      return copy(out, o);
    };
    const only = await importRawFiles(root, [join(dir, CLIP)], deps({ walk: tools }));
    expect(only.backup).toBe('');
    expect(only.manifest.captures.map((c) => c.label)).toContain('Renamed again');
  });

  it('keeps importing other files beside a walk, and then saves the manifest once', async () => {
    const root = await project();
    const glb = join(dir, 'pad.glb');
    const json = new TextEncoder().encode('{"asset":{"version":"2.0"},"scenes":[{"nodes":[]}]}  ');
    const b = new Uint8Array(20 + json.length);
    const v = new DataView(b.buffer);
    v.setUint32(0, 0x46546c67, true);
    v.setUint32(4, 2, true);
    v.setUint32(8, b.length, true);
    v.setUint32(12, json.length, true);
    v.setUint32(16, 0x4e4f534a, true);
    b.set(json, 20);
    await writeFile(glb, b);
    const r = await importRawFiles(
      root,
      [await src(CLIP), glb],
      deps({ walk: walkTools({ [CLIP]: [vide(128, 128), vide(128, 128)] }) }),
    );
    expect(r.items.map((i) => i.status)).toEqual(['imported', 'imported']);
    expect(r.backup).not.toBe('');
    expect(r.manifest.layers.map((l) => l.kind)).toEqual(['mesh']);
  });
});
