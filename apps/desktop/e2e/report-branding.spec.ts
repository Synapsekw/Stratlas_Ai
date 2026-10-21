/**
 * Generated reports carry the person's own branding, never the project's client brand: the
 * issue register PDF is neutral by default (no logo, a "Made with" credit) even when the
 * manifest names a client brand, and uses the company name and logo set in Settings, Report
 * branding. The logo is copied into the profile, never into the project.
 */
import { ProjectManifest, SCHEMA_VERSION, type Issue } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { expect, launchApp, test, tinyGlb } from './fixtures';
import { pdfPages } from './pdf';

const PROJECT = 'e2e-branding';

/** A small solid-colour RGB PNG (the logo). */
function solidPng(width: number, height: number): Buffer {
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
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) raw.set([0x22, 0x66, 0xaa], row + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function writeProject(dataRoot: string): Promise<string> {
  const dir = join(dataRoot, 'projects', PROJECT);
  await mkdir(join(dir, 'models'), { recursive: true });
  const manifest = ProjectManifest.parse({
    schema: SCHEMA_VERSION,
    id: PROJECT,
    name: 'E2E branding',
    customer: 'Client Co',
    crs: { epsg: 32639 },
    origin: [500000, 3200000, 0],
    captures: [{ id: 'c1', label: 'Survey', date: '2026-01-01' }],
    // A client brand imported with the project: reports must ignore it.
    brand: 'eand',
    layers: [
      {
        kind: 'mesh',
        id: 'quad',
        name: 'Unit quad',
        src: { path: 'models/quad.glb' },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
    ],
    severityModels: [
      {
        id: 'sev',
        name: 'Severity',
        levels: [{ value: 3, label: 'Severe', color: '#ee3f4b', criteria: 'Act' }],
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
  const issue: Issue = {
    id: 'f01',
    code: 'F01',
    classId: 'crack',
    severityModelId: 'sev',
    severity: 3,
    status: 'approved',
    title: 'Crack F01',
    note: '',
    author: 'E2E',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    source: 'human',
    sightings: [
      { on: 'mesh', layer: 'quad', geom: { type: 'spoint', p: [0.5, 0, -0.5], n: [0, 1, 0] } },
    ],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [issue] }),
  );
  return dir;
}

/** Answer save dialogs with `<dir>/<name>` and open dialogs with `pick`. */
async function answerDialogs(app: ElectronApplication, dir: string, pick: string): Promise<void> {
  await app.evaluate(
    ({ dialog }, { folder, file }) => {
      dialog.showSaveDialog = (...args: unknown[]) => {
        const opts = (args.length > 1 ? args[1] : args[0]) as { defaultPath?: string };
        const name = String(opts.defaultPath).split(/[\\/]/).pop() ?? 'export';
        return Promise.resolve({ canceled: false, filePath: `${folder}/${name}` });
      };
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] });
    },
    { folder: dir.replace(/\\/g, '/'), file: pick.replace(/\\/g, '/') },
  );
}

async function exportRegister(win: Page): Promise<void> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Reports' }).click();
  await win.getByRole('button', { name: 'Export issue register PDF' }).click();
  const msg = win.getByTestId('export-toast-message').last();
  await expect(msg).toContainText('saved to', { timeout: 90_000 });
  await win.getByRole('button', { name: 'Dismiss' }).last().click();
}

test('the issue register is neutral by default and carries the branding set in Settings', async ({
  dataRoot,
  network,
}) => {
  test.setTimeout(180_000);
  const projectDir = await writeProject(dataRoot.root);
  const out = join(dataRoot.base, 'out');
  await mkdir(out, { recursive: true });
  const logo = join(dataRoot.base, 'my-logo.png');
  await writeFile(logo, solidPng(240, 80));
  const pdf = join(out, 'E2E-branding-issue-register.pdf');

  const app = await launchApp(dataRoot);
  await network.attach(app);
  try {
    await answerDialogs(app, out, logo);
    const win = await app.firstWindow();
    await win.getByTestId('project-card').filter({ hasText: 'E2E branding' }).click();

    // Neutral: no logo on the cover, no client brand, a small credit in the footer.
    await exportRegister(win);
    const [neutral] = await pdfPages(pdf);
    expect(neutral?.images).toBe(0);
    expect(neutral?.text).toContain('E2E branding');
    expect(neutral?.text).toContain('Made with Quadrion AI');
    expect(neutral?.text).not.toMatch(/eand|e&/i);

    // The person's own branding.
    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win.getByRole('button', { name: 'Report branding' }).click();
    const company = win.getByLabel('Company name');
    await company.fill('Synapse Solutions');
    await company.press('Enter');
    await win.getByRole('button', { name: 'Choose logo' }).click();
    await expect(win.getByTestId('branding-logo').locator('img')).toBeVisible();
    await expect(win.getByRole('button', { name: 'Remove logo' })).toBeVisible();
    const copied = await readdir(join(dataRoot.userData, 'branding'));
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatch(/^logo-[a-z0-9]+\.png$/);
    expect(existsSync(join(projectDir, 'branding'))).toBe(false);
    expect((await readdir(projectDir)).sort()).toEqual(['issues.json', 'manifest.json', 'models']);

    await exportRegister(win);
    const [branded] = await pdfPages(pdf);
    expect(branded?.images).toBe(1);
    expect(branded?.text).toContain('Synapse Solutions');
    expect(branded?.text).not.toContain('Made with');
    expect(branded?.text).not.toMatch(/eand|e&/i);

    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});
