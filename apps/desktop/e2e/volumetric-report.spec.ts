/**
 * The volumetric report (spec 2026-10-25, plan Task 25) in the real app, on the synthetic quarry
 * demo: three monthly surveys prepared quietly on open, three stockpiles with materials and the
 * pit. Each pile's latest and previous m³ and tonnes are read from the Volumes tab's inventory;
 * Reports, Customer reports, Open volumetric report: the preview's ranked table and KPIs show the
 * same figures. Take pictures runs the live stage capture (progress card, then the preview's photo).
 * Export PDF prints pages A, B and C (one each for three piles) with the same figures. Export HTML
 * writes one file under 15 MB that opens in a fresh offline window (every request but `file:`,
 * `data:` and `blob:` cancelled and recorded: none is), boots its viewer, selects a pile from its
 * marker, switches to tonnes, downloads its CSV and prints the same number of pages as the PDF.
 * Off-screen, zero network, pipeline Python needed.
 */
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { openOffline } from './htmlOffline';
import { volumesView } from './island';
import { pdfText } from './pdf';
import { openDemo } from './surveyJobs';
import type { SurveyDemoProject } from './surveyFixtures';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

/**
 * The stockpiles of the quarry (survey_synth.py `quarry_site`). The inventory and the report list
 * every volume measurement, the pit's month-on-month change too (it has no material, so no tonnes).
 */
const PILES = ['Stockpile SP1', 'Stockpile SP2', 'Stockpile SP3'] as const;
/** The planned page count for three piles: A, B and C on one page each. */
const PAGES = 3;
/** The base picker's names (`base.*` in en.ts), and a survey or design side's. */
const BASE_NAMES = [
  'Triangulated toe',
  'Lowest point',
  'Best-fit plane',
  'Fixed level',
  'Average edge level',
  'Previous survey',
  'Custom',
];
const HTML_BUDGET = 15 * 1024 * 1024;

/** The first figure of a text the app shows ("1,234.5 m³", "−56.7"), signed; NaN for none. */
const figure = (text: string): number => {
  const m = /[-+−]?[\d ,]*\d(?:\.\d+)?/.exec(text.replace(/\s/g, ' '));
  return Number((m?.[0] ?? 'NaN').replace(/[ ,+]/g, '').replace('−', '-'));
};

/**
 * The report prints the app's figure to its own precision (whole units from 100, a tenth below):
 * equal to the app's within that rounding and the tenth the app shows.
 */
function same(report: number, app: number, what: string): void {
  const step = Math.abs(app) >= 100 ? 0.5 : 0.05;
  expect(
    Math.abs(report - app),
    `${what}: report ${String(report)}, app ${String(app)}`,
  ).toBeLessThanOrEqual(step + 0.051);
}

/** Text without spaces, lower case: pdfjs splits the report's runs. */
const flat = (s: string) => s.replace(/\s+/g, '').toLowerCase();

const stripOf = (win: Page): Locator => win.getByRole('region', { name: 'Survey dates chart' });

async function focusOn(win: Page, capture: string): Promise<void> {
  const marker = stripOf(win).locator(`[data-survey="${capture}"]`);
  await marker.click();
  await expect(marker).toHaveAttribute('aria-current', 'date');
}

/** Open the quarry in the Volumes tab and wait for every survey's figures. */
async function opened(win: Page, p: SurveyDemoProject): Promise<Locator> {
  await openDemo(win, p.name, p.id);
  const view = await volumesView(win);
  await expect(stripOf(win).locator('[data-survey][data-state="ready"]')).toHaveCount(3, {
    timeout: 360_000,
  });
  await expect(stripOf(win).locator('circle.ds-dot')).toHaveCount(3, { timeout: 240_000 });
  await expect(view.getByTestId('volumes-site-total')).toBeVisible({ timeout: 120_000 });
  return view;
}

interface Figures {
  volume: number;
  tonnes: number;
}

/** Each pile's volume and tonnes in the inventory, for the date in focus. */
async function inventoryOf(view: Locator): Promise<Record<string, Figures>> {
  const rows = await view
    .getByTestId('volumes-inventory-table')
    .locator('tbody tr[data-testid="volumes-pile"]')
    .evaluateAll((trs) =>
      trs.map((tr) => ({
        label: tr.querySelector('th')?.textContent.trim() ?? '',
        cells: [...tr.querySelectorAll('td')].map((td) => td.textContent),
      })),
    );
  const out: Record<string, Figures> = {};
  for (const r of rows)
    out[r.label] = { volume: figure(r.cells[0] ?? ''), tonnes: figure(r.cells[1] ?? '') };
  return out;
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

/** The local day as YYYY-MM-DD (the export names carry it). */
const today = () => {
  const d = new Date();
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Wait for the export named `name` to land in `dir`, and its saved toast. */
async function exported(win: Page, dir: string, name: string): Promise<string> {
  const msg = win.getByTestId('export-toast-message').last();
  await expect(msg).toContainText('saved to', { timeout: 300_000 });
  await expect.poll(async () => readdir(dir), { timeout: 30_000 }).toContain(name);
  await win.getByRole('button', { name: 'Dismiss' }).last().click();
  return join(dir, name);
}

test('the volumetric report shows the Volumes tab figures, prints them to PDF and exports an offline HTML file', async ({
  app,
  dataRoot,
  quarryProject,
  win,
}) => {
  test.setTimeout(900_000);
  const out = join(dataRoot.base, 'out');
  await mkdir(out, { recursive: true });
  await answerSaveDialogs(app, out);

  // ---- the app's figures: the latest survey and the one before, from the inventory
  const view = await opened(win, quarryProject);
  const header = view.getByTestId('volumes-header');
  await expect(header.getByTestId('volumes-date')).toContainText('31 Mar');
  const latest = await inventoryOf(view);
  await focusOn(win, 'm2');
  await expect(header.getByTestId('volumes-date')).toContainText('28 Feb');
  await expect.poll(async () => Object.keys(await inventoryOf(view)).length).toBeGreaterThan(0);
  const previous = await inventoryOf(view);
  await focusOn(win, 'm3');
  await expect(header.getByTestId('volumes-date')).toContainText('31 Mar');
  for (const p of PILES) {
    expect(latest[p]?.volume, `${p} latest`).toBeGreaterThan(0);
    expect(Number.isFinite(previous[p]?.volume), `${p} previous`).toBe(true);
  }

  // ---- the editor's preview: the ranked table and the KPIs
  await win.locator('.sb-nav .nav-item', { hasText: 'Reports' }).first().click();
  const block = win.getByTestId('customer-reports');
  await expect(block).toBeVisible({ timeout: 60_000 });
  await block.getByTestId('open-volumetric-report').click();
  const editor = win.getByTestId('volumetric-editor');
  await expect(editor).toBeVisible();
  const preview = editor.getByTestId('volumetric-preview');
  await expect(preview).toBeVisible({ timeout: 120_000 });
  const table = preview.locator('.vr-table').first();
  // a row per pile the inventory lists
  const listed = Object.keys(latest).sort();
  expect(listed).toEqual(expect.arrayContaining([...PILES]));
  await expect(table.locator('tbody tr')).toHaveCount(listed.length, { timeout: 120_000 });
  await expect(table.locator('thead th')).toHaveText([
    'Pile',
    'Base',
    'Previous m³',
    'Latest m³',
    'Latest t',
    'Peak height m',
    'Change m³',
  ]);
  const shown = await table.locator('tbody tr').evaluateAll((trs) =>
    trs.map((tr) => ({
      label: tr.querySelector('.vr-pile-name')?.textContent.trim() ?? '',
      cells: [...tr.querySelectorAll('td')].map((td) => td.textContent),
    })),
  );
  expect(shown.map((r) => r.label).sort()).toEqual(listed);
  // sorted by latest volume, largest first
  const latestShown = shown.map((r) => figure(r.cells[3] ?? ''));
  expect(latestShown).toEqual([...latestShown].sort((a, b) => b - a));
  let stock = 0;
  let change = 0;
  for (const r of shown) {
    const app = { now: latest[r.label], before: previous[r.label] };
    if (!app.now || !app.before) throw new Error(`no inventory row for ${r.label}`);
    // each pile's base by the base picker's name
    expect(BASE_NAMES, `${r.label} base`).toContain(r.cells[1] ?? '');
    same(figure(r.cells[2] ?? ''), app.before.volume, `${r.label} previous m³`);
    same(figure(r.cells[3] ?? ''), app.now.volume, `${r.label} latest m³`);
    if (Number.isFinite(app.now.tonnes))
      same(figure(r.cells[4] ?? ''), app.now.tonnes, `${r.label} latest t`);
    else expect(r.cells[4] ?? '', `${r.label} has no tonnes`).toBe('');
    same(figure(r.cells[6] ?? ''), app.now.volume - app.before.volume, `${r.label} change m³`);
    stock += app.now.volume;
    change += app.now.volume - app.before.volume;
  }
  const kpiStock = figure(
    await preview.locator('.vr-kpi-stock .vr-kpi-figure').first().innerText(),
  );
  expect(
    Math.abs(kpiStock - stock),
    `stock ${String(kpiStock)} against ${String(stock)}`,
  ).toBeLessThanOrEqual(1);
  const kpiChange = figure(
    await preview.locator('.vr-kpi').nth(1).locator('.vr-kpi-figure').innerText(),
  );
  expect(
    Math.abs(kpiChange - change),
    `change ${String(kpiChange)} against ${String(change)}`,
  ).toBeLessThanOrEqual(1);
  await expect(preview.locator('.vr-kpi').nth(1)).toContainText(/28 Feb/);
  // the method note states the one base every pile shares, else points at the table
  const bases = [...new Set(shown.map((r) => r.cells[1] ?? ''))];
  const [onlyBase] = bases;
  await expect(preview.locator('.vr-method').first()).toContainText(
    bases.length === 1 && onlyBase !== undefined
      ? `Base: ${onlyBase}.`
      : 'Base per pile, see table.',
  );

  // ---- Take pictures: the progress card over the stage, then the preview shows the photo
  const bar = editor.getByTestId('volumetric-pictures');
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Take pictures' }).click();
  await expect(win.getByTestId('volumetric-picture-progress')).toBeVisible({ timeout: 30_000 });
  await expect(win.getByTestId('volumetric-picture-progress')).toHaveCount(0, { timeout: 300_000 });
  await expect(bar, 'the pictures are current (no failure, nothing stale)').toHaveCount(0, {
    timeout: 60_000,
  });
  const photo = preview.locator('.vr-picture-inner img').first();
  await expect(photo).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => photo.evaluate((img: HTMLImageElement) => img.naturalWidth), {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
  // the report is open again where it was
  await expect(editor).toBeVisible();

  // ---- Export PDF: A, B and C, one page each, with the same figures
  await editor.getByRole('button', { name: 'Export PDF' }).click();
  const pdfFile = await exported(win, out, `Quarry-demo-volumetric-report-${today()}.pdf`);
  const pdf = await pdfText(
    pdfFile,
    Array.from({ length: 8 }, (_, i) => i + 1),
  );
  expect(pdf.count, 'the planned page count').toBe(PAGES);
  const page = (n: number) => flat(pdf.text.get(n) ?? '');
  expect(page(1)).toContain(flat('Volumetric report'));
  expect(page(1)).toContain(flat('Stock on hand'));
  expect(page(1)).toContain(flat('Latest m³'));
  expect(page(2)).toContain(flat('Stock inventory'));
  expect(page(2)).toContain(flat('Share of stock on hand'));
  // a change share is a plausible percentage (none from a previous volume of about zero)
  expect(page(2), 'no runaway change share on page B').not.toMatch(/[-+−]\d{4,}(\.\d+)?%/);
  expect(page(3)).toContain(flat(': what moved'));
  expect(page(3)).toContain(flat('Where the ground went up or down'));
  for (const r of shown) {
    expect(page(1), `${r.label} on page A`).toContain(flat(r.label));
    expect(page(1)).toContain(flat(r.cells[1] ?? '-'));
    expect(page(1)).toContain(flat(r.cells[3] ?? '-'));
    expect(page(1)).toContain(flat(r.cells[4] ?? '-'));
  }
  for (const p of PILES) expect(page(2), `${p} on page B`).toContain(flat(p));
  // each card names its pile's base
  for (const b of bases) expect(page(2), `base ${b} on page B`).toContain(flat(b));

  // ---- Export HTML: one file under the budget, opened offline
  await editor.getByRole('button', { name: 'Export HTML' }).click();
  const htmlFile = await exported(win, out, `Quarry-demo-volumetric-report-${today()}.html`);
  const size = (await stat(htmlFile)).size;
  expect(size, 'the HTML size budget').toBeLessThan(HTML_BUDGET);
  test.info().annotations.push({ type: 'html-size', description: `${String(size)} bytes` });

  const downloads = join(dataRoot.base, 'downloads');
  await mkdir(downloads, { recursive: true });
  const offline = await openOffline(app, htmlFile);
  try {
    const d = offline.page;
    await expect(d.locator('.vr-d-band h1')).toBeVisible({ timeout: 30_000 });
    const mapImg = d.locator('.vr-d-map img');
    await expect
      .poll(async () => mapImg.evaluate((img: HTMLImageElement) => img.naturalWidth), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    // a marker selects its pile's card
    const pile = shown[0]?.label ?? PILES[0];
    const marker = d.getByRole('button', { name: `Select ${pile}` });
    await marker.click();
    await expect(marker).toHaveAttribute('aria-pressed', 'true');
    await expect(d.locator('.vr-d-card h2')).toContainText(pile);
    // the card names the pile's base
    await expect(
      d
        .locator('.vr-d-card .vr-d-facts > div')
        .filter({ has: d.locator('dt', { hasText: 'Base' }) }),
    ).toContainText(shown[0]?.cells[1] ?? 'no base');
    // the units toggle shows tonnes
    const totalValue = d.locator('.vr-d-kpi-total .vr-d-kpi-value');
    await expect(totalValue).toContainText('m³');
    await d.getByRole('button', { name: 'Tonnes', exact: true }).click();
    await expect(d.getByRole('button', { name: 'Tonnes', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(totalValue).toContainText(' t');
    // Download CSV saves the stockpile inventory
    // (the link's Blob and name are read in the page, the click kept from the browser: under
    // Playwright the window's download never completes, Electron reports it interrupted)
    await d.evaluate(() => {
      const w = window as { __csv?: Promise<{ name: string; text: string }> };
      const make = URL.createObjectURL.bind(URL);
      let blob: Blob | null = null;
      URL.createObjectURL = (b: Blob | MediaSource) => {
        if (b instanceof Blob) blob = b;
        return make(b);
      };
      w.__csv = new Promise((resolve) => {
        HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
          const name = this.download;
          void (blob ? blob.text() : Promise.resolve('')).then((text) => {
            resolve({ name, text });
          });
        };
      });
    });
    await d.getByRole('button', { name: 'Download CSV' }).click();
    const csv = await d.evaluate(
      () =>
        (window as { __csv?: Promise<{ name: string; text: string }> }).__csv ??
        Promise.resolve({ name: '', text: '' }),
    );
    expect(csv.name).toMatch(/-stockpile-inventory\.csv$/i);
    const csvText = csv.text;
    await writeFile(join(downloads, csv.name), csvText);
    expect(csvText.split('\n')[0]).toContain('current_volume_m3');
    for (const p of PILES) expect(csvText).toContain(p);
    // the CSV's base column names each pile's base
    expect(csvText.split('\n')[0]?.split(',')).toContain('base');
    for (const b of bases) expect(csvText, `base ${b} in the CSV`).toContain(b);
    // printing the file gives the PDF's pages (the print CSS hides the viewer)
    const printed = join(out, 'printed.pdf');
    await offline.printToPdf(printed);
    expect((await pdfText(printed, [])).count, 'printed pages').toBe(pdf.count);
    // nothing reached for: no request but file, data and blob
    expect(await offline.requests(), 'requests from the offline HTML').toEqual([]);
  } finally {
    await offline.close();
  }
});
