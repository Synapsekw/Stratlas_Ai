/**
 * The audit trail (M9 T1) end to end on a synthetic project: three edits of F01 by hand appear in
 * its History with their labels, survive a restart, the Audit trail filters and verifies them,
 * a letter changed in an op file is named by Verify (the app keeps working), the CSV export keeps
 * Arabic text, and the house report prints the audit head. No network at all.
 */
import { ProjectManifest, SCHEMA_VERSION, type Issue } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NetworkGuard } from './fixtures';
import { expect, launchApp, test, tinyGlb, type DataRoot } from './fixtures';
import { pdfText } from './pdf';

const PROJECT = 'e2e-audit';
const NAME = 'E2E audit (synthetic)';

async function writeProject(data: DataRoot): Promise<string> {
  const dir = join(data.root, 'projects', PROJECT);
  await mkdir(join(dir, 'models'), { recursive: true });
  const manifest = ProjectManifest.parse({
    schema: SCHEMA_VERSION,
    id: PROJECT,
    name: NAME,
    customer: 'Example Co',
    crs: { epsg: 32639 },
    origin: [500000, 3200000, 0],
    captures: [{ id: 'c1', label: 'Survey', date: '2026-10-01' }],
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
        levels: [
          { value: 1, label: 'Minor', color: '#fad34b', criteria: 'Monitor' },
          { value: 2, label: 'Moderate', color: '#ff7a2d', criteria: 'Plan repair' },
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
  const f01: Issue = {
    id: 'i_f01',
    code: 'F01',
    classId: 'crack',
    severityModelId: 'sev',
    severity: 1,
    status: 'draft',
    title: 'Crack near the flange',
    note: '',
    author: 'Rana Example',
    createdAt: '2026-10-01T06:00:00Z',
    updatedAt: '2026-10-01T06:00:00Z',
    source: 'human',
    sightings: [
      { on: 'mesh', layer: 'quad', geom: { type: 'spoint', p: [0.5, 0, -0.5], n: [0, 1, 0] } },
    ],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [f01] }),
  );
  return dir;
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

async function start(data: DataRoot, network: NetworkGuard) {
  const app = await launchApp(data);
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.getByTestId('project-card').filter({ hasText: NAME }).click();
  await expect(win.locator('.crumbs')).toContainText(NAME, { timeout: 60_000 });
  return { app, win };
}

/** The issue card of F01 with its Edit part open (History sits at its end). */
async function openF01(win: Page) {
  await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).click();
  await win.getByRole('tab', { name: /Issues/ }).click();
  const card = win.getByTestId('issue-card');
  await win.locator('.ann-list').getByText('F01').first().click();
  // F01 may already be selected: its card is on the Selection tab
  if (!(await card.isVisible())) await win.getByRole('tab', { name: 'Selection' }).click();
  await expect(card).toBeVisible();
  const edit = card.locator('details.ic-edit');
  if (!(await edit.evaluate((d) => (d as HTMLDetailsElement).open))) {
    await edit.locator('summary').click();
  }
  return card;
}

const historyLabels = (win: Page) => win.getByTestId('history-entry').allInnerTexts();

test('History, Audit trail, Verify, CSV export and the report head', async ({
  dataRoot,
  network,
}) => {
  test.setTimeout(240_000);
  const dir = await writeProject(dataRoot);
  const out = join(dataRoot.base, 'out');
  await mkdir(out, { recursive: true });

  // ---- three edits of F01: severity, note, status
  let { app, win } = await start(dataRoot, network);
  try {
    const card = await openF01(win);
    await card.getByRole('group', { name: 'Severity' }).getByRole('button', { name: '3' }).click();
    const note = card.locator('textarea.ann-input');
    await note.fill('Pitting near the weld, رنا مثال');
    await note.blur();
    await card.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect.poll(() => historyLabels(win), { timeout: 30_000 }).toHaveLength(3);
    const rows = await historyLabels(win);
    expect(rows.join('\n')).toMatch(/reviewed/i);
    expect(rows.join('\n')).toMatch(/F01/);
  } finally {
    await app.close();
  }

  // ---- after a restart the history is still there
  ({ app, win } = await start(dataRoot, network));
  try {
    await answerSaveDialogs(app, out);
    await openF01(win);
    await expect.poll(() => historyLabels(win), { timeout: 30_000 }).toHaveLength(3);

    // ---- the Audit trail: filter by F01, Verify, export CSV
    await win.locator('.sb-nav .nav-item', { hasText: 'Reports' }).click();
    await win.getByTestId('open-audit-trail').click();
    const screen = win.getByTestId('audit-screen');
    await expect(screen).toBeVisible();
    await win.getByTestId('audit-filter-record').fill('F01');
    await win.getByTestId('audit-filter-record').press('Enter');
    await expect(win.getByTestId('audit-entry')).toHaveCount(3, { timeout: 30_000 });
    await win.getByTestId('audit-verify').click();
    await expect(win.getByTestId('audit-verify-result')).toContainText(/intact/i, {
      timeout: 30_000,
    });
    await expect(win.getByTestId('audit-problem')).toHaveCount(0);

    await win.getByTestId('audit-export-csv').click();
    await expect(win.getByTestId('audit-export-result')).toContainText('Saved', {
      timeout: 30_000,
    });
    const csvName = (await readdir(out)).find((f) => f.endsWith('.csv'));
    expect(csvName).toBeTruthy();
    const csv = await readFile(join(out, csvName ?? ''), 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('رنا مثال');

    // ---- the house report prints the audit head
    const head = await win.evaluate(async (id) => {
      const r = await window.aio.invoke('journal:verify', { projectId: id });
      return r.ok ? (r.report.head?.root ?? '') : '';
    }, PROJECT);
    expect(head).toMatch(/^[a-f0-9]{64}$/);
    await win.getByRole('button', { name: 'Export project report PDF' }).click();
    await expect(win.getByTestId('export-toast-message').last()).toContainText('saved to', {
      timeout: 180_000,
    });
    const pdf = (await readdir(out)).find((f) => f.endsWith('.pdf'));
    const pages = await pdfText(join(out, pdf ?? ''), [1]);
    const all = await pdfText(
      join(out, pdf ?? ''),
      Array.from({ length: pages.count }, (_, i) => i + 1),
    );
    const text = [...all.text.values()].join(' ').replace(/\s+/g, '');
    expect(text).toContain(head);
    expect(text).toContain(`Audithead${head.slice(0, 16)}`);

    // ---- a letter changed in an op file: Verify names the line, the app still works
    const opsDir = join(dir, 'journal', 'ops');
    const [chain] = await readdir(opsDir);
    const seg = join(opsDir, chain ?? '', '000001.jsonl');
    const lines = (await readFile(seg, 'utf8')).split('\n');
    lines[0] = (lines[0] ?? '').replace('"label":"', '"label":"X');
    await writeFile(seg, lines.join('\n'));
    await win.getByTestId('open-audit-trail').click();
    await win.getByTestId('audit-verify').click();
    const problem = win.getByTestId('audit-problem').first();
    await expect(problem).toBeVisible({ timeout: 30_000 });
    await expect(problem).toContainText('000001.jsonl');
    await expect(problem).toContainText(/line 1\b/i);
    await openF01(win);
    await expect.poll(() => historyLabels(win), { timeout: 30_000 }).toHaveLength(3);

    expect(await network.outbound(), 'the app made network requests').toEqual([]);
  } finally {
    await app.close();
  }
});
