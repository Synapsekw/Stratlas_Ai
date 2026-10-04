import { CSV_COLUMNS, parseCsv } from '@aio/project/export';
import { ProjectManifest, SCHEMA_VERSION, type Issue } from '@aio/schema';
import type { ElectronApplication } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { expect, launchApp, test, tinyGlb } from './fixtures';

const PROJECT = 'e2e-exports';

/** A one-page PDF with a line of text, xref offsets computed. */
function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${String(i + 1)} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${String(objs.length + 1)}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${String(objs.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** A grey RGB PNG, so photo crops have something to draw. */
function greyPng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function writeExportProject(dataRoot: string): Promise<void> {
  const dir = join(dataRoot, 'projects', PROJECT);
  await mkdir(join(dir, 'models'), { recursive: true });
  await mkdir(join(dir, 'photos'), { recursive: true });
  await mkdir(join(dir, 'report'), { recursive: true });
  const manifest = ProjectManifest.parse({
    schema: SCHEMA_VERSION,
    id: PROJECT,
    name: 'E2E exports',
    customer: 'E2E',
    crs: { epsg: 32639 },
    origin: [500000, 3200000, 0],
    captures: [{ id: 'c1', label: 'Survey', date: '2026-01-01' }],
    layers: [
      {
        kind: 'mesh',
        id: 'quad',
        name: 'Unit quad',
        src: { path: 'models/quad.glb' },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
      {
        kind: 'photos',
        id: 'photos',
        name: 'Photos',
        items: [{ id: 'p1', src: { path: 'photos/p1.png' } }],
      },
    ],
    severityModels: [
      {
        id: 'sev',
        name: 'Severity',
        levels: [
          { value: 1, label: 'Minor', color: '#fad34b', criteria: 'Monitor' },
          { value: 3, label: 'Severe', color: '#ee3f4b', criteria: 'Act' },
        ],
      },
    ],
    classCatalogues: [
      {
        id: 'cat',
        name: 'Classes',
        assetType: 'facade',
        classes: [{ id: 'crack', label: 'Crack', color: '#ee3f4b', severityModel: 'sev' }],
      },
    ],
  });
  const issue = (code: string, severity: number): Issue => ({
    id: code.toLowerCase(),
    code,
    classId: 'crack',
    severityModelId: 'sev',
    severity,
    status: 'approved',
    title: `Crack ${code}`,
    note: 'Hairline crack\nLocation: 2.0 m above datum, North side, Podium.',
    author: 'E2E',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    source: 'human',
    sightings: [
      { on: 'mesh', layer: 'quad', geom: { type: 'spoint', p: [0.5, 0, -0.5], n: [0, 1, 0] } },
      {
        on: 'image',
        layer: 'photos',
        photo: 'p1',
        geom: { type: 'box', x: 20, y: 20, w: 40, h: 30 },
      },
    ],
  });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  await writeFile(join(dir, 'photos', 'p1.png'), greyPng(160, 120));
  await writeFile(join(dir, 'report', 'Delivered Report.pdf'), tinyPdf('Delivered report text'));
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [issue('F01', 3), issue('F02', 1)] }),
  );
}

/** Answer every save dialog with `<dir>/<default name>`. */
async function answerSaveDialogs(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(
    ({ dialog }, folder) => {
      dialog.showSaveDialog = (...args: unknown[]) => {
        const opts = (args.length > 1 ? args[1] : args[0]) as { defaultPath?: string };
        const name = String(opts.defaultPath).split(/[\\/]/).pop() ?? 'export';
        return Promise.resolve({ canceled: false, filePath: `${folder}/${name}` });
      };
    },
    dir.replace(/\\/g, '/'),
  );
}

test('reports open in the PDF viewer and issues export through the save dialog', async ({
  dataRoot,
  network,
}) => {
  test.setTimeout(120_000);
  await writeExportProject(dataRoot.root);
  const out = join(dataRoot.base, 'out');
  await mkdir(out, { recursive: true });
  const app = await launchApp(dataRoot);
  await network.attach(app);
  try {
    await answerSaveDialogs(app, out);
    const win = await app.firstWindow();
    await win.getByTestId('project-card').filter({ hasText: 'E2E exports' }).click();

    // The delivered PDF opens in the in-app viewer.
    await win.locator('.sb-nav .nav-item', { hasText: 'Reports' }).click();
    await expect(win.locator('.rep-file')).toHaveText(/Delivered Report/);
    await expect(win.getByTestId('pdf-page-count')).toHaveText('/ 1');
    await expect(win.locator('.pdfv-page canvas')).toHaveCount(1);
    await win.getByLabel('Search in the PDF').fill('delivered');
    await win.getByLabel('Search in the PDF').press('Enter');
    await expect(win.getByTestId('pdf-hits')).toHaveText('1 of 1 pages');

    // Exports from the Issues screen, each with a toast.
    await win.locator('.sb-nav .nav-item', { hasText: 'Issues' }).click();
    const run = async (label: RegExp) => {
      await win.getByRole('button', { name: 'Export', exact: true }).click();
      await win.getByRole('menuitem', { name: label }).click();
      const msg = win.getByTestId('export-toast-message').last();
      await expect(msg).toContainText('saved to', { timeout: 60_000 });
      await win.getByRole('button', { name: 'Dismiss' }).last().click();
    };
    await run(/Issues CSV/);
    const csv = parseCsv(await readFile(join(out, 'E2E-exports-issues.csv'), 'utf8'));
    expect(csv[0]).toEqual([...CSV_COLUMNS]);
    expect(csv.slice(1).map((r) => r[0])).toEqual(['F01', 'F02']);

    await run(/GeoJSON/);
    const fc = JSON.parse(await readFile(join(out, 'E2E-exports-issues.geojson'), 'utf8')) as {
      features: { geometry: { type: string; coordinates: number[] } }[];
    };
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]?.geometry.coordinates[0]).toBeCloseTo(51, 0);

    await run(/COCO/);
    const coco = JSON.parse(await readFile(join(out, 'E2E-exports-issues-coco.json'), 'utf8')) as {
      images: { width: number }[];
      annotations: unknown[];
    };
    expect(coco.images[0]?.width).toBe(160);
    expect(coco.annotations).toHaveLength(2);

    await run(/Masks ZIP/);
    const zip = await readFile(join(out, 'E2E-exports-masks.zip'));
    expect(zip.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');

    await run(/Issue register report/);
    const pdf = await readFile(join(out, 'E2E-exports-issue-register.pdf'));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(10_000);

    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});
