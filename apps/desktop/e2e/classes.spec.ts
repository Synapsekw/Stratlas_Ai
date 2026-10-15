/**
 * Classes on the fly and Accept all (ANN-7), end to end on a synthetic project: two small photos,
 * one severity model, classes Crack and Corrosion, two Corrosion issues and four waiting detections
 * from a local model, one of them with a word the project has no class for.
 *
 * Covers: Create class from an unknown detection word; "+ New class..." in the inspector's class
 * picker; Accept all on the filtered list (confirmed with the Enter key, header buttons off while
 * the question is open) and its one-step undo with Ctrl+Z; rename in Settings, Classes; deleting a
 * used class while moving its issues, and Ctrl+Z bringing it back; saving a class to the library
 * and ticking it in the new-project wizard.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  createDataRoot,
  expect,
  launchApp,
  NetworkGuard,
  test,
  tinyGlb,
  type DataRoot,
} from './fixtures';

const ID = 'e2e-classes';
const W = 64;
const H = 48;

function png(width: number, height: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = (table[(c ^ x) & 0xff] ?? 0) ^ (c >>> 8);
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

const NOW = '2026-10-15T08:00:00Z';

async function writeClassesProject(c: DataRoot): Promise<string> {
  const dir = join(c.root, 'projects', ID);
  await mkdir(join(dir, 'models'), { recursive: true });
  await mkdir(join(dir, 'photos'), { recursive: true });
  await mkdir(join(dir, 'detections'), { recursive: true });
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  await writeFile(join(dir, 'photos', 'p1.png'), png(W, H));
  await writeFile(join(dir, 'photos', 'p2.png'), png(W, H));
  const manifest = {
    schema: 'aio.project/1',
    id: ID,
    name: 'E2E classes',
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
        items: [
          { id: 'p1', src: { path: 'photos/p1.png' } },
          { id: 'p2', src: { path: 'photos/p2.png' } },
        ],
      },
    ],
    severityModels: [
      {
        id: 'sev',
        name: 'Severity',
        levels: [
          { value: 1, label: 'Minor', color: '#78b3d6', criteria: 'Monitor' },
          { value: 2, label: 'Moderate', color: '#ebc751', criteria: 'Plan' },
          { value: 3, label: 'Severe', color: '#f05653', criteria: 'Act' },
        ],
      },
    ],
    classCatalogues: [
      {
        id: 'cat',
        name: 'Classes',
        assetType: 'asset',
        classes: [
          { id: 'crack', label: 'Crack', color: '#e5484d', hotkey: 'c', severityModel: 'sev' },
          { id: 'corrosion', label: 'Corrosion', color: '#f08a3e', severityModel: 'sev' },
        ],
      },
    ],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const issue = (id: string, code: string) => ({
    id,
    code,
    classId: 'corrosion',
    severityModelId: 'sev',
    severity: 2,
    status: 'draft',
    title: `Corrosion ${code}`,
    note: '',
    author: 'E2E',
    createdAt: NOW,
    updatedAt: NOW,
    source: 'human',
    sightings: [
      { on: 'image', layer: 'photos', photo: 'p1', geom: { type: 'box', x: 2, y: 2, w: 6, h: 6 } },
    ],
  });
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify(
      { schema: 'aio.issues/1', issues: [issue('i1', 'F01'), issue('i2', 'F02')] },
      null,
      2,
    ),
  );
  const det = (id: string, photo: string, cls: string, severity: number, bbox: number[]) => ({
    id,
    photo,
    class: cls,
    severity,
    confidence: 0.9,
    status: 'draft',
    space: 'source',
    width: W,
    height: H,
    bbox,
  });
  await writeFile(
    join(dir, 'detections', 'model-e2e.json'),
    JSON.stringify(
      {
        schema: 'aio.detections/1',
        source: 'model',
        producer: 'e2e-detector',
        createdAt: NOW,
        detections: [
          det('d1', 'p1', 'crack', 2, [5, 5, 15, 15]),
          det('d2', 'p1', 'crack', 3, [30, 25, 40, 35]),
          det('d3', 'p2', 'spalling', 2, [5, 5, 15, 15]),
          det('d4', 'p2', 'crack', 1, [30, 25, 40, 35]),
        ],
      },
      null,
      2,
    ),
  );
  return dir;
}

interface ManifestClasses {
  classCatalogues?: { classes: { id: string; label: string }[] }[];
}
const readManifest = async (dir: string) =>
  JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as ManifestClasses;
const classesOf = async (dir: string) =>
  ((await readManifest(dir)).classCatalogues ?? []).flatMap((c) => c.classes);
const classIds = async (dir: string) => (await classesOf(dir)).map((k) => k.id);
const issuesOnDisk = async (dir: string) =>
  (
    JSON.parse(await readFile(join(dir, 'issues.json'), 'utf8')) as {
      issues: { classId: string; code?: string }[];
    }
  ).issues;

const issueCount = (win: Page) =>
  win.evaluate(
    () =>
      (
        window as unknown as { __stratlas: { workspace: { getState(): { issues: unknown[] } } } }
      ).__stratlas.workspace.getState().issues.length,
  );

async function finish(app: ElectronApplication, network: NetworkGuard) {
  const outbound = await network.outbound();
  await app.close();
  expect(outbound, 'the app made network requests').toEqual([]);
}

test('classes on the fly, Accept all with one undo, rename, delete-and-move, library in the wizard', async () => {
  test.setTimeout(240_000);
  const c = await createDataRoot();
  const dir = await writeClassesProject(c);
  const app = await launchApp(c);
  const network = new NetworkGuard();
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.getByTestId('project-card').filter({ hasText: 'E2E classes' }).click();
    await expect(win.locator('.crumbs')).toContainText('E2E classes');
    await win.locator('.nav-item', { hasText: 'Detections' }).click();
    await expect(win.getByTestId('det-counts')).toContainText('4 waiting');

    // Step to the detection whose word has no class (review order: p1 then p2, top-left first).
    const inspector = win.getByTestId('det-inspector');
    await win.locator('.det-screen').focus();
    await win.keyboard.press('j');
    await win.keyboard.press('j');
    await expect(inspector.getByTestId('det-unknown-class')).toContainText('spalling');

    // 1. Create class from an unknown detection.
    await inspector.getByTestId('det-create-class').click();
    await expect(inspector.getByTestId('det-class')).toHaveValue('spalling');
    await expect(win.getByTestId('class-notice')).toContainText('Class spalling created.');
    await expect.poll(() => classIds(dir)).toEqual(['crack', 'corrosion', 'spalling']);

    // 2. "+ New class..." in the inspector's class picker.
    await win.locator('.det-screen').focus();
    await win.keyboard.press('j');
    await inspector.getByTestId('det-class').selectOption({ label: '+ New class...' });
    const field = inspector.getByTestId('det-new-class').getByRole('textbox');
    await field.fill('Hairline crack');
    await field.press('Enter');
    await expect(inspector.getByTestId('det-class')).toHaveValue('hairline-crack');
    await expect.poll(() => classIds(dir)).toContain('hairline-crack');

    // 3. Accept all on the filtered list, confirmed with the Enter key, then one Ctrl+Z.
    const acceptAll = win.getByTestId('det-accept-all');
    const rejectAll = win.getByTestId('det-reject-all');
    await expect(acceptAll).toHaveText('Accept all (4)');
    await acceptAll.click();
    const confirm = win.getByTestId('det-batch-confirm');
    await expect(confirm).toContainText('Accept 4 detections as issues?');
    await expect(acceptAll).toBeDisabled();
    await expect(rejectAll).toBeDisabled();
    await expect(win.getByTestId('det-batch-ok')).toBeFocused();
    await win.keyboard.press('Enter');
    await expect(confirm).toHaveCount(0);
    await expect(win.getByTestId('det-counts')).toContainText('0 waiting');
    await expect(win.getByTestId('det-counts')).toContainText('4 accepted');
    expect(await issueCount(win)).toBe(6);
    // codes continue the sequence without repeats
    await expect
      .poll(async () => (await issuesOnDisk(dir)).map((i) => i.code).sort())
      .toEqual(['F01', 'F02', 'F03', 'F04', 'F05', 'F06']);
    await win.locator('.det-screen').focus();
    await win.keyboard.press('Control+z');
    await expect(win.getByTestId('det-counts')).toContainText('4 waiting');
    await expect(win.getByTestId('det-counts')).toContainText('0 accepted');
    expect(await issueCount(win)).toBe(2);
    await expect.poll(async () => (await issuesOnDisk(dir)).length).toBe(2);

    // 4. Rename in Settings, Classes.
    await win.locator('.sb-foot .nav-item', { hasText: 'Settings' }).click();
    await win.getByRole('button', { name: 'Classes', exact: true }).click();
    const panel = win.getByTestId('classes-panel');
    await expect(panel).toBeVisible();
    const name = panel.getByLabel('Name of spalling');
    await name.fill('Spalling');
    await name.press('Enter');
    await expect
      .poll(async () => (await classesOf(dir)).find((k) => k.id === 'spalling')?.label)
      .toBe('Spalling');

    // 5. Delete a used class, moving its issues; Ctrl+Z brings both back.
    await panel.getByTestId('classes-delete-corrosion').click();
    const dialog = win.getByTestId('classes-delete-dialog');
    await expect(dialog).toContainText('2 issues and 0 detections use Corrosion. Move them to:');
    await dialog.getByTestId('classes-move-to').selectOption({ label: 'Crack' });
    await dialog.getByTestId('classes-move-delete').click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => classIds(dir)).not.toContain('corrosion');
    await expect
      .poll(async () => (await issuesOnDisk(dir)).map((i) => i.classId))
      .toEqual(['crack', 'crack']);
    await panel.focus();
    await win.keyboard.press('Control+z');
    await expect.poll(() => classIds(dir)).toContain('corrosion');
    await expect
      .poll(async () => (await issuesOnDisk(dir)).map((i) => i.classId))
      .toEqual(['corrosion', 'corrosion']);

    // A class with a waiting detection counts it in the delete question.
    await panel.getByTestId('classes-delete-spalling').click();
    await expect(dialog).toContainText('0 issues and 1 detection use Spalling. Move them to:');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);

    // 6. Save a class to the library, then tick it in the new-project wizard.
    await panel.getByTestId('classes-save-hairline-crack').click();
    await expect(win.getByTestId('class-notice')).toContainText(
      'Hairline crack saved to your class library.',
    );
    await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).first().click();
    await win.getByTestId('new-project').first().click();
    const wiz = win.getByTestId('new-project-wizard');
    await wiz.getByLabel('Project name').fill('Library classes e2e');
    await wiz.getByRole('button', { name: 'Next' }).click();
    await wiz.getByRole('button', { name: 'Typed coordinate' }).click();
    await wiz.getByLabel('Origin coordinate').fill('29.0276, 48.1352, 30');
    await wiz.getByRole('button', { name: 'Next' }).click();
    const library = wiz.getByTestId('wizard-library');
    await expect(library).toBeVisible();
    await library.getByRole('checkbox', { name: 'Hairline crack' }).check();
    await wiz.getByRole('button', { name: 'Next' }).click();
    await wiz.getByRole('button', { name: 'Create project' }).click();
    await expect(win.getByTestId('empty-project')).toBeVisible({ timeout: 30_000 });
    const created = join(c.root, 'projects', 'library-classes-e2e');
    await expect
      .poll(async () => (await classesOf(created)).map((k) => k.label))
      .toContain('Hairline crack');
  } finally {
    await finish(app, network);
    await rm(c.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
