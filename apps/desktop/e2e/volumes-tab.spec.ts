/**
 * The Volumes tab (volumetrics redesign, spec section 6, boards 1, 4, 5) in the real app, on the
 * synthetic quarry demo: three monthly surveys, prepared quietly on open, three piles of three
 * materials and the pit. Inventory groups the piles by material with a subtotal each and a site
 * total that is their sum, under a header whose tiles follow the date in focus; a row opens the
 * pile panel. Cut & fill compares two surveys inside the piles or over the whole site, a threshold
 * leaves small changes out, and a pile's bar opens it. Materials changes a density from a survey
 * date: the dates before keep their tonnes, History keeps both densities, and piles are assigned
 * from the editor. The stage's Show control switches Photo, Elevation and Cut & fill, and hides the
 * piles' outlines and labels. Off-screen, zero network, pipeline Python needed.
 */
import { SurveySettings } from '@aio/schema';
import type { Locator, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { stageShow, showSurface, volumesView } from './island';
import { openDemo } from './surveyJobs';
import type { SurveyDemoProject } from './surveyFixtures';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

const SP1 = 'Stockpile SP1';
const SP1_ID = 'm-sp1';
/** Crushed rock 20 mm, the first pile's material, and its density (survey_synth.py). */
const CRUSHED = { id: 'crushed-20', name: 'Crushed rock 20 mm', density: 1.6 } as const;

/** The first figure of a text the app shows ("1 234.5 m³", "−56.7"), signed; NaN for "-". */
const figure = (text: string): number => {
  const m = /[-+−]?[\d ,]*\d(?:\.\d+)?/.exec(text.replace(/\s/g, ' '));
  return Number((m?.[0] ?? 'NaN').replace(/[ ,+]/g, '').replace('−', '-'));
};

/** Equal to the shown precision: a tenth, plus what a sum of rounded figures may add. */
function close(got: number, want: number, slack = 0.5): void {
  expect(Math.abs(got - want), `${String(got)} against ${String(want)}`).toBeLessThanOrEqual(slack);
}

const stripOf = (win: Page): Locator => win.getByRole('region', { name: 'Survey dates chart' });

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

/** Focus a survey from its marker in the dates strip. */
async function focusOn(win: Page, capture: string): Promise<void> {
  const marker = stripOf(win).locator(`[data-survey="${capture}"]`);
  await marker.click();
  await expect(marker).toHaveAttribute('aria-current', 'date');
}

interface Inventory {
  groups: { key: string; volume: number; tonnes: number; piles: number[]; pileTonnes: number[] }[];
  total: { volume: number; tonnes: number };
}

/** The Inventory table read as numbers: each group with its piles, and the site total. */
async function inventory(view: Locator): Promise<Inventory> {
  const rows = await view
    .getByTestId('volumes-inventory-table')
    .locator('tbody tr')
    .evaluateAll((trs) =>
      trs.map((tr) => ({
        id: tr.getAttribute('data-testid') ?? '',
        key: tr.getAttribute('data-material') ?? '',
        cells: [...tr.querySelectorAll('td')].map((td) => td.textContent),
        span: tr.querySelector('td[colspan]') !== null,
      })),
    );
  const out: Inventory = { groups: [], total: { volume: Number.NaN, tonnes: Number.NaN } };
  for (const r of rows) {
    if (r.id === 'volumes-group')
      out.groups.push({
        key: r.key,
        volume: figure(r.cells[0] ?? ''),
        tonnes: figure(r.cells[1] ?? ''),
        piles: [],
        pileTonnes: [],
      });
    else if (r.id === 'volumes-pile' && !r.span) {
      const g = out.groups.at(-1);
      g?.piles.push(figure(r.cells[0] ?? ''));
      g?.pileTonnes.push(figure(r.cells[1] ?? ''));
    } else if (r.id === 'volumes-site-total')
      out.total = { volume: figure(r.cells[0] ?? ''), tonnes: figure(r.cells[1] ?? '') };
  }
  return out;
}

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

test('Inventory groups the piles by material with subtotals and a site total that is their sum; the header follows the date; a row opens the pile panel', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  const view = await opened(win, quarryProject);
  const header = view.getByTestId('volumes-header');
  await expect(header).toContainText('Stockpile inventory');
  await expect(view.getByTestId('volumes-segment')).toHaveCount(3);
  await expect(
    view.locator('[data-testid="volumes-segment"][data-pane="inventory"]'),
  ).toHaveAttribute('aria-pressed', 'true');

  // the latest survey: a group per material, each the sum of its piles, the site total theirs
  await expect(header.getByTestId('volumes-date')).toContainText('31 Mar');
  const march = await inventory(view);
  expect(march.groups.map((g) => g.key)).toEqual(
    expect.arrayContaining([CRUSHED.id, 'washed-sand', 'base-course']),
  );
  for (const g of march.groups) {
    expect(g.piles.length, `piles of ${g.key}`).toBeGreaterThan(0);
    close(g.volume, sum(g.piles));
  }
  close(march.total.volume, sum(march.groups.map((g) => g.volume)));
  // tonnes by material: the crushed rock at its density
  const crushed = march.groups.find((g) => g.key === CRUSHED.id);
  if (!crushed) throw new Error('no crushed rock group');
  close(crushed.tonnes, crushed.volume * CRUSHED.density, 1);
  // the header's tiles are the site total's
  close(figure(await header.getByTestId('volumes-kpi-volume').innerText()), march.total.volume);
  close(figure(await header.getByTestId('volumes-kpi-tonnes').innerText()), march.total.tonnes, 1);
  await expect(header).toContainText('vs 28 Feb');

  // February: the header and the table follow the date in focus
  await focusOn(win, 'm2');
  await expect(header.getByTestId('volumes-date')).toContainText('28 Feb');
  await expect(header).toContainText('vs 31 Jan');
  await expect
    .poll(async () => (await inventory(view)).total.volume)
    .not.toBeCloseTo(march.total.volume, 0);
  const feb = await inventory(view);
  close(feb.total.volume, sum(feb.groups.map((g) => g.volume)));
  close(figure(await header.getByTestId('volumes-kpi-volume').innerText()), feb.total.volume);
  // the base course pile was first placed in March: on February's bare ground it holds about 0
  const base = feb.groups.find((g) => g.key === 'base-course');
  if (base)
    expect(Math.abs(base.volume)).toBeLessThan(
      0.05 * (march.groups.find((g) => g.key === 'base-course')?.volume ?? 0) + 1,
    );
  await expectAccessible(win, 'Volumes tab, Inventory', {
    include: '[data-testid="volumes-view"]',
  });

  // a row opens the pile panel; ‹ Inventory comes back
  await view.getByTestId('volumes-pile').filter({ hasText: SP1 }).click();
  const panel = view.getByTestId('pile-panel');
  await expect(panel).toHaveAttribute('data-id', SP1_ID);
  await expect(panel.getByTestId('pile-name')).toHaveText(SP1);
  await panel.getByTestId('pile-back').click();
  await expect(panel).toHaveCount(0);
  await expect(view.getByTestId('volumes-inventory')).toBeVisible();
});

test('Cut & fill: totals and a bar per pile for the pair; Inside piles and Whole site; the threshold changes the totals; a bar opens its pile', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  const view = await opened(win, quarryProject);
  await view.locator('[data-testid="volumes-segment"][data-pane="cutFill"]').click();
  const pane = view.getByTestId('cutfill-pane');
  await expect(pane).toBeVisible();
  // the pair: the survey before the date in focus, to it
  await expect(pane.getByRole('combobox', { name: 'From' })).toHaveValue('m2');
  await expect(pane.getByRole('combobox', { name: 'To' })).toHaveValue('m3');

  const tile = (k: 'cut' | 'fill' | 'net') => pane.locator(`.cf-tile[data-kpi="${k}"] b`);
  const totals = async () => ({
    cut: figure(await tile('cut').innerText()),
    fill: figure(await tile('fill').innerText()),
    net: figure(await tile('net').innerText()),
  });
  await expect(tile('net')).toBeVisible({ timeout: 240_000 });
  await expect(pane).toHaveAttribute('aria-busy', 'false', { timeout: 240_000 });
  const piles = await totals();
  close(piles.net, piles.fill - piles.cut, 1);
  // a bar per pile that changed: the first grew, the second shrank, the third is new in March
  const bars = pane.locator('.cf-bar');
  await expect(bars.filter({ hasText: SP1 })).toHaveAttribute('data-sign', 'fill');
  await expect(bars.filter({ hasText: 'Stockpile SP2' })).toHaveAttribute('data-sign', 'cut');

  // Whole site: the pit's sump cut counts too
  await pane.getByRole('button', { name: 'Whole site', exact: true }).click();
  await expect(pane.getByRole('button', { name: 'Whole site', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // (the pit is a volume measurement too: inside the piles already holds its sump cut, and the
  // rest of the ground is unchanged, so the whole site reads about the same)
  await expect(pane).toHaveAttribute('aria-busy', 'false', { timeout: 240_000 });
  await expect(tile('cut')).toBeVisible({ timeout: 240_000 });
  expect((await totals()).cut).toBeGreaterThanOrEqual(piles.cut - 1);
  // the whole site has no bars per pile
  await expect(bars).toHaveCount(0);
  await pane.getByRole('button', { name: 'Inside piles', exact: true }).click();
  await expect
    .poll(async () => (await totals()).cut, { timeout: 60_000 })
    .toBeCloseTo(piles.cut, 0);

  // a threshold leaves the small changes out: the totals shrink
  const ignore = pane.getByRole('textbox', { name: /Ignore/ });
  const ignored = await ignore.inputValue();
  await ignore.fill('2');
  await ignore.press('Enter');
  await expect
    .poll(
      async () => {
        const t = await totals();
        return t.cut + t.fill;
      },
      { timeout: 120_000 },
    )
    .toBeLessThan(piles.cut + piles.fill - 1);
  await ignore.fill(ignored);
  await ignore.press('Enter');
  await expect
    .poll(async () => (await totals()).fill, { timeout: 120_000 })
    .toBeCloseTo(piles.fill, 0);

  // a pile's bar opens it
  await bars.filter({ hasText: SP1 }).click();
  await expect(view.getByTestId('pile-panel')).toHaveAttribute('data-id', SP1_ID);
});

test('Materials: a density from the latest survey changes only its tonnes; History keeps both densities; piles are assigned from the editor', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  const view = await opened(win, quarryProject);
  // the first pile's tonnes in the Inventory (its row: volume, tonnes, change)
  const sp1Tonnes = async () =>
    figure(
      await view
        .getByTestId('volumes-pile')
        .filter({ hasText: SP1 })
        .locator('td')
        .nth(1)
        .innerText(),
    );
  const before = { m3: await sp1Tonnes(), m2: Number.NaN };
  await focusOn(win, 'm2');
  await expect(view.getByTestId('volumes-date')).toContainText('28 Feb');
  before.m2 = await sp1Tonnes();
  await focusOn(win, 'm3');
  await expect(view.getByTestId('volumes-date')).toContainText('31 Mar');

  // the material's editor, its density from the date in focus
  await view.locator('[data-testid="volumes-segment"][data-pane="materials"]').click();
  const pane = view.getByTestId('materials-pane');
  await expect(pane).toBeVisible();
  const row = pane.getByTestId('survey-mat-row').filter({ hasText: CRUSHED.name });
  await row.getByRole('button', { name: CRUSHED.name }).click();
  const editor = pane.getByTestId('materials-editor');
  await expect(editor).toHaveAttribute('data-id', CRUSHED.id);
  await expect(editor.getByTestId('materials-from')).toHaveValue('m3');
  await editor.getByTestId('materials-new-density').fill('2.00');
  await expect(editor.getByTestId('materials-unsaved')).toBeVisible();
  // History: the old density kept for the dates before, the new one from March
  const history = editor.getByTestId('materials-history').locator('li');
  await expect(history).toHaveCount(2);
  // newest first
  await expect(history.nth(0)).toContainText('2.00');
  await expect(history.nth(0)).toContainText('31 Mar 2026');
  await expect(history.nth(0)).toHaveAttribute('data-new', '');
  await expect(history.nth(1)).toContainText('1.60');
  await expect(history.nth(1)).toContainText('31 Jan 2026');
  await expect(editor.getByTestId('materials-impact')).toBeVisible();
  // the strip previews it in Tonnes
  await stripOf(win).getByRole('button', { name: 'Tonnes', exact: true }).click();
  await expect(stripOf(win).getByTestId('strip-preview')).toHaveText('· preview, unsaved');

  // assign the pit to the material from the editor
  await editor.getByTestId('materials-assign').click();
  await editor
    .getByTestId('materials-checklist')
    .getByRole('checkbox', { name: 'Pit (month on month)' })
    .check();
  await expect(editor.locator('[data-testid="materials-pile"][data-id="m-pit"]')).toBeVisible();
  await expectAccessible(win, 'Volumes tab, Materials', {
    include: '[data-testid="materials-pane"]',
  });

  await pane.getByTestId('survey-mat-save').click();
  await expect(editor.getByTestId('materials-unsaved')).toHaveCount(0);
  await expect(stripOf(win).getByTestId('strip-preview')).toHaveCount(0);
  // written: the history with both densities, the newest the current one
  const file = join(quarryProject.dir, 'survey', 'settings.json');
  const saved = async () =>
    SurveySettings.parse(JSON.parse(await readFile(file, 'utf8'))).materials.find(
      (m) => m.id === CRUSHED.id,
    );
  await expect.poll(async () => (await saved())?.densityTPerM3).toBe(2);
  expect((await saved())?.densityHistory).toEqual([
    { fromCapture: 'm1', tPerM3: CRUSHED.density },
    { fromCapture: 'm3', tPerM3: 2 },
  ]);
  // the pit carries the material now
  expect(
    await win.evaluate(
      () =>
        (
          window as unknown as {
            __stratlas: {
              measurements(): { measurements: { id: string; material?: string }[] };
            };
          }
        ).__stratlas
          .measurements()
          .measurements.find((m) => m.id === 'm-pit')?.material,
    ),
  ).toBe(CRUSHED.id);

  // March's tonnes at the new density, February's as they were
  await view.locator('[data-testid="volumes-segment"][data-pane="inventory"]').click();
  await expect(view.getByTestId('volumes-inventory')).toBeVisible();
  await expect.poll(sp1Tonnes).toBeCloseTo((before.m3 / CRUSHED.density) * 2, -1);
  close(await sp1Tonnes(), (before.m3 / CRUSHED.density) * 2, 2);
  await focusOn(win, 'm2');
  await expect(view.getByTestId('volumes-date')).toContainText('28 Feb');
  close(await sp1Tonnes(), before.m2, 1);
});

test('the Show control switches Photo, Elevation and Cut & fill, and hides the piles’ outlines and labels', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  await opened(win, quarryProject);
  const show = await stageShow(win);
  await expect(show).toHaveAccessibleName('Show');
  await expect(show.getByRole('button', { name: 'Photo', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // the rasters shown for the dates: orthos for Photo, surfaces for Elevation
  const shownRoles = () =>
    win.evaluate(() => {
      interface W {
        __stratlas: {
          workspace: {
            getState(): {
              hidden: Record<string, boolean>;
              project: { manifest: { layers: { id: string; kind: string; role?: string }[] } };
            };
          };
        };
      }
      const s = (window as unknown as W).__stratlas.workspace.getState();
      const roles = s.project.manifest.layers
        .filter((l) => l.kind === 'raster' && !s.hidden[l.id])
        .map((l) => l.role ?? '');
      return [...new Set(roles)].sort();
    });
  expect(await shownRoles()).toContain('ortho');
  await showSurface(win, 'Elevation');
  await expect.poll(shownRoles).toContain('dsm');
  expect(await shownRoles()).not.toContain('ortho');
  // Cut & fill: the comparison's heat map (the rasters stay as they were)
  await showSurface(win, 'Cut & fill');
  for (const other of ['Photo', 'Elevation'])
    await expect(show.getByRole('button', { name: other, exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  await showSurface(win, 'Photo');
  await expect.poll(shownRoles).toContain('ortho');
  expect(await shownRoles()).not.toContain('dsm');

  // Labels off: the piles' labels go from the 3D view, their outlines stay
  const label = win.locator(`[data-scene-view] .sv-labels .sv-label[data-id="${SP1_ID}"]`);
  const outlined = () =>
    win.evaluate((id) => {
      interface W {
        __stratlas: {
          stage(): {
            scene: {
              getObjectByName(n: string): { children: { name: string }[] } | undefined;
            };
          } | null;
        };
      }
      const group = (window as unknown as W).__stratlas
        .stage()
        ?.scene.getObjectByName('aio-survey-measurements');
      return (group?.children ?? []).some((c) => c.name === `measure:${id}`);
    }, SP1_ID);
  await expect(label).toBeVisible({ timeout: 60_000 });
  await expect.poll(outlined).toBe(true);
  const labels = show.getByRole('button', { name: 'Labels', exact: true });
  const outlines = show.getByRole('button', { name: 'Outlines', exact: true });
  await labels.click();
  await expect(labels).toHaveAttribute('aria-pressed', 'false');
  await expect(label).toHaveCount(0);
  await expect.poll(outlined).toBe(true);
  // Outlines off as well: nothing of the piles is drawn
  await outlines.click();
  await expect(outlines).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(outlined).toBe(false);
  // both back
  await labels.click();
  await outlines.click();
  await expect(label).toBeVisible();
  await expect.poll(outlined).toBe(true);
});
