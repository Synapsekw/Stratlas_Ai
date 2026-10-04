import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Issue, parseManifest, validateIssueAgainstModel } from '@aio/schema';
import { toWgs84 } from '@aio/geo';
import { importAik } from './aik';

/** Minimal GLB: header + JSON chunk (one node, no meshes). */
function tinyGlb(): Buffer {
  let json = JSON.stringify({
    asset: { version: '2.0' },
    nodes: [{ name: '01 | Stack shell' }],
    scenes: [{ nodes: [0] }],
  });
  while (json.length % 4) json += ' ';
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'ascii');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + json.length, 8);
  head.writeUInt32LE(json.length, 12);
  head.write('JSON', 16, 'ascii');
  return Buffer.concat([head, Buffer.from(json)]);
}

/** 1x1 grey PNG (enough for the mask slicer, which only copies bytes). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==',
  'base64',
);

describe('importAik (synthetic kit offline build)', () => {
  let root = '';
  const src = () => join(root, 'src');
  const out = () => join(root, 'out');
  const epsg = 32639;
  const base = [220000, 3213000];
  const gps = (xn: number, ze: number) =>
    toWgs84([(base[0] ?? 0) + ze, (base[1] ?? 0) + xn, 0], epsg);

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'aio-aik-'));
    for (const d of ['data', 'photos', 'thumbs', 'report', 'downloads', '_rebuild/job']) {
      mkdirSync(join(src(), d), { recursive: true });
    }
    const ff = (args: string[]) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);
    for (const id of ['p001', 'p002', 'p003']) {
      ff([
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=160x120',
        '-frames:v',
        '1',
        join(src(), `photos/${id}.jpg`),
      ]);
    }
    const masks = Buffer.concat([PNG, PNG, PNG]);
    const n = PNG.length;
    const data = (key: string, b: Buffer) => {
      writeFileSync(join(src(), `data/${key}.js`), `__kitData("${key}","${b.toString('base64')}")`);
    };
    data('masks-00', masks);
    data('model', gzipSync(tinyGlb()));
    const photo = (
      id: string,
      xn: number,
      ze: number,
      status: string,
      findings: string[],
      kind = 'RGB',
    ) => {
      const [lon, lat] = gps(xn, ze);
      return {
        id,
        latitude: lat,
        longitude: lon,
        altitude: 31.7 + 10,
        position: [xn, 10, ze],
        target: [0, 10, 0],
        hfov: 40,
        vfov: 30,
        width: 640,
        height: 480,
        previewWidth: 160,
        previewHeight: 120,
        time: '2019:01:24 11:45:58',
        status,
        note: status === 'uncertain' ? 'Heat affected.' : '',
        findings,
        kind,
      };
    };
    const kit = {
      job: { title: 'Test stack', customer: 'ACME', location: 'Kuwait' },
      profile: {
        id: 'stack',
        name: 'Stack',
        classes: [
          { id: 2, key: 'moderate', label: 'Moderate rust', severity: 2, color: '#ff7a2d' },
          { id: 4, key: 'uncertain', label: 'Uncertain', uncertain: true, color: '#b68ef8' },
        ],
        severity: [
          { level: 1, label: 'Light', long: 'Light staining', color: '#fad34b' },
          { level: 2, label: 'Moderate', long: 'Moderate rust', color: '#ff7a2d' },
        ],
        uncertain: { label: 'Uncertain', long: 'Uncertain only', color: '#b68ef8' },
      },
      photos: [
        photo('p001', -30, 0, 'finding', ['F01']),
        photo('p002', 0, 30, 'uncertain', []),
        photo('p003', 30, 0, 'none', [], 'T'),
      ],
      findings: [
        {
          fid: 'F01',
          photo: 'p001',
          severity: 2,
          class: null,
          classLabel: '',
          bbox: [10, 10, 50, 40],
          note: 'Rust.',
          component: 'Seam',
          placement: 'patch',
          center: [-1, 10, 0],
          normal: [-1, 0, 0],
          height: 10,
          side: 'S',
          zoneLabel: 'Stack',
          coverage: 1.5,
          defect: null,
        },
      ],
      stats: { photos: 3, findings: 1, defects: null, uncertain_only: 1 },
      masks: {
        'lbl/p001': ['masks-00', 0, n],
        'ov/p001': ['masks-00', n, n],
        'unc/p002': ['masks-00', 2 * n, n],
      },
      files: {
        'masks-00': { chunks: ['masks-00'], gz: false },
        model: { chunks: ['model'], gz: true },
      },
      report: { url: 'report/Test-Report.pdf', name: 'Test-Report.pdf', pages: 2 },
      defaultPhoto: 'p001',
      generated: '2026-09-28T16:35Z',
    };
    writeFileSync(
      join(src(), 'OPEN Test Review.html'),
      `<html><script>window.KIT=${JSON.stringify(kit)};</script></html>`,
    );
    writeFileSync(join(src(), 'report/Test-Report.pdf'), '%PDF');
    writeFileSync(join(src(), 'downloads/Test-findings.csv'), 'fid\nF01\n');
    const positions = Buffer.from(
      new Float32Array([-1, 9, 0, -1, 11, 0, -1, 10, 1]).buffer,
    ).toString('base64');
    const uvs = Buffer.from(new Float32Array([0, 0, 1, 0, 0, 1]).buffer).toString('base64');
    writeFileSync(
      join(src(), '_rebuild/job/surface.json'),
      JSON.stringify({
        patches: [
          {
            photo: 'p001',
            center: [-1, 10, 0],
            textureData: `data:image/png;base64,${PNG.toString('base64')}`,
            positions,
            uvs,
            vertexCount: 3,
          },
        ],
      }),
    );
    writeFileSync(
      join(src(), '_rebuild/job/cameras.json'),
      JSON.stringify({ photos: kit.photos.map((p) => ({ id: p.id, kind: p.kind })) }),
    );
    writeFileSync(join(src(), '_rebuild/job/job.yaml'), 'cover:\n  photo: p002\n  focus_x: 0.5\n');
  }, 60_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = () =>
    importAik({ src: src(), out: out(), id: 'test', epsg, utcOffset: '+03:00', photos: 'all' });

  it('writes a package whose manifest and issues validate', async () => {
    const r = await run();
    const m = parseManifest(JSON.parse(readFileSync(join(out(), 'manifest.json'), 'utf8')));
    if (!m.ok) throw new Error(m.error);
    const man = m.value;
    expect(man.crs).toEqual({ epsg: 32639 });
    expect(man.origin[0]).toBeCloseTo(220000, 1);
    expect(man.origin[1]).toBeCloseTo(3213000, 1);
    expect(man.origin[2]).toBeCloseTo(31.7, 3);
    expect(man.layers.map((l) => `${l.kind}:${l.id}`)).toEqual([
      'mesh:model',
      'photos:photos',
      'photos:thermal',
      'legacy:legacy',
    ]);
    const photos = man.layers.find((l) => l.id === 'photos');
    expect(photos?.kind === 'photos' ? photos.items.map((p) => p.id) : []).toEqual([
      'p001',
      'p002',
    ]);
    const issues = (
      JSON.parse(readFileSync(join(out(), 'issues.json'), 'utf8')) as { issues: unknown[] }
    ).issues.map((i) => Issue.parse(i));
    expect(issues.map((i) => [i.code, i.severity])).toEqual([
      ['F01', 2],
      ['U01', 'uncertain'],
    ]);
    const model = man.severityModels[0];
    if (!model) throw new Error('no model');
    for (const i of issues) expect(validateIssueAgainstModel(i, model).ok).toBe(true);
    expect(issues[0]?.sightings[0]).toMatchObject({
      on: 'mesh',
      geom: { type: 'spatch', src: { path: 'models/patches/F01.json' } },
    });
    expect(r.issues).toBe(2);
  }, 60_000);

  it('writes masks, patch files, report, thumbnail and the legacy viewer', () => {
    for (const f of [
      'photos/masks/p001_mask.png',
      'photos/masks/p001_overlay.png',
      'photos/masks/p002_uncertain_mask.png',
      'photos/masks/p002_uncertain_overlay.png',
      'photos/thumbs/p001.jpg',
      'models/patches/F01.json',
      'models/patches/F01.png',
      'report/Test-Report.pdf',
      'thumbnail.jpg',
      'IMPORT-REPORT.md',
    ]) {
      expect(existsSync(join(out(), f)), f).toBe(true);
    }
    const patch = JSON.parse(readFileSync(join(out(), 'models/patches/F01.json'), 'utf8')) as {
      positions: number[];
    };
    // Kit (x north, z east) to local (x east, z south): [-1, 9, 0] -> [0, 9, 1].
    expect(patch.positions.slice(0, 3)).toEqual([0, 9, 1]);
    const html = join(out(), 'legacy/OPEN Test Review.html');
    expect(statSync(html).ino).toBe(statSync(join(src(), 'OPEN Test Review.html')).ino);
    expect(existsSync(join(out(), 'legacy/photos/p003.jpg'))).toBe(true);
    expect(readFileSync(join(out(), 'IMPORT-REPORT.md'), 'utf8')).toContain('Kit stats');
  });

  it('skips every file on an unchanged re-run', async () => {
    const r = await run();
    expect(r.written).toBe(0);
    expect(r.skipped).toBeGreaterThan(10);
  }, 60_000);
});
