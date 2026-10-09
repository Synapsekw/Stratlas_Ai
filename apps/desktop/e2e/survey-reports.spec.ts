/**
 * Survey reports in the real app (M11 G9, PRD SRV-13) on the synthetic demos, off-screen with no
 * network. Quarry demo: the three monthly surveys prepared through the real `survey.prepare` job,
 * each stockpile's volume and tonnes read from the measurement panel, then **Export, Survey report
 * (PDF)** and **Stockpile inventory (CSV)**: the CSV's volumes, tonnes and totals match the panel
 * (tonnes from each pile's material) and the PDF prints the same inventory. Landfill demo: the
 * survey report shows the airspace remaining to the cap design and the compaction of each lift
 * from the weighbridge log. Skips without the pipeline Python (uv sync in python/) or the demos.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test } from './fixtures';
import { pdfText } from './pdf';
import { openDemo } from './surveyJobs';
import type { SurveyDemoProject } from './surveyFixtures';

test.use({ appEnv: PIPELINE_ENV });

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

/** Export from the Issues screen's Export menu and wait for the saved toast. */
async function runExport(win: Page, label: RegExp): Promise<void> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Issues' }).click();
  await win.getByRole('button', { name: 'Export', exact: true }).click();
  await win.getByRole('menuitem', { name: label }).click();
  const msg = win.getByTestId('export-toast-message').last();
  await expect(msg).toContainText('saved to', { timeout: 240_000 });
  await win.getByRole('button', { name: 'Dismiss' }).last().click();
}

/** A number the app shows ("1 234.5 m³", "4 342.9 t at 1.600 t/m³"): its first figure. */
const figure = (text: string): number => {
  const m = /-?[\d ,]*\d(?:\.\d+)?/.exec(text.replaceAll(String.fromCharCode(0xa0), ' '));
  return Number((m?.[0] ?? 'NaN').replace(/[ ,]/g, ''));
};

/** Text without spaces, lower case: pdfjs splits the report's runs, headings are capitals. */
const flat = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** Open the measurement list and focus a measurement by its label. */
async function focus(win: Page, label: string): Promise<void> {
  const list = win.getByTestId('survey-list');
  if (!(await list.isVisible())) {
    await win.getByRole('button', { name: 'Survey measurements' }).click();
    await win.getByTestId('survey-list-open').click();
  }
  await win.getByTestId('survey-item').filter({ hasText: label }).locator('.sv-item-main').click();
  await expect(win.getByTestId('survey-label')).toHaveValue(label);
}

/** Prepare every survey's DSM through the panel (the real `survey.prepare` job). */
async function prepare(win: Page, label: string): Promise<void> {
  await focus(win, label);
  const panel = win.getByTestId('survey-panel');
  await panel.getByTestId('survey-prepare').click();
  await expect(panel.getByTestId('survey-prepare')).toHaveCount(0, { timeout: 240_000 });
}

/** The pile's net volume and tonnes as the panel shows them (first item, the calculator). */
async function panelPile(win: Page, label: string): Promise<{ volume: string; tonnes: string }> {
  await focus(win, label);
  const panel = win.getByTestId('survey-panel');
  const result = panel.getByTestId('survey-cmp-item').first().getByTestId('survey-cmp-result');
  await expect(result).toBeVisible({ timeout: 120_000 });
  await expect(panel.getByTestId('survey-recompute')).toHaveText('Recompute', { timeout: 120_000 });
  const volume = (await result.locator('tr[data-key="net"] td').first().innerText()).trim();
  const tonnes = (await panel.getByTestId('survey-calc-tonnes').innerText()).trim();
  return { volume, tonnes };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(String.fromCharCode(0xfeff), '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? '';
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) rows.push([...row, cell]);
  return rows;
}

const PILES = [
  { id: 'sp1', label: 'Stockpile SP1', density: 1.6 },
  { id: 'sp2', label: 'Stockpile SP2', density: 1.5 },
  { id: 'sp3', label: 'Stockpile SP3', density: 2.1 },
];

interface QuarryTruth {
  stockpiles: Record<string, { dates: Record<string, { volumeM3: number; tonnes: number }> }>;
}

test('quarry: the stockpile report PDF and inventory CSV match the panel', async ({
  app,
  dataRoot,
  quarryProject,
  win,
}) => {
  test.skip(!hasPipelinePython(), 'needs the development pipeline Python (uv sync in python/)');
  test.setTimeout(600_000);
  const p: SurveyDemoProject = quarryProject;
  const out = join(dataRoot.base, 'out');
  await mkdir(out, { recursive: true });
  await answerSaveDialogs(app, out);
  await openDemo(win, p.name, p.id);
  await prepare(win, PILES[0]?.label ?? '');

  // the panel: each pile's volume (net on its smart base) and tonnes from its material
  const shown: Record<string, { volume: string; tonnes: string }> = {};
  for (const pile of PILES) shown[pile.id] = await panelPile(win, pile.label);

  await runExport(win, /Stockpile inventory \(CSV\)/);
  const csv = parseCsv(await readFile(join(out, 'Quarry-demo-stockpile-inventory.csv'), 'utf8'));
  const head = csv[0] ?? [];
  const col = (name: string) => head.indexOf(name);
  expect(col('2026-01-31_volume_m3')).toBeGreaterThan(0);
  expect(col('2026-03-31_volume_m3')).toBeGreaterThan(0);
  const truth = p.truth as unknown as QuarryTruth;
  let volumes = 0;
  let tonnes = 0;
  for (const pile of PILES) {
    const r = csv.find((x) => x[0] === 'pile' && x[1] === `m-${pile.id}`);
    if (!r) throw new Error(`no row for ${pile.id}`);
    const v = Number(r[col('current_volume_m3')]);
    const t = Number(r[col('current_tonnes')]);
    // the panel's numbers, to its precision
    expect(Math.abs(v - figure(shown[pile.id]?.volume ?? ''))).toBeLessThanOrEqual(0.05);
    expect(Math.abs(t - figure(shown[pile.id]?.tonnes ?? ''))).toBeLessThanOrEqual(0.05);
    // tonnes use each pile's own material
    expect(Number(r[col('density_t_m3')])).toBe(pile.density);
    expect(t).toBeCloseTo(v * pile.density, 6);
    // and the volume is the analytic one (quick grid, 1 m cells)
    const want = truth.stockpiles[pile.id]?.dates.m3?.volumeM3 ?? 0;
    expect(Math.abs(v - want) / want).toBeLessThan(0.02);
    volumes += v;
    tonnes += t;
  }
  const total = csv.find((x) => x[0] === 'total');
  expect(Number(total?.[col('current_volume_m3')])).toBeCloseTo(volumes, 6);
  expect(Number(total?.[col('current_tonnes')])).toBeCloseTo(tonnes, 6);
  // the materials summary: one total row per material
  expect(csv.filter((x) => x[0] === 'material').map((x) => x[4])).toEqual([
    'Crushed rock 20 mm',
    'Washed sand',
    'Base course',
  ]);

  await runExport(win, /Survey report \(PDF\)/);
  const pdf = await pdfText(
    join(out, 'Quarry-demo-survey-report.pdf'),
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  const text = flat([...pdf.text.values()].join(' '));
  expect(text).toContain(flat('Survey report'));
  expect(text).toContain(flat('Stockpile inventory'));
  expect(text).toContain(flat('Survey measurements'));
  expect(text).toContain(flat('Coordinates in EPSG:32639'));
  expect(text).toContain(flat('Materials summary'));
  for (const pile of PILES) {
    expect(text).toContain(flat(shown[pile.id]?.volume ?? '-'));
    expect(text).toContain(flat((shown[pile.id]?.tonnes ?? '-').split(' at ')[0] ?? '-'));
  }
});

interface LandfillTruth {
  cell: { remainingM3: number; lifts: { lift: number; volumeM3: number; tonnes: number }[] };
}

test('landfill: the survey report shows airspace remaining and compaction per lift', async ({
  app,
  dataRoot,
  landfillProject,
  win,
}) => {
  test.skip(!hasPipelinePython(), 'needs the development pipeline Python (uv sync in python/)');
  test.setTimeout(600_000);
  const p: SurveyDemoProject = landfillProject;
  const out = join(dataRoot.base, 'out');
  await mkdir(out, { recursive: true });
  await answerSaveDialogs(app, out);
  await openDemo(win, p.name, p.id);
  await prepare(win, 'Cell 1');

  await runExport(win, /Survey report \(PDF\)/);
  const pdf = await pdfText(
    join(out, 'Landfill-demo-survey-report.pdf'),
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  const text = flat([...pdf.text.values()].join(' '));
  expect(text).toContain(flat('Landfill airspace and compaction'));
  const truth = (p.truth as unknown as LandfillTruth).cell;
  // airspace remaining to the final cap design, as the analytic cell has it
  const air = /airspaceremaining:([\d.,]+)m³/.exec(text);
  expect(air, 'the airspace line').not.toBeNull();
  const remaining = figure(air?.[1] ?? '');
  expect(Math.abs(remaining - truth.remainingM3) / truth.remainingM3).toBeLessThan(0.02);
  // compaction per lift: the weighbridge tonnes over the lift (0.90 and 0.95 t/m³ by design)
  const densities = [...text.matchAll(/(\d\.\d{3})t\/m³/g)].map((m) => Number(m[1]));
  for (const lift of truth.lifts.slice(1)) {
    const want = lift.tonnes / lift.volumeM3;
    expect(
      densities.some((d) => Math.abs(d - want) < 0.01),
      `compaction of lift ${String(lift.lift)} (${want.toFixed(3)} t/m³) in ${densities.join(', ')}`,
    ).toBe(true);
  }
  expect(text).toContain(flat('Weighbridge'));
});
