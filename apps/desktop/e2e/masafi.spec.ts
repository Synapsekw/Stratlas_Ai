/**
 * End to end on the real two-date stockpile project, as it is on the day of the run: its piles are
 * volume measurements (hand drawn, or an older kit's piles carried over), listed in Project >
 * Volumes and opened in the right panel's Selection tab.
 *
 * Nothing about the piles is fixed here. What the Volumes inventory should list is read at run
 * time from the copied project's own files: the volume measurements of `survey/measurements.json`
 * (their ids, names and whether a figure is carried from an earlier version), whether a kit
 * `volumes.json` is still there and whether its piles are marked converted (`kitPilesConverted`).
 *
 * - The inventory lists every pile (the folded groups counted through "+ N more", then opened); a
 *   row opens the pile in Selection with a volume, the survey dates in History and its status; in
 *   3D the opened pile is drawn in its pile look, Esc lets it go and its outline is back, and a
 *   click on a pile on the terrain opens it.
 * - The header's Export writes volume over time as CSV, naming every pile; the real data stays as
 *   it was.
 * - The figures the app shows are recorded (a JSON attachment and the log): per pile and survey
 *   date the volume, the pile's base, and the site total per date. With a reference file
 *   (QUADRION_E2E_VOLUME_REFERENCE, a CSV `pile,date,volume_m3`, see `volumeReference.ts`) they are
 *   compared: each pile within 5 %, each total within 1 %; a pile the reference names and the app
 *   has no figure for fails, and a figure carried from an earlier version is not compared.
 *
 * Runs only where the real data holds the project (realData.ts); skipped elsewhere. The project is
 * copied to a temporary data root (@realdata), so nothing written here touches the real data.
 */
import { envVar } from '@aio/brand/env';
import { MeasurementsFile, ProjectManifest } from '@aio/schema';
import { inventoryPiles } from '@aio/survey';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  expect,
  hasPipelinePython,
  openProject,
  PIPELINE_ENV,
  realDataTest,
  reportWindow,
} from './fixtures';
import { volumesView } from './island';
import { panelTab, selectedPile } from './panel';
import { hasRealProject, missingRealProject, realProjectDir, type RealDataCopy } from './realData';
import {
  compareVolumes,
  formatComparison,
  parseReference,
  parseSeriesCsv,
  siteTotals,
  type SeriesRow,
} from './volumeReference';

const PROJECT = 'masafi';
/** The real project's folder: read only, to see that it stays as it was. */
const REAL = realProjectDir(PROJECT);

/**
 * The optional reference figures (QUADRION_E2E_VOLUME_REFERENCE): a local CSV with the header
 * `pile,date,volume_m3`, a row `TOTAL` per date for the site total. Unset: the figures are only
 * recorded.
 */
const REFERENCE = envVar(process.env, 'E2E_VOLUME_REFERENCE') ?? '';

const test = realDataTest([PROJECT], {
  // the installed street map pack that covers the yard, when this machine has it
  packs: ['kuwait'],
  // a survey whose surface is not prepared yet is prepared on open: that needs the pipeline Python
  env: hasPipelinePython() ? PIPELINE_ENV : {},
});

test.skip(!hasRealProject(PROJECT), missingRealProject(PROJECT));
// real surfaces may be prepared and every pile worked out on each date, on a software renderer
test.setTimeout(1_500_000);

/** A line in the run's log. */
const say = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

interface Pt {
  x: number;
  y: number;
}

/** A pile the inventory should list, as the project's own file has it. */
interface ExpectedPile {
  id: string;
  label: string;
  /** Its stored figure is carried from an earlier version (the kit's), not worked out here. */
  carried: boolean;
}

interface Expected {
  piles: ExpectedPile[];
  /** The kit's pile ids when the project still has a kit `volumes.json`; null without one. */
  kit: string[] | null;
  /** `kitPilesConverted` of the measurements file; null when it is not set. */
  converted: string[] | null;
}

async function readMeasurements(dir: string): Promise<MeasurementsFile | null> {
  const file = join(dir, 'survey', 'measurements.json');
  if (!existsSync(file)) return null;
  return MeasurementsFile.parse(JSON.parse(await readFile(file, 'utf8')));
}

/** The pile ids of the project's kit `volumes.json`, or null when it has none. */
async function kitPileIds(dir: string): Promise<string[] | null> {
  const file = join(dir, 'volumes.json');
  if (!existsSync(file)) return null;
  const kit = JSON.parse(await readFile(file, 'utf8')) as { piles?: { id?: unknown }[] };
  return (kit.piles ?? []).map((p) => (typeof p.id === 'string' ? p.id : '')).filter(Boolean);
}

/**
 * What the opened copy holds: its volume measurements, by the rule the Volumes tab lists them
 * (`inventoryPiles`). A kit still to be converted is converted by the app on open, so with a kit
 * this waits until every kit pile is marked converted, then reads the file the app wrote.
 */
async function expectedPiles(copy: RealDataCopy): Promise<Expected> {
  const dir = copy.projectDir;
  const kit = await kitPileIds(dir);
  if (kit && kit.length > 0)
    await expect
      .poll(
        async () => {
          const done = new Set((await readMeasurements(dir).catch(() => null))?.kitPilesConverted);
          return kit.filter((id) => !done.has(id));
        },
        { timeout: 120_000, message: 'kit piles not marked converted in the copy' },
      )
      .toEqual([]);
  const file = await readMeasurements(dir);
  const piles = inventoryPiles(file?.measurements ?? []).map((m) => ({
    id: m.id,
    label: m.label,
    carried: m.results.some((r) => r.carried !== undefined),
  }));
  const expected = { piles, kit, converted: file?.kitPilesConverted ?? null };
  say(
    `[stockpile] ${String(piles.length)} volume measurements (${String(piles.filter((p) => p.carried).length)} with a carried figure); kit volumes.json: ${kit ? `yes, ${String(kit.length)} piles` : 'no'}; kitPilesConverted: ${expected.converted ? `set, ${String(expected.converted.length)}` : 'not set'}`,
  );
  expect(piles.length, 'the project holds no volume measurement to list').toBeGreaterThan(0);
  return expected;
}

/** The project's saved kit boundary edits as text, or null when there are none. */
function boundariesOf(project: string): string | null {
  const f = join(project, 'edits', 'boundaries.json');
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}

/** The project's measurements file as text, or null when there is none. */
function measurementsOf(project: string): string | null {
  const f = join(project, 'survey', 'measurements.json');
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}

const stripOf = (win: Page): Locator => win.getByRole('region', { name: 'Dates strip' });

/** Open the copied project (by the name in its own manifest) and wait for its scene. */
async function openSite(win: Page, copy: RealDataCopy): Promise<void> {
  await reportWindow(win);
  const manifest = ProjectManifest.parse(
    JSON.parse(await readFile(join(copy.projectDir, 'manifest.json'), 'utf8')),
  );
  await win.getByTestId('project-card').filter({ hasText: manifest.name }).first().click();
  // the scene canvas first: the 3D view's tools and the piles' labels come with it
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => (await openProject(win)).id, { timeout: 60_000 }).toBe(manifest.id);
}

/**
 * Project > Volumes on its Inventory, with every pile of the project listed. The groups fold to
 * their first piles: the rows held back are counted through the "+ N more" rows, then every group
 * is opened.
 */
async function inventoryOf(win: Page, expected: Expected): Promise<Locator> {
  const view = await volumesView(win);
  const rows = view.getByTestId('volumes-pile');
  await expect(rows).toHaveCount(expected.piles.length, { timeout: 120_000 });
  const more = view.getByTestId('volumes-more');
  const held = await rows.evaluateAll(
    (trs) => trs.filter((tr) => (tr as HTMLElement).hidden).length,
  );
  const promised = (await more.allInnerTexts())
    .map((t) => Number(/\d+/.exec(t)?.[0] ?? 'NaN'))
    .reduce((a, b) => a + b, 0);
  expect(promised, 'the "+ N more" rows count the piles held back').toBe(held);
  for (let n = await more.count(); n > 0; n = await more.count()) {
    await more.first().click();
    await expect(more).toHaveCount(n - 1);
  }
  expect(
    await rows.evaluateAll((trs) => trs.filter((tr) => (tr as HTMLElement).hidden).length),
  ).toBe(0);
  // every pile of the file, by id and by name, and no other
  expect(
    (await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-id') ?? ''))).sort(),
  ).toEqual(expected.piles.map((p) => p.id).sort());
  for (const p of expected.piles)
    await expect(view.locator(`[data-testid="volumes-pile"][data-id="${p.id}"]`)).toContainText(
      p.label,
    );
  return view;
}

/** An inventory row by the pile's id. */
const pileRow = (view: Locator, id: string): Locator =>
  view.locator(`[data-testid="volumes-pile"][data-id="${id}"]`);

/** The first figure of a text the app shows ("1 234.5 m³", "−56.7"), signed; NaN for "-". */
const figure = (text: string): number => {
  const m = /[-+−]?[\d ,]*\d(?:\.\d+)?/.exec(text.replace(/\s/g, ' '));
  return Number((m?.[0] ?? 'NaN').replace(/[ ,+]/g, '').replace('−', '-'));
};

/**
 * The page point of a measurement's label anchor in the 3D view (a closed shape's centroid): the
 * label's own translate, read off its layer.
 */
async function labelAnchor3d(win: Page, id: string): Promise<Pt> {
  const label = win.locator(`[data-scene-view] .sv-labels .sv-label[data-id="${id}"]`).first();
  await expect(label).toBeAttached({ timeout: 60_000 });
  await expect
    .poll(() => label.evaluate((el) => (el as HTMLElement).style.display), { timeout: 60_000 })
    .not.toBe('none');
  const at = await label.evaluate((el) => {
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec((el as HTMLElement).style.transform);
    const r = el.parentElement?.getBoundingClientRect();
    return m && r ? { x: r.left + Number(m[1]), y: r.top + Number(m[2]) } : null;
  });
  if (!at) throw new Error(`no label anchor for ${id}`);
  return at;
}

/** Wait until a measurement's label stops moving (the camera has settled); where it is then. */
async function settled(win: Page, id: string): Promise<Pt> {
  let last = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await labelAnchor3d(win, id));
        const still = now === last;
        last = now;
        return still;
      },
      { intervals: [500], timeout: 60_000 },
    )
    .toBe(true);
  return labelAnchor3d(win, id);
}

/** Whether a measurement's outline is drawn in the 3D scene. */
const outlined = (win: Page, id: string): Promise<boolean> =>
  win.evaluate((id) => {
    interface W {
      __stratlas: {
        stage(): {
          scene: { getObjectByName(n: string): { children: { name: string }[] } | undefined };
        } | null;
      };
    }
    const group = (window as unknown as W).__stratlas
      .stage()
      ?.scene.getObjectByName('aio-survey-measurements');
    return (group?.children ?? []).some((c) => c.name === `measure:${id}`);
  }, id);

/** The opened pile's look in the 3D view (its lifted box, drawn in place of its outline). */
const pileLook = (win: Page, id: string): Locator => win.locator(`[data-pile-look="${id}"]`);

/**
 * Every survey date's surface has settled: none is being prepared or still waits to be (a date
 * with nothing to prepare from stays without one), and at least one is ready.
 */
async function surfacesSettled(win: Page): Promise<void> {
  const markers = stripOf(win).locator('[data-survey]');
  await expect
    .poll(
      async () => {
        const states = await markers.evaluateAll((els) =>
          els.map((el) => el.getAttribute('data-state') ?? ''),
        );
        const waiting = states.filter((s) => s === 'preparing' || s === 'missing').length;
        return states.includes('ready') && waiting === 0;
      },
      { intervals: [2_000], timeout: 900_000, message: 'the survey surfaces are not all ready' },
    )
    .toBe(true);
}

/** Save the header's Export to `target`; returns the file's text and the name the app proposed. */
async function exportSeries(
  app: ElectronApplication,
  view: Locator,
  target: string,
): Promise<{ csv: string; proposed: string }> {
  await rm(target, { force: true });
  await app.evaluate(({ dialog }, path) => {
    const seen = globalThis as unknown as { e2eSaveDefault?: string };
    dialog.showSaveDialog = (...args: unknown[]) => {
      const options = args.at(-1) as { defaultPath?: string } | undefined;
      seen.e2eSaveDefault = options?.defaultPath ?? '';
      return Promise.resolve({ canceled: false, filePath: path });
    };
  }, target);
  await view.getByTestId('volumes-csv').click();
  await expect.poll(() => existsSync(target), { timeout: 60_000 }).toBe(true);
  // the file is written in one go; read it once its text holds still
  let csv = '';
  await expect
    .poll(
      async () => {
        const now = await readFile(target, 'utf8');
        const same = now !== '' && now === csv;
        csv = now;
        return same;
      },
      { intervals: [300], timeout: 30_000 },
    )
    .toBe(true);
  const proposed = await app.evaluate(
    () => (globalThis as unknown as { e2eSaveDefault?: string }).e2eSaveDefault ?? '',
  );
  return { csv, proposed };
}

test('@realdata the stockpile project: every pile in the inventory, a pile in Selection, its look and a click in 3D', async ({
  win,
  realData,
}) => {
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await openSite(win, realData);
  const expected = await expectedPiles(realData);
  const view = await inventoryOf(win, expected);
  await surfacesSettled(win);

  // A pile with a figure on the date in focus (the first row that is not under "Not counted").
  const counted = await view
    .getByTestId('volumes-pile')
    .evaluateAll((trs) =>
      trs
        .filter((tr) => !tr.querySelector('.vi-why'))
        .map((tr) => tr.getAttribute('data-id') ?? ''),
    );
  const first = expected.piles.find((p) => p.id === counted[0]) ?? expected.piles[0];
  if (!first) throw new Error('no pile to open');
  await pileRow(view, first.id).click();

  // It opens in Selection, never inside the Volumes list, with the way back to the inventory.
  const panel = selectedPile(win);
  await expect(panel).toHaveAttribute('data-id', first.id, { timeout: 30_000 });
  await expect(panelTab(win, 'selection')).toHaveAttribute('aria-selected', 'true');
  await expect(win.getByTestId('volumes-view').getByTestId('pile-panel')).toHaveCount(0);
  await expect(panel.getByTestId('pile-name')).toHaveText(first.label);
  await expect(panel.getByTestId('pile-back')).toHaveText('Back to inventory');
  // a volume figure
  const tile = panel.getByTestId('pile-kpi-volume').locator('b');
  await expect(tile).toBeVisible({ timeout: 600_000 });
  expect(Number.isFinite(figure(await tile.innerText()))).toBe(true);
  // its status: "From an earlier version" only when the file says the figure is carried
  const carriedLine = panel
    .getByTestId('pile-status')
    .filter({ hasText: 'From an earlier version' });
  if (first.carried) await expect(carriedLine).toHaveCount(1);
  else await expect(carriedLine).toHaveCount(0);
  await expect(panel.getByTestId('pile-overview-status')).toHaveText(/\S/);
  // History: a row per survey date with a surface, two or more, the dates as the strip has them
  const ready = await stripOf(win)
    .locator('[data-survey][data-state="ready"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-survey') ?? ''));
  expect(ready.length, 'survey dates with a surface').toBeGreaterThanOrEqual(2);
  await panel.getByTestId('pile-tab-history').click();
  const history = panel.getByTestId('pile-history-table').locator('tbody');
  await expect.poll(() => history.locator('tr').count()).toBeGreaterThanOrEqual(ready.length);
  for (const capture of ready)
    await expect(history.locator(`tr[data-capture="${capture}"]`)).toHaveCount(1);
  await panel.getByTestId('pile-tab-overview').click();

  // In 3D the opened pile is drawn in its pile look; the kit's bodies and base plates are gone.
  await expect(pileLook(win, first.id)).toHaveCount(1, { timeout: 120_000 });
  expect(
    await win.evaluate(() => {
      interface Named {
        name: string;
      }
      interface W {
        __stratlas: { stage(): { scene: { traverse(f: (o: Named) => void): void } } | null };
      }
      let n = 0;
      (window as unknown as W).__stratlas.stage()?.scene.traverse((o) => {
        if (o.name === 'body-top' || o.name === 'base-plate') n += 1;
      });
      return n;
    }),
    'kit bodies and base plates in the 3D view',
  ).toBe(0);

  // Esc lets the pile go: the panel and the look leave, its outline is drawn again.
  await panel.getByTestId('pile-tab-overview').focus();
  await win.keyboard.press('Escape');
  await expect(selectedPile(win)).toHaveCount(0);
  await expect(win.locator('[data-pile-look]')).toHaveCount(0);
  await expect.poll(() => outlined(win, first.id), { timeout: 30_000 }).toBe(true);

  // A click on a pile on the terrain (another one, when there is one) opens it in Selection.
  const other = expected.piles.find((p) => p.id !== first.id) ?? first;
  await win.locator('[data-scene-view] canvas').first().focus();
  await win.keyboard.press('h'); // the whole site
  const at = await settled(win, other.id);
  await win.mouse.click(at.x, at.y);
  await expect(selectedPile(win)).toHaveAttribute('data-id', other.id, { timeout: 30_000 });
  await expect(panelTab(win, 'selection')).toHaveAttribute('aria-selected', 'true');
  await expect(selectedPile(win).getByTestId('pile-name')).toHaveText(other.label);
  // opened on the view, it has its link to the inventory too
  await expect(selectedPile(win).getByTestId('pile-back')).toHaveText('Back to inventory');
  await expect(pileLook(win, other.id)).toHaveCount(1, { timeout: 120_000 });

  expect(errors).toEqual([]);
});

test('@realdata the stockpile project: volume over time as CSV from the Volumes header; the real data untouched', async ({
  app,
  win,
  realData,
}) => {
  const realBefore = measurementsOf(REAL);
  const boundariesBefore = boundariesOf(REAL);
  await openSite(win, realData);
  const expected = await expectedPiles(realData);
  const view = await inventoryOf(win, expected);

  // a kit still in the project is converted once in the copy and written there, never in the real
  // project (`expectedPiles` waited for it)
  for (const id of expected.kit ?? []) expect(expected.converted ?? []).toContain(id);

  const { csv, proposed } = await exportSeries(app, view, join(realData.base, 'volumes.csv'));
  // named after what it holds
  expect(basename(proposed)).toBe('Volume-over-time.csv');
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  expect(lines[0]).toContain('From an earlier version');
  // every pile is named, and nothing else: a row per pile and survey date
  const { rows } = parseSeriesCsv(csv);
  const count = (xs: readonly string[]) => {
    const by = new Map<string, number>();
    for (const x of xs) by.set(x, (by.get(x) ?? 0) + 1);
    return by;
  };
  const dates = [...new Set(rows.map((r) => r.date))];
  expect(dates.length).toBeGreaterThanOrEqual(1);
  for (const d of dates) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(rows).toHaveLength(expected.piles.length * dates.length);
  const perName = count(expected.piles.map((p) => p.label));
  expect([...count(rows.map((r) => r.pile))].sort()).toEqual(
    [...perName].map(([name, n]): [string, number] => [name, n * dates.length]).sort(),
  );

  // the real project is as it was
  expect(measurementsOf(REAL)).toBe(realBefore);
  expect(boundariesOf(REAL)).toBe(boundariesBefore);
});

test('@realdata the stockpile project: the figures per pile and survey date are recorded, and compared with a reference when one is given', async ({
  app,
  win,
  realData,
}, testInfo) => {
  await openSite(win, realData);
  const expected = await expectedPiles(realData);
  const view = await inventoryOf(win, expected);

  // The surfaces ready, then every pile worked out: none waits under "Not counted", and the
  // exported figures are the same over two exports.
  await surfacesSettled(win);
  await expect(
    view.locator('.vi-why').filter({ hasText: /not computed yet|computing/i }),
    'piles not worked out yet',
  ).toHaveCount(0, { timeout: 900_000 });
  const target = join(realData.base, 'figures.csv');
  let csv = '';
  await expect
    .poll(
      async () => {
        const now = (await exportSeries(app, view, target)).csv;
        const same = now === csv;
        csv = now;
        return same;
      },
      { intervals: [5_000], timeout: 600_000, message: 'the exported figures keep changing' },
    )
    .toBe(true);
  const series = parseSeriesCsv(csv);
  expect(series.unit, 'the site shows volumes in cubic metres (the reference is in m3)').toBe('m³');
  expect([...new Set(series.rows.map((r) => r.pile))].sort()).toEqual(
    [...new Set(expected.piles.map((p) => p.label))].sort(),
  );
  const totals = siteTotals(series.rows);

  // The site total the Inventory shows on the date in focus, as shown.
  const shown = {
    date: (await view.getByTestId('volumes-date').innerText()).trim(),
    siteTotal: (await view.getByTestId('volumes-site-total').count())
      ? figure(await view.getByTestId('volumes-site-total').locator('td').first().innerText())
      : null,
    basis: (await view.locator('.vi-cap').innerText()).replace(/\s+/g, ' ').trim(),
  };

  // Each pile's base, by the name its panel's base picker shows.
  const bases = new Map<string, string>();
  for (const p of expected.piles) {
    await pileRow(view, p.id).click();
    const panel = selectedPile(win);
    await expect(panel).toHaveAttribute('data-id', p.id, { timeout: 30_000 });
    const chip = panel.locator('.pp-base [data-base]');
    await expect(chip).toBeVisible();
    bases.set(p.id, (await chip.innerText()).replace(/^(Base|From):\s*/, '').trim());
    await panel.getByTestId('pile-back').click();
    await expect(selectedPile(win)).toHaveCount(0);
    await expect(view.getByTestId('volumes-inventory')).toBeVisible();
  }

  // The record: per pile and date the volume and the base, and the site total per date.
  const figuresOf = (label: string): SeriesRow[] => series.rows.filter((r) => r.pile === label);
  const twins = new Set(
    expected.piles.map((p) => p.label).filter((l, i, all) => all.indexOf(l) !== i),
  );
  const record = {
    recordedAt: new Date().toISOString(),
    unit: 'm3',
    dates: totals.map((t) => t.date),
    piles: expected.piles.map((p) => ({
      id: p.id,
      name: p.label,
      base: bases.get(p.id) ?? '',
      // piles that share a name share their rows in the CSV: they cannot be told apart there
      sharesName: twins.has(p.label),
      figures: figuresOf(p.label).map((r) => ({
        date: r.date,
        volume_m3: r.volume,
        status: r.status,
        fromAnEarlierVersion: r.carried,
      })),
    })),
    totals: totals.map((t) => ({ date: t.date, volume_m3: t.volume, piles: t.piles })),
    inventoryAsShown: shown,
    reference: null as null | {
      file: string;
      ok: boolean;
      rows: ReturnType<typeof compareVolumes>['rows'];
      missingInApp: ReturnType<typeof compareVolumes>['missingInOurs'];
      fromAnEarlierVersion: ReturnType<typeof compareVolumes>['carried'];
      missingInReference: ReturnType<typeof compareVolumes>['missingInReference'];
      duplicates: string[];
    },
  };
  const table = [
    ['pile', 'base', 'date', 'volume m3', 'status'].join('\t'),
    ...record.piles.flatMap((p) =>
      p.figures.map((f) =>
        [p.name, p.base, f.date, f.volume_m3 === null ? '-' : String(f.volume_m3), f.status].join(
          '\t',
        ),
      ),
    ),
    ...record.totals.map((t) =>
      ['TOTAL', '', t.date, String(t.volume_m3), `${String(t.piles)} piles`].join('\t'),
    ),
  ].join('\n');
  say(`[stockpile] the app's figures\n${table}`);

  // With a reference: each pile within 5 %, each site total within 1 %.
  let comparison: ReturnType<typeof compareVolumes> | null = null;
  let report = '';
  if (REFERENCE !== '') {
    expect(
      existsSync(REFERENCE),
      `QUADRION_E2E_VOLUME_REFERENCE names a file that is not there: ${REFERENCE}`,
    ).toBe(true);
    comparison = compareVolumes(series.rows, parseReference(await readFile(REFERENCE, 'utf8')));
    report = formatComparison(comparison);
    record.reference = {
      file: basename(REFERENCE),
      ok: comparison.ok,
      rows: comparison.rows,
      missingInApp: comparison.missingInOurs,
      fromAnEarlierVersion: comparison.carried,
      missingInReference: comparison.missingInReference,
      duplicates: comparison.duplicates,
    };
    say(`[stockpile] against the reference\n${report}`);
    await testInfo.attach('volume-comparison.txt', { body: report, contentType: 'text/plain' });
  } else
    say('[stockpile] no reference given (QUADRION_E2E_VOLUME_REFERENCE): figures recorded only');
  await testInfo.attach('volume-figures.json', {
    body: JSON.stringify(record, null, 2),
    contentType: 'application/json',
  });

  if (comparison) {
    expect(comparison.rows.length, `nothing to compare\n${report}`).toBeGreaterThan(0);
    expect(
      comparison.missingInOurs,
      `the reference names figures the app does not have\n${report}`,
    ).toEqual([]);
    expect(comparison.ok, `figures outside their limits\n${report}`).toBe(true);
  }
});
