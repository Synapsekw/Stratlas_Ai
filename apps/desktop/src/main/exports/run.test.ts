import { parseCsv } from '@aio/project/export';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleIssue, sampleManifest, writeProject } from '../testing';
import { defaultExportName, runExport, type ExportProgress } from './run';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-run-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A tiny valid PNG header (size only matters to the exporters). */
function pngOf(width: number, height: number): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, deflateSync(Buffer.alloc(0))]);
}

async function project(): Promise<string> {
  const manifest = sampleManifest({
    layers: [
      {
        kind: 'photos',
        id: 'photos',
        name: 'Photos',
        visible: true,
        items: [{ id: 'p1', src: { path: 'photos/p1.jpg' } }],
      },
    ],
    classCatalogues: [
      {
        id: 'cat',
        name: 'Classes',
        assetType: 'tank',
        classes: [{ id: 'coating', label: 'Coating', color: '#e5484d', severityModel: 'sev' }],
      },
    ],
  });
  const issues = [
    sampleIssue({ id: 'a', code: 'F02' }),
    sampleIssue({
      id: 'b',
      code: 'F01',
      sightings: [
        {
          on: 'mesh',
          layer: 'plant',
          geom: { type: 'spoint', p: [1, 2, 3], n: [0, 1, 0] },
        },
      ],
    }),
  ];
  const root = await writeProject(join(dir, 'project'), manifest, {
    'issues.json': JSON.stringify({ schema: 'aio.issues/1', issues }),
  });
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'photos'), { recursive: true });
  await writeFile(join(root, 'photos', 'p1.jpg'), pngOf(640, 480));
  return root;
}

describe('defaultExportName', () => {
  it('names files after the project and format', () => {
    expect(defaultExportName('HCl Tank 710', 'csv')).toBe('HCl-Tank-710-issues.csv');
    expect(defaultExportName('Al-Zour: LNG', 'coco')).toBe('Al-Zour-LNG-issues-coco.json');
    expect(defaultExportName('x', 'kit-json')).toBe('x-assessment.json');
    expect(defaultExportName('x', 'masks-zip')).toBe('x-masks.zip');
    expect(defaultExportName('x', 'report-pdf')).toBe('x-issue-register.pdf');
  });
});

describe('runExport', () => {
  it('writes the CSV through a temporary file and reports progress', async () => {
    const root = await project();
    const out = join(dir, 'out.csv');
    const progress: ExportProgress[] = [];
    const r = await runExport({ root, format: 'csv', outPath: out }, (p) => progress.push(p));
    expect(r.count).toBe(2);
    const rows = parseCsv(await readFile(out, 'utf8'));
    expect(rows.map((x) => x[0])).toEqual(['code', 'F01', 'F02']);
    expect(r.bytes).toBeGreaterThan(100);
    expect(progress.at(-1)).toMatchObject({ done: 1, total: 1 });
    expect(await readdir(dir)).not.toContain('out.csv.part');
  });

  it('exports only the chosen issues', async () => {
    const root = await project();
    const out = join(dir, 'one.geojson');
    const r = await runExport({ root, format: 'geojson', outPath: out, issueIds: ['b'] });
    expect(r.count).toBe(1);
    const fc = JSON.parse(await readFile(out, 'utf8')) as { features: unknown[] };
    expect(fc.features).toHaveLength(1);
  });

  it('reads photo sizes for COCO', async () => {
    const root = await project();
    const out = join(dir, 'coco.json');
    await runExport({ root, format: 'coco', outPath: out });
    const coco = JSON.parse(await readFile(out, 'utf8')) as {
      images: { width: number; height: number }[];
      annotations: unknown[];
    };
    expect(coco.images).toEqual([expect.objectContaining({ width: 640, height: 480 })]);
    expect(coco.annotations).toHaveLength(1);
  });

  it('writes kit JSON', async () => {
    const root = await project();
    const out = join(dir, 'assessment.json');
    await runExport({ root, format: 'kit-json', outPath: out });
    const kit = JSON.parse(await readFile(out, 'utf8')) as { findings: { group: string }[] };
    expect(kit.findings.map((f) => f.group)).toEqual(['F02']);
  });

  it('draws masks and overlays into a ZIP with an index', async () => {
    const root = await project();
    const out = join(dir, 'masks.zip');
    const r = await runExport({ root, format: 'masks-zip', outPath: out });
    const buf = await readFile(out);
    const names = buf.toString('latin1');
    expect(names).toContain('masks/photos/p1_mask.png');
    expect(names).toContain('masks/photos/p1_overlay.png');
    expect(names).toContain('masks.json');
    expect(r.count).toBe(2);
  });

  it('stops when cancelled and leaves no file behind', async () => {
    const root = await project();
    const out = join(dir, 'masks.zip');
    const ac = new AbortController();
    ac.abort();
    await expect(
      runExport({ root, format: 'masks-zip', outPath: out }, undefined, ac.signal),
    ).rejects.toThrow(/cancelled/i);
    expect(await readdir(dir)).toEqual(['project']);
  });

  it('refuses the PDF report, which needs a window', async () => {
    const root = await project();
    await expect(
      runExport({ root, format: 'report-pdf', outPath: join(dir, 'r.pdf') }),
    ).rejects.toThrow(/window/);
  });
});
