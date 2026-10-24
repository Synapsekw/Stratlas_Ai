/**
 * The pile panel (volumetrics redesign, spec section 3, Stage B) in the real app, on the synthetic
 * quarry demo: three monthly surveys, prepared quietly on open (`autoPrepareSurfaces`). A pile
 * opens in its panel in the Volumes tab wherever it is picked: an Inventory row, its body in 3D,
 * its outline on the Map, its sidebar row, with the right workbench folded too. The panel shows the
 * pile's volume, tonnes and change against the demo's `truth.json`; Profile has a chip per survey
 * and the chart along the pile's long axis, whose point shows on the line in 3D and whose ends can
 * be moved there; History has one row per survey; Esc returns to the inventory. A distance line
 * drawn across a pile is picked as the line, the pile's body beside it opens the pile. The panel's
 * floats leave the view free at 1100 x 700. Off-screen, zero network, pipeline Python needed.
 */
import { toWgs84 } from '@aio/geo';
import { MeasurementsFile, ProjectManifest } from '@aio/schema';
import type { Locator, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { measureTree, selectMeasure, stageMode, volumesView } from './island';
import { focusPile } from './measureCard';
import { openDemo } from './surveyJobs';
import type { SurveyDemoProject } from './surveyFixtures';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

const SP1 = 'Stockpile SP1';
const SP1_ID = 'm-sp1';
const DATES = ['m1', 'm2', 'm3'] as const;
/** Crushed rock 20 mm, the first pile's material (survey_synth.py `quarry_site`). */
const SP1_DENSITY = 1.6;

interface QuarryTruth {
  stockpiles: Record<string, { dates: Partial<Record<string, { volumeM3: number }>> }>;
}

/** The first figure of a text the app shows ("1 234.5 m³", "−56.7"), signed. */
const figure = (text: string): number => {
  const m = /[-+−]?[\d ,]*\d(?:\.\d+)?/.exec(text.replace(/\s/g, ' '));
  return Number((m?.[0] ?? 'NaN').replace(/[ ,+]/g, '').replace('−', '-'));
};

/** Within the quick demo's tolerance: 2 % of the truth, and half a cubic metre. */
function near(got: number, want: number): void {
  expect(Math.abs(got - want), `${String(got)} against ${String(want)}`).toBeLessThanOrEqual(
    0.02 * Math.abs(want) + 0.5,
  );
}

interface Pt {
  x: number;
  y: number;
}

/** A measurement's outline (site E, N, Z) from the project's measurements file. */
async function outline(p: SurveyDemoProject, id: string): Promise<[number, number, number][]> {
  const file = MeasurementsFile.parse(
    JSON.parse(await readFile(join(p.dir, 'survey', 'measurements.json'), 'utf8')),
  );
  const m = file.measurements.find((x) => x.id === id);
  if (!m) throw new Error(`no measurement ${id}`);
  return m.points.map((q) => [q[0], q[1], q[2]]);
}

/**
 * The page point of a measurement's label anchor in the 3D view (a closed shape's centroid, a
 * line's last point): the label's own translate, read off its layer.
 */
async function labelAnchor3d(win: Page, id: string): Promise<Pt> {
  const label = win.locator(`[data-scene-view] .sv-labels .sv-label[data-id="${id}"]`).first();
  await expect(label).toBeVisible({ timeout: 30_000 });
  const at = await label.evaluate((el) => {
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec((el as HTMLElement).style.transform);
    const r = el.parentElement?.getBoundingClientRect();
    return m && r ? { x: r.left + Number(m[1]), y: r.top + Number(m[2]) } : null;
  });
  if (!at) throw new Error(`no label anchor for ${id}`);
  return at;
}

/** Wait until the map has stopped moving: its view the same over several reads. */
async function mapStill(win: Page): Promise<void> {
  let last = '';
  let same = 0;
  await expect
    .poll(
      async () => {
        const now = await win.evaluate(() => {
          type MapEl = Element & {
            __aioMap: {
              isMoving(): boolean;
              loaded(): boolean;
              getCenter(): { lng: number; lat: number };
              getZoom(): number;
              getBearing(): number;
            };
          };
          const el = [...document.querySelectorAll('*')].find((x) => '__aioMap' in x) as
            MapEl | undefined;
          const m = el?.__aioMap;
          if (!m || m.isMoving() || !m.loaded()) return 'moving';
          const c = m.getCenter();
          return JSON.stringify([c.lng, c.lat, m.getZoom(), m.getBearing()]);
        });
        same = now !== 'moving' && now === last ? same + 1 : 0;
        last = now;
        return same;
      },
      { intervals: [300], timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(3);
}

/** The page point of a site E, N on the map. */
async function mapPoint(win: Page, epsg: number, e: number, n: number): Promise<Pt> {
  const ll = toWgs84([e, n, 0], epsg);
  return win.evaluate((ll) => {
    type MapEl = Element & {
      __aioMap: {
        project(p: [number, number]): { x: number; y: number };
        getContainer(): HTMLElement;
      };
    };
    const el = [...document.querySelectorAll('*')].find((x) => '__aioMap' in x) as MapEl;
    const p = el.__aioMap.project([ll[0], ll[1]]);
    const r = el.__aioMap.getContainer().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, ll);
}

async function epsgOf(p: SurveyDemoProject): Promise<number> {
  const m = ProjectManifest.parse(JSON.parse(await readFile(join(p.dir, 'manifest.json'), 'utf8')));
  if (!('epsg' in m.crs)) throw new Error('the quarry demo has no EPSG CRS');
  return m.crs.epsg;
}

/** Open the quarry and wait until the inventory has its figures (surfaces prepared on open). */
async function opened(win: Page, p: SurveyDemoProject): Promise<Locator> {
  await openDemo(win, p.name, p.id);
  const view = await volumesView(win);
  await expect(view.getByTestId('volumes-pile')).toHaveCount(4, { timeout: 60_000 });
  await expect(
    view.getByTestId('volumes-inventory-table').locator('tbody tr[data-capture="m3"]'),
  ).toHaveCount(1, { timeout: 360_000 });
  return view;
}

/** The panel's Volume tile holds a figure (not a status): the pile's series is worked out. */
async function figuresIn(panel: Locator): Promise<void> {
  await expect(panel.getByTestId('pile-kpi-volume').locator('b')).toBeVisible({
    timeout: 240_000,
  });
}

test('an Inventory row opens the pile panel with volume, tonnes and change', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  const truth = (quarryProject.truth as unknown as QuarryTruth).stockpiles.sp1?.dates ?? {};
  const want = (d: string) => truth[d]?.volumeM3 ?? Number.NaN;
  const view = await opened(win, quarryProject);
  await view.getByTestId('volumes-pile').filter({ hasText: SP1 }).click();

  const panel = view.getByTestId('pile-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('pile-name')).toHaveText(SP1);
  await expect(panel.getByTestId('pile-material')).toContainText('Crushed rock 20 mm');
  await expect(panel.getByTestId('pile-position')).toHaveText(/^Pile \d+ of 4$/);
  await figuresIn(panel);
  near(figure(await panel.getByTestId('pile-kpi-volume').innerText()), want('m3'));
  near(
    figure(await panel.getByTestId('pile-kpi-tonnes').locator('b').innerText()) / SP1_DENSITY,
    want('m3'),
  );
  const vs = panel.getByTestId('pile-kpi-vs');
  await expect(vs).toContainText(/vs .*28 Feb/);
  await expect(vs).toHaveAttribute('data-sign', 'gain');
  near(figure(await vs.locator('b').innerText()), want('m3') - want('m2'));
  // every date is prepared and the figure current: no status line
  await expect(panel.getByTestId('pile-status')).toHaveCount(0);
  await expect(panel.getByTestId('pile-footprint')).toContainText('m²');

  // the next pile and back
  await panel.getByTestId('pile-next').click();
  await expect(panel.getByTestId('pile-name')).not.toHaveText(SP1);
  await panel.getByTestId('pile-prev').click();
  await expect(panel.getByTestId('pile-name')).toHaveText(SP1);
  // ‹ Inventory returns to the list
  await panel.getByTestId('pile-back').click();
  await expect(view.getByTestId('pile-panel')).toHaveCount(0);
  await expect(view.getByTestId('volumes-inventory')).toBeVisible();
});

test('a click on the pile in 3D and on its outline in Map opens the same panel', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  const view = await opened(win, quarryProject);
  const panel = view.getByTestId('pile-panel');
  await expect(panel).toHaveCount(0);

  // 3D: the pile's body, at its label's anchor (the outline's centroid)
  const body = await labelAnchor3d(win, SP1_ID);
  await win.mouse.click(body.x, body.y);
  await expect(panel).toHaveAttribute('data-id', SP1_ID);
  await panel.getByTestId('pile-back').click();
  await expect(panel).toHaveCount(0);

  // Map: the middle of the outline's first edge
  await stageMode(win, 'Map');
  const ring = await outline(quarryProject, SP1_ID);
  const [a, b] = [ring[0], ring[1]];
  if (!a || !b) throw new Error('no outline');
  const epsg = await epsgOf(quarryProject);
  await expect
    .poll(() =>
      win.evaluate(() => [...document.querySelectorAll('*')].some((x) => '__aioMap' in x)),
    )
    .toBe(true);
  // the map settles its fit first: the point is read once it stops moving
  await mapStill(win);
  const edge = await mapPoint(win, epsg, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  await win.mouse.click(edge.x, edge.y);
  await expect(panel).toHaveAttribute('data-id', SP1_ID);
});

test('a pile picked with the right workbench folded opens it with its panel', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  await opened(win, quarryProject);
  const right = win.getByTestId('panel-handle-right');
  await right.click();
  await expect(win.locator('.ws.right-off')).toHaveCount(1);
  await expect(win.getByTestId('pile-panel')).toHaveCount(0);
  const body = await labelAnchor3d(win, SP1_ID);
  await win.mouse.click(body.x, body.y);
  const panel = win.getByTestId('pile-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-id', SP1_ID);
  // from the sidebar's row too
  await panel.getByTestId('pile-back').click();
  await expect(panel).toHaveCount(0);
  await measureTree(win);
  const again = await focusPile(win, SP1);
  await expect(again).toHaveAttribute('data-id', SP1_ID);
});

test('Profile shows a chip per survey and the chart, its point on the line in 3D; History has one row per survey', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  const truth = (quarryProject.truth as unknown as QuarryTruth).stockpiles.sp1?.dates ?? {};
  const view = await opened(win, quarryProject);
  await view.getByTestId('volumes-pile').filter({ hasText: SP1 }).click();
  const panel = view.getByTestId('pile-panel');
  await figuresIn(panel);

  // Profile: a chip per survey date, the chart along the long axis, its length said
  await panel.getByTestId('pile-tab-profile').click();
  const profile = panel.getByTestId('pile-profile');
  // the latest survey and the one before it, then the first from "+ Date or design"
  const chips = profile.getByTestId('pile-chips');
  await expect(chips.locator('[data-chip]')).toHaveCount(2, { timeout: 120_000 });
  await chips.getByRole('button', { name: '+ Date or design', exact: true }).click();
  const menu = win.getByRole('menu', { name: '+ Date or design' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /31 January 2026/ }).click();
  await expect(chips.locator('[data-chip]')).toHaveCount(DATES.length);
  const chart = profile.getByTestId('pile-profile-chart');
  await expect(chart).toBeVisible({ timeout: 120_000 });
  await expect(profile.getByTestId('pile-line')).toContainText(/long axis · [\d.]+ m/);
  await expect(win.getByTestId('stage-hint')).toHaveAttribute('data-kind', 'pile');

  // hovering the chart puts its point on the pile's line in 3D, at the same chainage
  const box = await chart.locator('svg.pc-svg').boundingBox();
  if (!box) throw new Error('no chart');
  await win.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
  const readout = chart.getByTestId('chart-readout');
  await expect(readout).toBeVisible();
  const chainage = figure(await readout.locator('.pc-ro-head').innerText());
  const tag = win.locator(
    '[data-scene-view] .link-labels:not(.link-labels-map) [data-testid="link-tag"]',
  );
  await expect(tag.first()).toBeVisible();
  await expect(tag.first()).toHaveAttribute('data-key', `pile:${SP1_ID}`);
  expect(Math.abs(Number(await tag.first().getAttribute('data-chainage')) - chainage)).toBeLessThan(
    0.15,
  );
  await expect(win.getByTestId('stage-hint')).toHaveAttribute('data-kind', 'following');

  // the line's B end dragged out along the axis: the line grows
  await win.mouse.move(box.x + box.width / 2, box.y - 80);
  const before = figure(await profile.getByTestId('pile-line').innerText());
  const handleA = win.locator('[data-scene-view] [data-testid="pile-axis-a"]').first();
  const handleB = win.locator('[data-scene-view] [data-testid="pile-axis-b"]').first();
  await expect(handleB).toBeVisible();
  const ha = await handleA.boundingBox();
  const hb = await handleB.boundingBox();
  if (!ha || !hb) throw new Error('no handles');
  const from = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
  const dir = { x: from.x - (ha.x + ha.width / 2), y: from.y - (ha.y + ha.height / 2) };
  const len = Math.hypot(dir.x, dir.y) || 1;
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  await win.mouse.move(from.x + (dir.x / len) * 40, from.y + (dir.y / len) * 40, { steps: 8 });
  await win.mouse.up();
  await expect
    .poll(async () => figure(await profile.getByTestId('pile-line').innerText()))
    .toBeGreaterThan(before + 1);

  // History: one row per survey, newest first, its density and tonnes, the earliest "first"
  await panel.getByTestId('pile-tab-history').click();
  const rows = panel.getByTestId('pile-history-table').locator('tbody tr');
  await expect(rows).toHaveCount(DATES.length);
  for (const [i, d] of [...DATES].reverse().entries()) {
    const row = rows.nth(i);
    await expect(row).toHaveAttribute('data-capture', d);
    near(figure(await row.locator('td').nth(0).innerText()), truth[d]?.volumeM3 ?? Number.NaN);
    await expect(row.locator('td').nth(1)).toHaveText(SP1_DENSITY.toFixed(2));
  }
  await expect(rows.first()).toHaveAttribute('aria-current', 'date');
  await expect(rows.last().locator('td').last()).toHaveText('first');
  await expect(panel.getByTestId('pile-history-chart').first()).toBeVisible();
});

test('Esc returns to the inventory', async ({ quarryProject, win }) => {
  test.setTimeout(600_000);
  const view = await opened(win, quarryProject);
  await view.getByTestId('volumes-pile').filter({ hasText: SP1 }).click();
  const panel = view.getByTestId('pile-panel');
  await expect(panel).toBeVisible();
  await expect(win.getByTestId('stage-hint')).toHaveAttribute('data-kind', 'pile');
  await panel.getByTestId('pile-tab-overview').focus();
  await win.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(view.getByTestId('volumes-inventory')).toBeVisible();
  await expect(win.getByTestId('stage-hint')).toHaveCount(0);

  // from the stage too: the pile opened in 3D, Esc on the view closes it
  const body = await labelAnchor3d(win, SP1_ID);
  await win.mouse.click(body.x, body.y);
  await expect(panel).toHaveAttribute('data-id', SP1_ID);
  await win.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('a distance line across a pile: the line picks the line, the body beside it opens the pile', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  // a line across the first pile, north to south 20 m east of its centre (across a view that
  // looks north) and 20 m past its outline each side,
  // filed under the latest survey
  const ring = await outline(quarryProject, SP1_ID);
  const es = ring.map((q) => q[0]);
  const ns = ring.map((q) => q[1]);
  const e = (Math.min(...es) + Math.max(...es)) / 2 + 20;
  const z = ring[0]?.[2] ?? 0;
  const mfile = join(quarryProject.dir, 'survey', 'measurements.json');
  const file = MeasurementsFile.parse(JSON.parse(await readFile(mfile, 'utf8')));
  file.measurements.push({
    id: 'line-sp1',
    family: 'line',
    tool: 'distance',
    label: 'Line across SP1',
    scope: { kind: 'survey', capture: 'm3' },
    points: [
      [e, Math.min(...ns) - 20, z],
      [e, Math.max(...ns) + 20, z],
    ],
    items: [],
    results: [],
    createdAt: '2026-10-24T00:00:00Z',
  });
  await writeFile(mfile, JSON.stringify(MeasurementsFile.parse(file), null, 1));

  const view = await opened(win, quarryProject);
  // the line, at its north end (its label's anchor): selected for the Measure tab, no pile panel
  const end = await labelAnchor3d(win, 'line-sp1');
  await win.mouse.click(end.x, end.y);
  await expect(
    win.getByTestId('survey-panel').getByRole('textbox', { name: 'Rename' }),
  ).toHaveValue('Line across SP1');
  await expect(win.getByTestId('pile-panel')).toHaveCount(0);

  // the pile's body, at its centre (20 m off the line): the pile panel
  const body = await labelAnchor3d(win, SP1_ID);
  await win.mouse.click(body.x, body.y);
  await expect(view.getByTestId('pile-panel')).toHaveAttribute('data-id', SP1_ID);

  // and the line from the tree still goes to the Measure tab
  await measureTree(win, 'm3');
  await selectMeasure(win, 'Line across SP1');
  await expect(
    win.getByTestId('survey-panel').getByRole('textbox', { name: 'Rename' }),
  ).toHaveValue('Line across SP1');
});

test.describe('in the smallest window', () => {
  test.use({ appEnv: { ...PIPELINE_ENV, QUADRION_WINDOW_SIZE: '1100x700' } });

  test("the pile panel's floats do not cover the view at 1100 x 700", async ({
    quarryProject,
    win,
  }) => {
    test.setTimeout(600_000);
    const view = await opened(win, quarryProject);
    await view.getByTestId('volumes-pile').filter({ hasText: SP1 }).click();
    const panel = view.getByTestId('pile-panel');
    await figuresIn(panel);
    await panel.getByTestId('pile-tab-profile').click();
    await expect(panel.getByTestId('pile-profile-chart')).toBeVisible({ timeout: 120_000 });
    const hint = win.getByTestId('stage-hint');
    await expect(hint).toHaveAttribute('data-kind', 'pile');
    await expect(
      win.locator('[data-scene-view] [data-testid="pile-axis-b"]').first(),
    ).toBeVisible();
    const hits = await win.evaluate(() => {
      const canvas = document.querySelector('[data-scene-view] canvas');
      const h = document.querySelector('[data-testid="stage-hint"]');
      if (!canvas || !h) return null;
      const v = canvas.getBoundingClientRect();
      const r = h.getBoundingClientRect();
      const reaches = (x: number, y: number) => document.elementFromPoint(x, y) === canvas;
      return {
        // the view's middle is the view's; a click on the hint reaches the view under it
        centre: reaches(v.left + v.width / 2, v.top + v.height / 3),
        throughHint: reaches(r.left + r.width / 2, r.top + r.height / 2),
        hintInView: r.left >= v.left && r.right <= v.right && r.bottom <= v.bottom + 1,
        // in the view's lower half, its corner
        hintLow: r.top >= v.top + v.height / 2,
      };
    });
    expect(hits).toEqual({ centre: true, throughHint: true, hintInView: true, hintLow: true });
  });
});
