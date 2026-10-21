import { VLM_DETECTOR_SCHEMA, type VlmDetector } from '@aio/schema';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectorDirs,
  exportDetector,
  importDetector,
  listDetectors,
  resolveDetectors,
  saveDetector,
  type DetectorOptions,
} from './detectors';
import type { AnalyticsPack } from './pack';

const SHA = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

let root: string;
let pack: AnalyticsPack;
let o: DetectorOptions;

const det = (id: string, over: Partial<VlmDetector> = {}): VlmDetector => ({
  schema: VLM_DETECTOR_SCHEMA,
  id,
  name: `Detector ${id}`,
  version: 1,
  classId: 'defect',
  assetTypes: ['roof'],
  looksLike: 'a dark patch',
  ignore: '',
  question: 'Is this a defect?',
  tiles: { n: 2, overlap: 0.2, sendW: 1344, sendH: 1008 },
  threshold: 0.8,
  tunedOn: { model: 'qwen', modelSha256: SHA },
  author: 'tester',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  source: 'user',
  status: 'experimental',
  ...over,
});

async function put(dir: string, d: VlmDetector, files: Record<string, string> = {}) {
  const base = join(dir, d.id);
  await mkdir(base, { recursive: true });
  await writeFile(join(base, 'detector.json'), JSON.stringify(d));
  for (const [name, data] of Object.entries(files)) {
    await mkdir(join(base, ...name.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(base, ...name.split('/')), data);
  }
}

const withSamples = (id: string) =>
  det(id, {
    samples: [{ photo: 'p1.jpg', file: 'samples/s1.jpg' }],
    examples: [{ file: 'examples/e1.jpg', verdict: 'is' }],
  });
const SAMPLE_FILES = { 'samples/s1.jpg': 'S1', 'examples/e1.jpg': 'E1' };

/** A hand-built gzipped tar: each entry is { path, data?, type?, linkpath? }. */
function tarball(
  entries: { path: string; data?: string; type?: string; linkpath?: string }[],
): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.data ?? '');
    const h = Buffer.alloc(512);
    h.write(e.path, 0, 100);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.type ?? '0', 156);
    if (e.linkpath) h.write(e.linkpath, 157, 100);
    h.write('ustar\0' + '00', 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-detectors-'));
  const dir = join(root, 'pack');
  await mkdir(dir, { recursive: true });
  pack = {
    version: '1.0.0',
    dir,
    manifest: { model: { sha256: SHA } },
  } as unknown as AnalyticsPack;
  o = { pack, userData: join(root, 'user'), projectDir: join(root, 'project') };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('detectors', () => {
  it('lists shipped, library and project with where', async () => {
    const dirs = detectorDirs(o);
    expect(dirs.shipped).toBe(join(pack.dir, 'detectors'));
    expect(dirs.library).toBe(join(root, 'user', 'detectors'));
    expect(dirs.project).toBe(join(root, 'project', 'detectors'));
    await put(join(dirs.shipped ?? '', 'roof'), det('ship-one', { source: 'shipped' }));
    await put(dirs.library, det('lib-one'));
    await put(dirs.project ?? '', det('proj-one'));
    await mkdir(join(dirs.library, 'junk'), { recursive: true }); // no detector.json: skipped
    const items = await listDetectors(o);
    expect(items.map((i) => [i.where, i.detector.id]).sort()).toEqual([
      ['library', 'lib-one'],
      ['project', 'proj-one'],
      ['shipped', 'ship-one'],
    ]);
    expect(await listDetectors({ ...o, pack: null, projectDir: undefined })).toHaveLength(1);
  });

  it('save bumps version', async () => {
    expect(await saveDetector(o, 'library', det('bump-me'))).toBe(1);
    expect(await saveDetector(o, 'library', det('bump-me'))).toBe(2);
    expect(await saveDetector(o, 'project', det('bump-me', { version: 5 }))).toBe(5);
    const [lib] = (await listDetectors(o)).filter((i) => i.where === 'library');
    expect(lib?.detector.version).toBe(2);
    expect(lib?.detector.source).toBe('user');
    expect(lib?.detector.updatedAt).not.toBe('2026-10-01T00:00:00.000Z');
    await saveDetector(o, 'library', det('imp', { source: 'imported' }));
    const imp = (await listDetectors(o)).find((i) => i.detector.id === 'imp');
    expect(imp?.detector.source).toBe('imported');
    await expect(
      saveDetector({ ...o, projectDir: undefined }, 'project', det('x1')),
    ).rejects.toThrow();
  });

  it('export then import round-trips', async () => {
    await put(detectorDirs(o).library, withSamples('round-trip'), SAMPLE_FILES);
    const file = join(root, 'out.aiodet');
    await exportDetector(o, 'library', 'round-trip', file, true);
    const r = await importDetector(o, file, 'project');
    expect(r).toEqual({ id: 'round-trip' });
    const dir = join(root, 'project', 'detectors', 'round-trip');
    expect(await readFile(join(dir, 'samples', 's1.jpg'), 'utf8')).toBe('S1');
    expect(await readFile(join(dir, 'examples', 'e1.jpg'), 'utf8')).toBe('E1');
    const got = (await listDetectors(o)).find((i) => i.where === 'project')?.detector;
    expect(got?.source).toBe('imported');
    expect(got?.samples).toHaveLength(1);
  });

  it('export without samples drops samples and examples', async () => {
    await put(detectorDirs(o).library, withSamples('no-samples'), SAMPLE_FILES);
    const file = join(root, 'bare.aiodet');
    await exportDetector(o, 'library', 'no-samples', file, false);
    await importDetector(o, file, 'project');
    const dir = join(root, 'project', 'detectors', 'no-samples');
    expect(await readdir(dir)).toEqual(['detector.json']);
    const json = JSON.parse(await readFile(join(dir, 'detector.json'), 'utf8')) as VlmDetector;
    expect(json.samples).toBeUndefined();
    expect(json.examples).toBeUndefined();
  });

  it('refuses an archive entry outside the detector folder', async () => {
    const good = JSON.stringify(det('inside'));
    const cases = [
      [
        { path: 'inside/detector.json', data: good },
        { path: 'other/x.txt', data: 'x' },
      ],
      [
        { path: 'inside/detector.json', data: good },
        { path: 'inside/../../evil.txt', data: 'x' },
      ],
      [{ path: '/abs/detector.json', data: good }],
      [
        { path: 'inside/detector.json', data: good },
        { path: 'inside/stray.txt', data: 'x' },
      ],
    ];
    for (const entries of cases) {
      const file = join(root, 'bad.aiodet');
      await writeFile(file, tarball(entries));
      await expect(importDetector(o, file, 'library')).rejects.toThrow();
    }
    expect(await listDetectors({ ...o, pack: null })).toEqual([]);
  });

  it('refuses a sample named . or a folder', async () => {
    const d = det('dots', { samples: [{ photo: 'p', file: 'samples/.' }] });
    const file = join(root, 'dots.aiodet');
    await writeFile(
      file,
      tarball([
        { path: 'dots/detector.json', data: JSON.stringify(d) },
        { path: 'dots/samples/', type: '5' },
      ]),
    );
    await expect(importDetector(o, file, 'library')).rejects.toThrow();
  });

  it('refuses a link entry', async () => {
    const file = join(root, 'link.aiodet');
    await writeFile(
      file,
      tarball([
        { path: 'lnk/detector.json', data: JSON.stringify(det('lnk')) },
        { path: 'lnk/samples/s.jpg', type: '2', linkpath: '../../secret' },
      ]),
    );
    await expect(importDetector(o, file, 'library')).rejects.toThrow(/link/i);
  });

  it('refuses aio.vlm-detector/2', async () => {
    const file = join(root, 'v2.aiodet');
    const body = JSON.stringify({ ...det('future'), schema: 'aio.vlm-detector/2' });
    await writeFile(file, tarball([{ path: 'future/detector.json', data: body }]));
    await expect(importDetector(o, file, 'library')).rejects.toThrow(/newer|aio\.vlm-detector\/2/);
  });

  it('refuses an archive over 50 MB unpacked', async () => {
    const file = join(root, 'big.aiodet');
    const d = det('big', { samples: [{ photo: 'p', file: 'samples/s.jpg' }] });
    await writeFile(
      file,
      tarball([
        { path: 'big/detector.json', data: JSON.stringify(d) },
        { path: 'big/samples/s.jpg', data: 'x'.repeat(51 * 1024 * 1024) },
      ]),
    );
    await expect(importDetector(o, file, 'library')).rejects.toThrow(/50 MB/);
  });

  it('conflict reports versions; keep-both renames', async () => {
    await put(detectorDirs(o).library, det('same', { version: 3 }));
    const file = join(root, 'same.aiodet');
    await exportDetector(o, 'library', 'same', file, true);
    await saveDetector(o, 'project', det('same', { version: 2 }));
    expect(await importDetector(o, file, 'project')).toEqual({
      conflict: { id: 'same', have: 2, incoming: 3 },
    });
    expect(await importDetector(o, file, 'project', 'keep-both')).toEqual({ id: 'same-2' });
    expect(await importDetector(o, file, 'project', 'keep-both')).toEqual({ id: 'same-3' });
    const two = (await listDetectors(o)).find((i) => i.detector.id === 'same-2')?.detector;
    expect(two?.name).toBe('Detector same (2)');
    expect(await importDetector(o, file, 'project', 'update')).toEqual({ id: 'same' });
    const same = (await listDetectors(o)).find(
      (i) => i.where === 'project' && i.detector.id === 'same',
    )?.detector;
    expect(same?.version).toBe(3);
  });

  it('flags a different modelSha256', async () => {
    await put(detectorDirs(o).library, det('match'));
    await put(
      detectorDirs(o).project ?? '',
      det('differs', { tunedOn: { model: 'q', modelSha256: OTHER } }),
    );
    const items = await listDetectors(o);
    expect(items.find((i) => i.detector.id === 'match')?.modelMismatch).toBe(false);
    expect(items.find((i) => i.detector.id === 'differs')?.modelMismatch).toBe(true);
    const none = await listDetectors({ ...o, pack: null });
    expect(none.every((i) => !i.modelMismatch)).toBe(true);
  });

  it('resolveDetectors refuses an unknown id and resolves by where', async () => {
    await put(detectorDirs(o).library, det('dup', { name: 'Library one' }));
    await put(detectorDirs(o).project ?? '', det('dup', { name: 'Project one' }));
    await put(detectorDirs(o).library, det('other-one'));
    const got = await resolveDetectors(o, [
      { where: 'project', id: 'dup' },
      { where: 'library', id: 'other-one' },
    ]);
    expect(got.map((d) => d.name)).toEqual(['Project one', 'Detector other-one']);
    await expect(resolveDetectors(o, [{ where: 'library', id: 'nope-x' }])).rejects.toThrow(
      /nope-x/,
    );
  });
});
