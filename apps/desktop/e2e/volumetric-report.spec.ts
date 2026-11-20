/**
 * The volumetric report (spec 2026-10-25, layout plan 2026-11-20) in the real app, on the
 * synthetic quarry demo: three monthly surveys prepared quietly on open, three stockpiles with
 * materials and the pit. Each pile's latest and previous m³ and tonnes are read from the Volumes
 * tab's inventory; Reports, Customer reports, Open volumetric report: the preview's ranked table
 * and KPIs show the same figures. There is no "Take pictures" step: Export PDF from a project
 * without pictures takes them itself under the progress card (a label, a count, then "Writing the
 * PDF" with Stop inert), asks where to save only after the capture, and saves three pictures per
 * pile beside the site's; every pile's 3D picture is taken on the latest date. The PDF has the
 * cover, the site overview, two piles per page and the change page, with the same figures. A
 * second export takes no pictures. Export HTML writes one file under 15 MB that opens in a fresh
 * offline window (every request but `file:`, `data:` and `blob:` cancelled and recorded: none
 * is), carries each pile's own pictures, boots its viewer, selects a pile from its marker,
 * switches to tonnes, downloads its CSV and prints the same number of pages as the PDF.
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
import {
  answerSaves,
  cardLog,
  readFrame,
  saveDialogs,
  secondsPerPicture,
  viewsDir,
  watchCard,
} from './volumetricCapture';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

/**
 * The stockpiles of the quarry (survey_synth.py `quarry_site`). The inventory and the report list
 * every volume measurement, the pit's month-on-month change too (it has no material, so no tonnes).
 */
const PILES = ['Stockpile SP1', 'Stockpile SP2', 'Stockpile SP3'] as const;
/** The survey dates of the quarry, oldest first; the report's latest date is the last. */
const DATES = ['m1', 'm2', 'm3'] as const;
const LATEST = 'm3';
/** The base picker's names (`base.*` in en.ts), and a survey or design side's. */
const BASE_NAMES = [
  'Toe surface',
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

const stripOf = (win: Page): Locator => win.getByRole('region', { name: 'Dates strip' });

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

/** The local day as YYYY-MM-DD (the export names carry it). */
const today = () => {
  const d = new Date();
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Wait for the export's saved toast and its file, named `<n>-<name>` in `dir`. */
async function exported(
  app: ElectronApplication,
  win: Page,
  dir: string,
  name: string,
): Promise<string> {
  const msg = win.getByTestId('export-toast-message').last();
  await expect(msg).toContainText(/saved to|not |could not|failed/i, { timeout: 600_000 });
  await expect(msg).toContainText('saved to');
  const saves = await saveDialogs(app);
  const file = `${String(saves.count)}-${name}`;
  expect(saves.last.endsWith(file), `the save dialog offered ${name}`).toBe(true);
  await expect.poll(async () => readdir(dir), { timeout: 30_000 }).toContain(file);
  await win.getByRole('button', { name: 'Dismiss' }).last().click();
  return join(dir, file);
}

test('the volumetric report shows the Volumes tab figures, prints them to PDF and exports an offline HTML file', async ({
  app,
  dataRoot,
  quarryProject,
  win,
}) => {
  test.setTimeout(1_500_000);
  const out = join(dataRoot.base, 'out');
  await mkdir(out, { recursive: true });
  await answerSaves(app, out);

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

  // ---- no "Take pictures" step: one quiet line with a link, and the export takes them itself
  const note = editor.getByTestId('volumetric-pictures');
  await expect(note).toContainText('Pictures are taken when you export.');
  await expect(note.getByRole('button', { name: 'Take them now' })).toBeVisible();
  await expect(editor.getByRole('button', { name: /^Take pictures/ })).toHaveCount(0);
  expect(await readFrame(quarryProject.dir), 'no pictures before the first export').toBeNull();

  // ---- Export PDF from a project with no pictures: the progress card, then the file
  await watchCard(win);
  await editor.getByRole('button', { name: 'Export PDF' }).click();
  const progress = win.getByTestId('volumetric-picture-progress');
  await expect(progress).toBeVisible({ timeout: 60_000 });
  await expect(progress).toHaveAttribute('data-phase', 'pictures');
  await expect(progress.locator('.vre-progress-count')).toHaveText(/^Picture \d+ of \d+$/, {
    timeout: 120_000,
  });
  expect((await saveDialogs(app)).count, 'no save dialog before the pictures are in').toBe(0);
  const pdfFile = await exported(app, win, out, `Quarry-demo-volumetric-report-${today()}.pdf`);
  await expect(progress).toHaveCount(0);
  // the report is open again where it was, with the pictures in the preview and no note
  await expect(editor).toBeVisible();
  await expect(note, 'the pictures are current (no failure, nothing stale)').toHaveCount(0, {
    timeout: 60_000,
  });
  const photo = preview.locator('.vr-picture-inner img').first();
  await expect(photo).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => photo.evaluate((img: HTMLImageElement) => img.naturalWidth), {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);

  // what the card showed: every picture counted with what it is of, then the writing phase
  const log = await cardLog(win);
  const total = listed.length * 3 + DATES.length * 3 + 1;
  const pictured = log.filter((c) => c.phase === 'pictures' && c.count !== '');
  expect(pictured.map((c) => c.count)).toContain(`Picture 1 of ${String(total)}`);
  expect(pictured.map((c) => c.count)).toContain(`Picture ${String(total)} of ${String(total)}`);
  for (const c of pictured)
    expect(c.what, `the card says what picture ${c.count} is of`).toMatch(
      /^(Site, \d+ \w+ 2026|Pile \d+ of \d+: .+|Cut and fill between the surveys)$/,
    );
  expect(
    pictured.map((c) => c.what),
    'the piles are pictured in report order',
  ).toContain(`Pile 1 of ${String(listed.length)}: ${shown[0]?.label ?? ''}`);
  expect(
    pictured.every((c) => !c.stopInert),
    'Stop works while pictures are taken',
  ).toBe(true);
  const writing = log.filter((c) => c.phase === 'writing');
  expect(writing.length, 'the writing phase showed').toBeGreaterThan(0);
  expect(writing.every((c) => c.what === 'Writing the PDF' && c.stopInert && c.count === '')).toBe(
    true,
  );
  const pace = secondsPerPicture(log);
  const paceText = `${String(pace.pictures)} pictures: ${String(pace.all)} s each (site ${String(pace.site)} s, pile ${String(pace.pile)} s)`;
  test.info().annotations.push({ type: 'seconds-per-picture', description: paceText });
  process.stdout.write(`[e2e] volumetric report capture, ${paceText}\n`);

  // ---- the saved pictures: the site's, and three per pile, the 3D one on the latest date
  const frame = await readFrame(quarryProject.dir);
  if (!frame) throw new Error('the export saved no frame.json');
  expect(frame.views).toHaveLength(total);
  const saved = await readdir(viewsDir(quarryProject.dir));
  for (const v of frame.views) expect(saved, v.file).toContain(v.file);
  const pile3d = frame.views.filter((v) => v.kind === 'pile-3d');
  expect(pile3d).toHaveLength(listed.length);
  expect(
    pile3d.map((v) => v.capture),
    'every 3D pile picture is of the latest date',
  ).toEqual(pile3d.map(() => LATEST));
  const pilePhotos = frame.views.filter((v) => v.kind === 'pile-photo');
  expect(pilePhotos).toHaveLength(listed.length * 2);
  expect([...new Set(pilePhotos.map((v) => v.capture))].sort()).toEqual(['m2', LATEST]);
  for (const id of new Set(pilePhotos.map((v) => v.pile))) {
    const two = pilePhotos.filter((v) => v.pile === id);
    expect(two[0]?.extent, 'both photos of a pile share one frame').toEqual(two[1]?.extent);
  }
  expect(frame.views.filter((v) => !v.kind.startsWith('pile-'))).toHaveLength(DATES.length * 3 + 1);

  // ---- the PDF: cover, site overview, two piles per page, change
  const cardPages = Math.ceil(listed.length / 2);
  const pdf = await pdfText(
    pdfFile,
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  expect(pdf.count, 'cover, overview, the pile pages, change').toBe(1 + 1 + cardPages + 1);
  const page = (n: number) => flat(pdf.text.get(n) ?? '');
  expect(page(1)).toContain(flat('Volumetric report'));
  expect(page(1)).toContain(flat('Stock on hand'));
  expect(page(1)).toContain(flat('Latest m³'));
  expect(page(2)).toContain(flat('Site overview'));
  expect(page(2)).toContain(flat('Share of stock on hand'));
  expect(page(2)).toContain(flat('Elevation, 31 March 2026'));
  expect(page(2)).toContain(flat('3D view from the south-east, 31 March 2026'));
  const cards = Array.from({ length: cardPages }, (_, i) => page(3 + i));
  cards.forEach((text, i) => {
    const from = i * 2 + 1;
    const to = Math.min(listed.length, from + 1);
    expect(text).toContain(
      flat(
        to > from
          ? `Piles ${String(from)} to ${String(to)} of ${String(listed.length)}`
          : `Pile ${String(from)} of ${String(listed.length)}`,
      ),
    );
    expect(text).toContain(flat('Elevation profile, A to B'));
    // the 3D picture is captioned with the latest survey date, for every pile
    expect(text).toContain(flat('3D view, 31 Mar'));
    // a change share is a plausible percentage (none from a previous volume of about zero)
    expect(text, 'no runaway change share on a pile page').not.toMatch(/[-+−]\d{4,}(\.\d+)?%/);
  });
  const last = page(pdf.count);
  expect(last).toContain(flat(': what moved'));
  expect(last).toContain(flat('Where the ground went up or down'));
  // the method note prints once, at the end of the report
  expect(last).toContain(flat('Surface cell size'));
  for (let n = 1; n < pdf.count; n++)
    expect(page(n), `no method note on page ${String(n)}`).not.toContain(flat('Surface cell size'));
  shown.forEach((r, k) => {
    expect(page(1), `${r.label} on page A`).toContain(flat(r.label));
    expect(page(1)).toContain(flat(r.cells[1] ?? '-'));
    expect(page(1)).toContain(flat(r.cells[3] ?? '-'));
    expect(page(1)).toContain(flat(r.cells[4] ?? '-'));
    // each pile has its card, in report order, two to a page
    expect(cards[Math.floor(k / 2)], `${r.label}'s card`).toContain(flat(r.label));
  });
  // each card names its pile's base
  for (const b of bases) expect(cards.join(''), `base ${b} on the pile pages`).toContain(flat(b));

  // ---- a second export with nothing changed takes no pictures
  const frameFile = join(viewsDir(quarryProject.dir), 'frame.json');
  const takenAt = (await stat(frameFile)).mtimeMs;
  await watchCard(win);
  await editor.getByRole('button', { name: 'Export PDF' }).click();
  const again = await exported(app, win, out, `Quarry-demo-volumetric-report-${today()}.pdf`);
  expect((await pdfText(again, [])).count).toBe(pdf.count);
  expect(
    (await cardLog(win)).filter((c) => c.phase !== 'writing'),
    'no pictures taken the second time',
  ).toEqual([]);
  expect((await stat(frameFile)).mtimeMs, 'the saved pictures are untouched').toBe(takenAt);

  // ---- Export HTML: one file under the budget, opened offline
  await editor.getByRole('button', { name: 'Export HTML' }).click();
  const htmlFile = await exported(app, win, out, `Quarry-demo-volumetric-report-${today()}.html`);
  const size = (await stat(htmlFile)).size;
  expect(size, 'the HTML size budget').toBeLessThan(HTML_BUDGET);
  test.info().annotations.push({ type: 'html-size', description: `${String(size)} bytes` });

  const downloads = join(dataRoot.base, 'downloads');
  await mkdir(downloads, { recursive: true });
  const offline = await openOffline(app, htmlFile);
  try {
    const d = offline.page;
    await expect(d.locator('.vr-d-band h1')).toBeVisible({ timeout: 30_000 });
    // the print pages: a card per pile with its three pictures drawn from the file itself
    const cardPics = d.locator('.vr-print .vr-pile .vr-pile-pic img');
    await expect(cardPics).toHaveCount(listed.length * 3);
    const drawn = await cardPics.evaluateAll((imgs) =>
      Promise.all(
        (imgs as HTMLImageElement[]).map(async (img) => {
          await img.decode().catch(() => undefined);
          return { data: img.src.startsWith('data:image/jpeg'), width: img.naturalWidth };
        }),
      ),
    );
    expect(
      drawn.every((x) => x.data && x.width > 0),
      'every pile picture is in the file',
    ).toBe(true);
    // the site pictures are filled in when the file boots
    const sitePics = d.locator('.vr-print img[data-vr-pic]');
    expect(await sitePics.count()).toBeGreaterThan(0);
    expect(
      await sitePics.evaluateAll((imgs) =>
        (imgs as HTMLImageElement[]).every((img) => img.src.startsWith('data:image/jpeg')),
      ),
    ).toBe(true);
    await expect(d.locator('.vr-print .vr-page')).toHaveCount(pdf.count);
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
    // a row of the list selects its pile too: the card and the marker follow
    const otherPile = shown[1]?.label ?? pile;
    const listRow = d.locator('.vr-d-list-row').filter({ hasText: otherPile });
    await listRow.click();
    await expect(listRow).toHaveAttribute('aria-pressed', 'true');
    await expect(d.locator('.vr-d-card h2')).toContainText(otherPile);
    await expect(d.getByRole('button', { name: `Select ${otherPile}` })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    if (otherPile !== pile) await expect(marker).toHaveAttribute('aria-pressed', 'false');

    // the Date switch: the other survey date's stock, picture and caption, and back
    const viewer = d.locator('.vr-d');
    const caption = d.locator('.vr-d-caption');
    const totalLabel = d.locator('.vr-d-kpi-total .vr-d-kpi-label');
    const totalShown = d.locator('.vr-d-kpi-total .vr-d-kpi-value');
    const cardVolume = d.locator('.vr-d-card .vr-d-facts > div').first().locator('dd');
    const dateButtons = d.getByRole('group', { name: 'Date', exact: true }).getByRole('button');
    await expect.poll(() => dateButtons.count()).toBeGreaterThan(1);
    const onDate = d
      .getByRole('group', { name: 'Date', exact: true })
      .locator('button[aria-pressed="true"]');
    await expect(onDate).toHaveCount(1);
    const dateWas = (await onDate.innerText()).trim();
    const offDate = d
      .getByRole('group', { name: 'Date', exact: true })
      .locator('button[aria-pressed="false"]')
      .first();
    const dateNext = (await offDate.innerText()).trim();
    expect(dateNext).not.toBe(dateWas);
    await expect(totalLabel).toContainText(dateWas);
    await expect(caption).toContainText(dateWas);
    const was = {
      total: await totalShown.innerText(),
      card: await cardVolume.innerText(),
      photo: await mapImg.getAttribute('src'),
    };
    const nextDate = d
      .getByRole('group', { name: 'Date', exact: true })
      .getByRole('button', { name: dateNext, exact: true });
    await nextDate.click();
    await expect(nextDate).toHaveAttribute('aria-pressed', 'true');
    await expect(onDate).toHaveCount(1);
    await expect(totalLabel).toContainText(dateNext);
    await expect(caption).toContainText(dateNext);
    await expect(totalShown).not.toHaveText(was.total);
    await expect(cardVolume).not.toHaveText(was.card);
    // that date's own picture, drawn from the file itself
    await expect(mapImg).not.toHaveAttribute('src', was.photo ?? '');
    await expect
      .poll(async () => mapImg.evaluate((img: HTMLImageElement) => img.naturalWidth), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    await d
      .getByRole('group', { name: 'Date', exact: true })
      .getByRole('button', { name: dateWas, exact: true })
      .click();
    await expect(totalShown).toHaveText(was.total);
    await expect(cardVolume).toHaveText(was.card);
    await expect(mapImg).toHaveAttribute('src', was.photo ?? '');

    // the View switch: each view draws its own picture, named in the caption; Cut & fill brings
    // its legend, 3D hides the markers; Photo puts the first picture back
    const views = d.getByRole('group', { name: 'View', exact: true });
    await expect(views.getByRole('button', { name: 'Photo', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const drawnViews = new Set<string>([was.photo ?? '']);
    for (const [name, kind] of [
      ['Cut & fill', 'cutfill'],
      ['Elevation', 'elevation'],
      ['3D', '3d'],
    ] as const) {
      await views.getByRole('button', { name, exact: true }).click();
      await expect(views.getByRole('button', { name, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(views.locator('button[aria-pressed="true"]')).toHaveCount(1);
      await expect(viewer).toHaveAttribute('data-view', kind);
      await expect(caption).toContainText(name);
      await expect
        .poll(async () => mapImg.evaluate((img: HTMLImageElement) => img.naturalWidth), {
          timeout: 30_000,
        })
        .toBeGreaterThan(0);
      const src = (await mapImg.getAttribute('src')) ?? '';
      expect(drawnViews.has(src), `${name} draws a picture of its own`).toBe(false);
      drawnViews.add(src);
      await expect(d.locator('.vr-d-legend')).toBeVisible({ visible: kind === 'cutfill' });
      await expect(d.locator('.vr-d-markers')).toBeVisible({ visible: kind !== '3d' });
    }
    await views.getByRole('button', { name: 'Photo', exact: true }).click();
    await expect(viewer).toHaveAttribute('data-view', 'photo');
    await expect(mapImg).toHaveAttribute('src', was.photo ?? '');
    // the pile picked in the list is still the one on the card
    await expect(d.locator('.vr-d-card h2')).toContainText(otherPile);
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
