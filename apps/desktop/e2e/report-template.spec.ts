/**
 * The report template (volumetric parity W8) in the real app, on the synthetic tiny project with a
 * polygon "Pad A" and a line "Line B": **Add to report** from the measurement card's "⋯" menu
 * writes the entry to `report/template.json`, and the house report PDF then holds that card (its
 * name and its primary value, as the card shows them); a second add says "Already in the report"
 * and adds nothing. Off-screen, zero network.
 */
import {
  isMeasurementEntry,
  isSectionEntry,
  MeasurementsFile,
  ReportTemplateFile,
} from '@aio/schema';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openProject, test } from './fixtures';
import { measureTree } from './island';
import { focusMeasure } from './measureCard';
import { pdfText } from './pdf';

/** The tiny project's origin (fixtures.ts `tinyManifest`): its 1 x 1 m quad lies E+, N+ of it. */
const E = 500000;
const N = 3200000;

const SEED = MeasurementsFile.parse({
  schema: 'aio.measurements/1',
  kitPilesConverted: [],
  measurements: [
    {
      id: 'pad-a',
      family: 'polygon',
      tool: 'area',
      label: 'Pad A',
      scope: { kind: 'site' },
      points: [
        [E + 0.1, N + 0.1, 0],
        [E + 0.5, N + 0.1, 0],
        [E + 0.5, N + 0.5, 0],
        [E + 0.1, N + 0.5, 0],
      ],
      items: [],
      results: [],
      createdAt: '2026-10-20T00:00:00Z',
    },
    {
      id: 'line-b',
      family: 'line',
      tool: 'distance',
      label: 'Line B',
      scope: { kind: 'site' },
      points: [
        [E + 0.6, N + 0.7, 0],
        [E + 0.9, N + 0.9, 0.2],
      ],
      items: [],
      results: [],
      createdAt: '2026-10-20T00:00:00Z',
    },
  ],
});

test.beforeEach(async ({ dataRoot }) => {
  await mkdir(join(dataRoot.projectDir, 'survey'), { recursive: true });
  await writeFile(
    join(dataRoot.projectDir, 'survey', 'measurements.json'),
    JSON.stringify(SEED, null, 1),
  );
});

async function openTiny(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe('e2e-tiny');
}

/** The project's report template on disk, or null while it has none. */
const templateOf = async (dir: string) =>
  readFile(join(dir, 'report', 'template.json'), 'utf8').then(
    (t) => ReportTemplateFile.parse(JSON.parse(t)),
    () => null,
  );

/** "Add to report" from the card's "⋯" menu; the toast it leaves says what happened. */
async function addFromMenu(win: Page, card: Locator): Promise<string> {
  await card.getByTestId('card-menu').click();
  const menu = win.getByTestId('card-menu-list');
  await expect(menu).toBeVisible();
  const item = menu.getByTestId('ctx-item-measure.addToReport');
  await expect(item).toHaveText(/Add to report/);
  await expect(item).toBeEnabled();
  const toasts = win.getByTestId('export-toast-message');
  const before = await toasts.count();
  await item.click();
  await expect(menu).toHaveCount(0);
  await expect(toasts).toHaveCount(before + 1);
  const said = (await toasts.last().innerText()).trim();
  await win.getByRole('button', { name: 'Dismiss' }).last().click();
  return said;
}

/** Answer every save dialog with `<dir>/<default name>`. */
async function answerSaves(app: ElectronApplication, dir: string): Promise<void> {
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

/** Text without spaces, lower case: the report spaces out its capitals and splits its runs. */
const flat = (s: string) => s.replace(/\s+/g, '').toLowerCase();

test('Add to report from the card overflow, then the house report PDF contains the card', async ({
  app,
  win,
  dataRoot,
}) => {
  test.setTimeout(180_000);
  const dir = dataRoot.projectDir;
  await openTiny(win);
  await measureTree(win);
  const card = await focusMeasure(win, 'Pad A');
  // the value and the unit as the card shows them
  const primary = card.getByTestId('card-primary');
  await expect(primary).toBeVisible();
  const value = `${await primary.locator('.mc-value').innerText()}${await primary.locator('.mc-unit').innerText()}`;
  expect(await templateOf(dir)).toBeNull();

  expect(await addFromMenu(win, card)).toContain('Added to the report');
  await expect
    .poll(async () => (await templateOf(dir))?.entries ?? null)
    .toEqual([expect.objectContaining({ kind: 'measurement', id: 'pad-a', parts: ['value'] })]);

  // the house report prints the card of the measurement the template lists
  const out = join(dataRoot.base, 'out');
  await mkdir(out, { recursive: true });
  await answerSaves(app, out);
  await win.locator('.sb-nav .nav-item', { hasText: 'Reports' }).click();
  await expect(win.getByTestId('house-report')).toBeVisible();
  await win.getByRole('button', { name: 'Export project report PDF' }).click();
  const msg = win.getByTestId('export-toast-message').last();
  await expect(msg).toContainText('saved to', { timeout: 120_000 });
  const [pdf] = (await readdir(out)).filter((f) => f.endsWith('.pdf'));
  if (!pdf) throw new Error('no report PDF');
  const doc = await pdfText(
    join(out, pdf),
    Array.from({ length: 30 }, (_, i) => i + 1),
  );
  const text = flat([...doc.text.values()].join(' '));
  expect(text).toContain(flat('Survey measurements'));
  expect(text).toContain(flat('Pad A'));
  expect(text).toContain(flat(value));
  // the printout changed: a measurement the template does not list is left out
  expect(text).not.toContain(flat('Line B'));
});

test('adding twice says Already in the report', async ({ win, dataRoot }) => {
  const dir = dataRoot.projectDir;
  await openTiny(win);
  await measureTree(win);
  const card = await focusMeasure(win, 'Pad A');
  expect(await addFromMenu(win, card)).toContain('Added to the report');
  await expect.poll(async () => (await templateOf(dir))?.entries.length ?? 0).toBe(1);
  const once = await readFile(join(dir, 'report', 'template.json'), 'utf8');

  expect(await addFromMenu(win, card)).toContain('Already in the report');
  // the template is as it was: one entry
  expect(await readFile(join(dir, 'report', 'template.json'), 'utf8')).toBe(once);

  // another measurement joins after it
  const line = await focusMeasure(win, 'Line B');
  expect(await addFromMenu(win, line)).toContain('Added to the report');
  await expect
    .poll(async () =>
      (await templateOf(dir))?.entries.map((e) =>
        isMeasurementEntry(e) ? e.id : isSectionEntry(e) ? e.section : e.kind,
      ),
    )
    .toEqual(['pad-a', 'line-b']);
});
