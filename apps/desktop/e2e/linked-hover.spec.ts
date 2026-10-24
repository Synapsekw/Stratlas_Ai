/**
 * The linked hover (volumetrics redesign, spec section 4, Stage B) in the real app, on the
 * synthetic earthworks demo: two surveys prepared through the real `survey.prepare` job and a
 * distance line across the pad. The line card's chart and the line in the scene share one point:
 * hovering the chart puts a tag on the line in 3D with the chainage and the change between the
 * surveys; the pointer on the line on the Map moves the chart's crosshair; a click pins the point
 * (it stays when the pointer leaves, Esc clears it); a double-click flies there; both Split panes
 * show the tag; with the section window open the tag stays above it. Off-screen, zero network,
 * pipeline Python needed.
 */
import { toWgs84 } from '@aio/geo';
import { MeasurementsFile, ProjectManifest } from '@aio/schema';
import type { Locator, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { measureTree, selectMeasure, stageMode } from './island';
import { focusMeasure } from './measureCard';
import { openDemo, runJob } from './surveyJobs';
import type { SurveyDemoProject } from './surveyFixtures';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

const LINE = 'Line across the pad';
const KEY = 'measure:line-pad';
/** The line across the pad (E 551140 to 551260 at N 2331400): 120 m. */
const A: [number, number] = [551140, 2331400];
const B: [number, number] = [551260, 2331400];

interface Pt {
  x: number;
  y: number;
}

/** The tag in the 3D views (not the map's). */
const tag3d = (win: Page): Locator =>
  win.locator('[data-scene-view] .link-labels:not(.link-labels-map) [data-testid="link-tag"]');
/** The pin badge in the 3D views. */
const pin3d = (win: Page): Locator =>
  win.locator('[data-scene-view] .link-labels:not(.link-labels-map) [data-testid="link-pin"]');

/** The first number of a text ("Chainage 42.3 m"). */
const number = (text: string): number => {
  const m = /-?\d[\d ,]*(?:\.\d+)?/.exec(text.replace(/\s/g, ' '));
  return Number((m?.[0] ?? 'NaN').replace(/[ ,]/g, ''));
};

/** The two first surveys' DSMs as height tiles, a distance line and a section across the pad. */
async function prepared(win: Page, p: SurveyDemoProject): Promise<void> {
  await runJob(win, 'survey.prepare', p.dir, {
    surfaces: [
      {
        id: 'dsm-d1',
        name: 'Survey 1 DSM',
        source: { kind: 'dsm', layer: 'dsm-d1' },
        capture: 'd1',
      },
      {
        id: 'dsm-d2',
        name: 'Survey 2 DSM',
        source: { kind: 'dsm', layer: 'dsm-d2' },
        capture: 'd2',
      },
    ],
    geodesy: false,
  });
  // the third survey is left out of this copy: the card starts on the latest prepared date
  const mpath = join(p.dir, 'manifest.json');
  const manifest = ProjectManifest.parse(JSON.parse(await readFile(mpath, 'utf8')));
  await writeFile(
    mpath,
    JSON.stringify(
      ProjectManifest.parse({
        ...manifest,
        captures: manifest.captures.filter((c) => c.id !== 'd3'),
        layers: manifest.layers.filter((l) => l.capture !== 'd3'),
      }),
      null,
      2,
    ),
  );
  const mfile = join(p.dir, 'survey', 'measurements.json');
  const m = MeasurementsFile.parse(JSON.parse(await readFile(mfile, 'utf8')));
  const across = {
    family: 'line' as const,
    scope: { kind: 'survey' as const, capture: 'd2' },
    points: [
      [A[0], A[1], 120],
      [B[0], B[1], 121.2],
    ] as [number, number, number][],
    items: [],
    results: [],
    createdAt: '2026-10-24T00:00:00Z',
  };
  m.measurements.push(
    { ...across, id: 'line-pad', tool: 'distance', label: LINE },
    { ...across, id: 'sec-pad', tool: 'section', label: 'Section across the pad' },
  );
  await writeFile(mfile, JSON.stringify(MeasurementsFile.parse(m), null, 1));
  await openDemo(win, p.name, p.id);
  await measureTree(win, 'd2');
}

/** The line card with both surveys drawn on its chart; returns the chart. */
async function lineChart(win: Page): Promise<Locator> {
  const card = await focusMeasure(win, LINE);
  const chart = card.getByTestId('line-profile');
  await expect(chart.locator('polyline[data-series="d2"]').first()).toBeAttached({
    timeout: 60_000,
  });
  await expect(chart.locator('polyline[data-series="d1"]').first()).toBeAttached({
    timeout: 60_000,
  });
  return chart;
}

/** Hover the chart at a fraction of its width; returns the readout's chainage. */
async function hoverChart(win: Page, chart: Locator, f: number): Promise<number> {
  const box = await chart.locator('svg.pc-svg').boundingBox();
  if (!box) throw new Error('no chart');
  // high in the plot: a chart low in the stage may reach past the window's foot
  await win.mouse.move(box.x + box.width * f, box.y + Math.min(box.height / 2, 40));
  const head = chart.getByTestId('chart-readout').locator('.pc-ro-head');
  await expect(head).toBeVisible();
  return number(await head.innerText());
}

async function epsgOf(p: SurveyDemoProject): Promise<number> {
  const m = ProjectManifest.parse(JSON.parse(await readFile(join(p.dir, 'manifest.json'), 'utf8')));
  if (!('epsg' in m.crs)) throw new Error('the earthworks demo has no EPSG CRS');
  return m.crs.epsg;
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

/** The page point of a site E, N on the map (the first map on the page). */
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

/** The centre of an element's box. */
async function centreOf(l: Locator): Promise<Pt> {
  const b = await l.boundingBox();
  if (!b) throw new Error('no box');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test('hovering the chart shows the tag on the line in 3D with chainage and delta', async ({
  earthworksProject,
  win,
}) => {
  test.setTimeout(420_000);
  await prepared(win, earthworksProject);
  const chart = await lineChart(win);
  await expect(tag3d(win)).toBeHidden();

  const chainage = await hoverChart(win, chart, 0.5);
  const tag = tag3d(win).first();
  await expect(tag).toBeVisible();
  await expect(tag).toHaveAttribute('data-key', KEY);
  expect(Math.abs(Number(await tag.getAttribute('data-chainage')) - chainage)).toBeLessThan(0.15);
  // "60.0 m · −1.63": the chainage, then the change between the two surveys, signed
  await expect(tag).toHaveText(/^[\d.,]+ m · [−+]?[\d.,]+$/);
  // the hint says the scene follows the chart
  await expect(win.getByTestId('stage-hint')).toHaveAttribute('data-kind', 'following');

  // another point on the chart moves the tag along the line
  const before = await centreOf(tag);
  const later = await hoverChart(win, chart, 0.8);
  expect(later).toBeGreaterThan(chainage);
  await expect
    .poll(async () =>
      Math.hypot((await centreOf(tag)).x - before.x, (await centreOf(tag)).y - before.y),
    )
    .toBeGreaterThan(5);

  // the pointer off the chart: the tag goes
  const box = await chart.locator('svg.pc-svg').boundingBox();
  if (!box) throw new Error('no chart');
  await win.mouse.move(box.x + box.width / 2, box.y - 80);
  await expect(tag3d(win)).toBeHidden();
});

test('moving the pointer onto the line on the map moves the chart crosshair', async ({
  earthworksProject,
  win,
}) => {
  test.setTimeout(420_000);
  await prepared(win, earthworksProject);
  const chart = await lineChart(win);
  await stageMode(win, 'Map');
  await expect
    .poll(() =>
      win.evaluate(() => [...document.querySelectorAll('*')].some((x) => '__aioMap' in x)),
    )
    .toBe(true);
  const epsg = await epsgOf(earthworksProject);
  // 30 m along the line from A, once the map stands still
  const at = (f: number) => mapPoint(win, epsg, A[0] + (B[0] - A[0]) * f, A[1]);
  await mapStill(win);
  const p = await at(0.25);
  await win.mouse.move(p.x, p.y + 30);
  await expect(chart.getByTestId('chart-crosshair')).toHaveCount(0);
  await win.mouse.move(p.x, p.y, { steps: 4 });
  await expect(chart.getByTestId('chart-crosshair')).toBeAttached();
  const head = chart.getByTestId('chart-readout').locator('.pc-ro-head');
  await expect(head).toBeVisible();
  // the chart reads the chainage under the pointer: a quarter of 120 m, give or take a few pixels
  expect(Math.abs(number(await head.innerText()) - 30)).toBeLessThan(4);
  await expect(win.getByTestId('stage-hint')).toHaveAttribute('data-kind', 'snapped');
  // the map's tag sits on the line there
  const tag = win.locator('.link-labels-map [data-testid="link-tag"]').first();
  await expect(tag).toBeVisible();
  await expect(tag).toHaveAttribute('data-key', KEY);

  // further along the line, the crosshair follows
  const q = await at(0.75);
  await win.mouse.move(q.x, q.y, { steps: 6 });
  await expect.poll(async () => number(await head.innerText())).toBeGreaterThan(80);
  // off the line: the chart lets go
  await win.mouse.move(q.x, q.y + 60, { steps: 3 });
  await expect(chart.getByTestId('chart-crosshair')).toHaveCount(0);
});

test('click pins: the pin stays after the pointer leaves; Esc clears it', async ({
  earthworksProject,
  win,
}) => {
  test.setTimeout(420_000);
  await prepared(win, earthworksProject);
  const chart = await lineChart(win);
  const box = await chart.locator('svg.pc-svg').boundingBox();
  if (!box) throw new Error('no chart');
  await win.mouse.click(box.x + box.width * 0.4, box.y + box.height / 2);
  await expect(chart.getByTestId('chart-pin-badge')).toBeVisible();
  // the pointer leaves the chart: the pin stays, in the chart and on the line in 3D
  await win.mouse.move(box.x + box.width / 2, box.y - 80);
  await expect(chart.getByTestId('chart-pin-badge')).toBeVisible();
  await expect(pin3d(win).first()).toBeVisible();
  await expect(tag3d(win).first()).toBeVisible();
  await expect(tag3d(win).first()).toHaveClass(/pinned/);
  await expect(win.getByTestId('stage-hint')).toHaveAttribute('data-kind', 'pinned');
  // Esc, with the pointer on the stage: the pin goes, then the tag with it
  const canvas = await win.locator('[data-scene-view] canvas').first().boundingBox();
  if (!canvas) throw new Error('no canvas');
  await win.mouse.move(canvas.x + 40, canvas.y + 40);
  await win.keyboard.press('Escape');
  await expect(chart.getByTestId('chart-pin-badge')).toHaveCount(0);
  await expect(pin3d(win)).toBeHidden();
  await expect(tag3d(win)).toBeHidden();
});

test('double-click flies: the tag ends near the view centre', async ({
  earthworksProject,
  win,
}) => {
  test.setTimeout(420_000);
  await prepared(win, earthworksProject);
  const chart = await lineChart(win);
  const box = await chart.locator('svg.pc-svg').boundingBox();
  if (!box) throw new Error('no chart');
  // near B: away from where the view starts centred
  await win.mouse.dblclick(box.x + box.width * 0.9, box.y + box.height / 2);
  // the point stays pinned where the camera goes
  await expect(chart.getByTestId('chart-pin-badge')).toBeVisible();
  const view = await win.locator('[data-scene-view] canvas').first().boundingBox();
  if (!view) throw new Error('no view');
  const pin = pin3d(win).first();
  await expect(pin).toBeVisible();
  const centre = { x: view.x + view.width / 2, y: view.y + view.height / 2 };
  // the fly is animated: wait for the pin to settle near the middle of the view
  await expect
    .poll(
      async () => {
        const at = await centreOf(pin);
        return Math.hypot(at.x - centre.x, at.y - centre.y);
      },
      { timeout: 15_000 },
    )
    .toBeLessThan(Math.min(view.width, view.height) * 0.2);
});

test('in Split both panes show the tag', async ({ earthworksProject, win }) => {
  test.setTimeout(420_000);
  await prepared(win, earthworksProject);
  const chart = await lineChart(win);
  await stageMode(win, 'Split');
  await expect(win.getByTestId('pane-chooser-right')).toBeVisible();
  await hoverChart(win, chart, 0.5);
  // one tag per pane, each on the same chainage
  const tags = win.locator('[data-side] [data-testid="link-tag"]:visible');
  await expect(tags).toHaveCount(2);
  const left = win.locator('[data-side="left"] [data-testid="link-tag"]:visible');
  const right = win.locator('[data-side="right"] [data-testid="link-tag"]:visible');
  await expect(left).toHaveCount(1);
  await expect(right).toHaveCount(1);
  expect(await left.getAttribute('data-chainage')).toBe(await right.getAttribute('data-chainage'));
});

test('with the section window open the tag stays visible above it', async ({
  earthworksProject,
  win,
}) => {
  test.setTimeout(420_000);
  await prepared(win, earthworksProject);
  await selectMeasure(win, 'Section across the pad');
  const dock = win.getByTestId('section-dock');
  await expect(dock.getByTestId('section-chart')).toBeVisible({ timeout: 60_000 });
  await dock.getByTestId('section-popout').click();
  const big = win.getByTestId('section-window');
  await expect(big).toBeVisible();
  const chart = big.getByTestId('section-window-chart');
  await expect(chart.locator('polyline[data-series]').first()).toBeAttached({ timeout: 60_000 });
  // the chart fits in the window, in the narrow stage between both sidebars too
  const fit = async () => {
    const c = await chart.locator('svg.pc-svg').boundingBox();
    const w = await big.boundingBox();
    return !!c && !!w && c.x >= w.x - 0.5 && c.x + c.width <= w.x + w.width + 0.5;
  };
  await expect.poll(fit).toBe(true);
  await hoverChart(win, chart, 0.5);
  const tag = tag3d(win).first();
  await expect(tag).toBeVisible();
  await expect(tag).toHaveAttribute('data-key', 'section');
  // nothing covers the tag: the point under its middle is the tag
  const c = await centreOf(tag);
  const top = await win.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="link-tag"]') !== null,
    [c.x, c.y] as const,
  );
  expect(top).toBe(true);
  // and the window above the stage's lower part leaves the rest of the view to it
  const stage = await win.locator('.stage').first().boundingBox();
  const w = await big.boundingBox();
  if (!stage || !w) throw new Error('no stage or window');
  expect(w.y).toBeGreaterThan(stage.y + stage.height * 0.3);
});
