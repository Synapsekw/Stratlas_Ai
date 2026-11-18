/**
 * Volumetrics finalize, the pile and scene fixes, in the real app on the synthetic quarry demo
 * (three monthly surveys, four piles, prepared quietly on open). A pile opens in the right
 * panel's Selection tab wherever it is picked.
 *
 * - A click on another pile within reach of the open pile's profile line opens that pile; the
 *   line does not pin.
 * - With Show on Cut & fill and one pile open on the Map, the legend names the pile and the two
 *   sides of its own comparison; with the pile let go it names the compare pair again.
 * - With the larger chart window open over the stage's lower part, a fly on the Map lands the
 *   point in the part of the map the window leaves free.
 *
 * Off-screen, zero network, pipeline Python needed.
 */
import { toWgs84 } from '@aio/geo';
import { MeasurementsFile, ProjectManifest } from '@aio/schema';
import type { Locator, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { showSurface, stageMode } from './island';
import { openSection, selectedPile } from './panel';
import { openDemo } from './surveyJobs';
import type { SurveyDemoProject } from './surveyFixtures';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

const SP1 = 'Stockpile SP1';
const SP1_ID = 'm-sp1';

interface Pt {
  x: number;
  y: number;
}

type Ring = [number, number][];

/** Every pile of the project (a volume drawn as a polygon) with its outline, site E and N. */
async function piles(p: SurveyDemoProject): Promise<{ id: string; label: string; ring: Ring }[]> {
  const file = MeasurementsFile.parse(
    JSON.parse(await readFile(join(p.dir, 'survey', 'measurements.json'), 'utf8')),
  );
  return file.measurements
    .filter((m) => m.tool === 'volume' && m.family === 'polygon')
    .map((m) => ({
      id: m.id,
      label: m.label,
      ring: m.points.map((q): [number, number] => [q[0], q[1]]),
    }));
}

const centroid = (ring: Ring): [number, number] => [
  ring.reduce((a, q) => a + q[0], 0) / Math.max(1, ring.length),
  ring.reduce((a, q) => a + q[1], 0) / Math.max(1, ring.length),
];

async function epsgOf(p: SurveyDemoProject): Promise<number> {
  const m = ProjectManifest.parse(JSON.parse(await readFile(join(p.dir, 'manifest.json'), 'utf8')));
  if (!('epsg' in m.crs)) throw new Error('the quarry demo has no EPSG CRS');
  return m.crs.epsg;
}

/**
 * The page point of a measurement's label anchor in the 3D view (a closed shape's centroid): the
 * label's own translate, read off its layer.
 */
async function labelAnchor3d(win: Page, id: string): Promise<Pt> {
  const label = win.locator(`[data-scene-view] .sv-labels .sv-label[data-id="${id}"]`).first();
  await expect(label).toBeAttached({ timeout: 60_000 });
  await expect
    .poll(() => label.evaluate((el) => (el as HTMLElement).style.display), { timeout: 30_000 })
    .not.toBe('none');
  const at = await label.evaluate((el) => {
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec((el as HTMLElement).style.transform);
    const r = el.parentElement?.getBoundingClientRect();
    return m && r ? { x: r.left + Number(m[1]), y: r.top + Number(m[2]) } : null;
  });
  if (!at) throw new Error(`no label anchor for ${id}`);
  return at;
}

/** The stage has its map. */
async function mapThere(win: Page): Promise<void> {
  await expect
    .poll(() =>
      win.evaluate(() => [...document.querySelectorAll('*')].some((x) => '__aioMap' in x)),
    )
    .toBe(true);
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

/** The page point of a site E, N on the map, and whether the map's own canvas is what is there. */
async function mapPoint(
  win: Page,
  epsg: number,
  e: number,
  n: number,
): Promise<Pt & { onCanvas: boolean }> {
  const ll = toWgs84([e, n, 0], epsg);
  return win.evaluate((ll) => {
    type MapEl = Element & {
      __aioMap: {
        project(p: [number, number]): { x: number; y: number };
        getContainer(): HTMLElement;
        getCanvas(): HTMLElement;
      };
    };
    const el = [...document.querySelectorAll('*')].find((x) => '__aioMap' in x) as MapEl;
    const p = el.__aioMap.project([ll[0], ll[1]]);
    const r = el.__aioMap.getContainer().getBoundingClientRect();
    const at = { x: r.left + p.x, y: r.top + p.y };
    return { ...at, onCanvas: document.elementFromPoint(at.x, at.y) === el.__aioMap.getCanvas() };
  }, ll);
}

/** Put the map's centre on a site E, N at a zoom `dz` from the one it has, without a fly. */
async function mapJump(win: Page, epsg: number, e: number, n: number, dz: number): Promise<void> {
  const ll = toWgs84([e, n, 0], epsg);
  await win.evaluate(
    ({ ll, dz }) => {
      type MapEl = Element & {
        __aioMap: {
          getZoom(): number;
          jumpTo(o: { center: [number, number]; zoom: number }): void;
        };
      };
      const el = [...document.querySelectorAll('*')].find((x) => '__aioMap' in x) as MapEl;
      el.__aioMap.jumpTo({ center: [ll[0], ll[1]], zoom: el.__aioMap.getZoom() + dz });
    },
    { ll, dz },
  );
  await mapStill(win);
}

/**
 * Open the quarry and its first pile from the 3D view (its body, at its label's anchor); the
 * pile's panel is Selection's, with its figures worked out (the surveys prepared on open).
 */
async function pileOpened(win: Page, p: SurveyDemoProject): Promise<Locator> {
  await openDemo(win, p.name, p.id);
  // the scene first: the pile is picked in it
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible({ timeout: 60_000 });
  // once the camera has settled on the site: the anchor the same over two reads
  let last = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await labelAnchor3d(win, SP1_ID));
        const still = now === last;
        last = now;
        return still;
      },
      { intervals: [500], timeout: 60_000 },
    )
    .toBe(true);
  const body = await labelAnchor3d(win, SP1_ID);
  await win.mouse.click(body.x, body.y);
  const panel = selectedPile(win);
  await expect(panel).toHaveAttribute('data-id', SP1_ID, { timeout: 30_000 });
  await expect(panel.getByTestId('pile-name')).toHaveText(SP1);
  await expect(panel.getByTestId('pile-kpi-volume').locator('b')).toBeVisible({
    timeout: 360_000,
  });
  return panel;
}

/** The pile panel's Profile tab with its chart drawn: the pile's line is on the views then. */
async function profileShown(panel: Locator): Promise<void> {
  await panel.getByTestId('pile-tab-profile').click();
  await expect(panel.getByTestId('pile-profile-chart')).toBeVisible({ timeout: 120_000 });
}

const mapTag = (win: Page): Locator =>
  win.locator('.link-labels-map [data-testid="link-tag"]').first();
const mapPin = (win: Page): Locator =>
  win.locator('.link-labels-map [data-testid="link-pin"]').first();

test("a click on another pile within reach of the open pile's line opens that pile", async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(720_000);
  const all = await piles(quarryProject);
  const open = all.find((x) => x.id === SP1_ID);
  if (!open) throw new Error('no first pile');
  const from = centroid(open.ring);
  const dist = (q: [number, number]) => Math.hypot(q[0] - from[0], q[1] - from[1]);
  // the pile beside it: the one with the corner nearest the open pile
  const others = all
    .filter((x) => x.id !== SP1_ID)
    .map((x) => ({ ...x, near: Math.min(...x.ring.map(dist)) }))
    .sort((a, b) => a.near - b.near);
  const other = others[0];
  if (!other) throw new Error('no second pile');
  // its corners, the nearest to the open pile first
  const corners = [...other.ring].sort((a, b) => dist(a) - dist(b));
  const first = corners[0];
  if (!first) throw new Error('the second pile has no outline');
  const epsg = await epsgOf(quarryProject);

  const panel = await pileOpened(win, quarryProject);
  await stageMode(win, 'Map');
  await mapThere(win);
  await profileShown(panel);
  await mapStill(win);

  // Zoom the map out, a step at a time, until a corner of the other pile is within the line's
  // reach: the pointer on that corner snaps to the open pile's line (its tag shows on the map).
  const tag = mapTag(win);
  let at: Pt | null = null;
  for (let step = 0; step < 14 && !at; step++) {
    await mapJump(win, epsg, first[0], first[1], step === 0 ? 0 : -0.5);
    for (const c of corners) {
      const p = await mapPoint(win, epsg, c[0], c[1]);
      // a handle of the line or a control over the corner keeps the pointer: not a click on the map
      if (!p.onCanvas) continue;
      await win.mouse.move(p.x + 40, p.y + 40);
      await win.mouse.move(p.x, p.y, { steps: 3 });
      // the hover is handled once a frame: read the tag after the frames of this last move
      await win.evaluate(
        () =>
          new Promise<void>((done) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                done();
              });
            });
          }),
      );
      const snapped = await tag.isVisible();
      if (snapped) {
        at = p;
        break;
      }
    }
  }
  if (!at) throw new Error("no corner of the other pile came within reach of the open pile's line");
  await expect(tag).toHaveAttribute('data-key', `pile:${SP1_ID}`);

  // the click is the other pile's: it opens, and the line it was near is not pinned
  await win.mouse.click(at.x, at.y);
  await expect(selectedPile(win)).toHaveAttribute('data-id', other.id, { timeout: 30_000 });
  await expect(selectedPile(win).getByTestId('pile-name')).toHaveText(other.label);
  await expect(mapPin(win)).toBeHidden();
});

test('with one pile open on the Map, the cut and fill legend names the pile and its own sides', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(720_000);
  const panel = await pileOpened(win, quarryProject);
  await stageMode(win, 'Map');
  await mapThere(win);
  await showSurface(win, 'Cut & fill');
  const legend = win.locator('.stage-slot [data-testid="cutfill-legend"]');
  await expect(legend).toBeVisible({ timeout: 240_000 });
  // the map draws the open pile's own heat map: the legend is of that
  await expect(legend).toHaveAttribute('data-own', SP1_ID, { timeout: 120_000 });
  const title = legend.locator('.cf-legend-title');
  await expect(title).toContainText(SP1);
  await expect(title).toContainText(' minus ');
  await expect(title).not.toContainText('Height change');
  await expect(legend).toHaveAttribute('aria-label', new RegExp(`^${SP1}: `));

  // the pile let go: the whole site between the compare pair again
  await openSection(win, 'selection');
  await expect(panel).toBeVisible();
  await panel.getByTestId('pile-back').click();
  await expect(selectedPile(win)).toHaveCount(0);
  await expect(legend).not.toHaveAttribute('data-own', /./);
  await expect(title).toContainText(/^Height change .+ minus .+/);
  await expect(title).not.toContainText(SP1);
});

test('with the larger chart window open, a fly on the Map lands the point above the window', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(720_000);
  const panel = await pileOpened(win, quarryProject);
  await stageMode(win, 'Map');
  await mapThere(win);
  await profileShown(panel);
  await panel.getByTestId('pile-open-larger').scrollIntoViewIfNeeded();
  await panel.getByTestId('pile-open-larger').click();
  const big = win.getByTestId('section-window');
  await expect(big).toBeVisible();
  const chart = big.getByTestId('section-window-chart');
  await expect(chart.locator('polyline[data-series]').first()).toBeAttached({ timeout: 120_000 });
  await mapStill(win);

  // a double-click on the chart pins the point and flies to it
  const box = await chart.locator('svg.pc-svg').boundingBox();
  if (!box) throw new Error('no chart');
  await win.mouse.dblclick(box.x + box.width * 0.7, box.y + Math.min(box.height / 2, 40));
  await expect(chart.getByTestId('chart-pin-badge')).toBeVisible();
  const pin = mapPin(win);
  await expect(pin).toBeVisible();
  await mapStill(win);

  // where the map and the window are: the window covers the map's lower part
  const view = await win.evaluate(() => {
    type MapEl = Element & { __aioMap: { getCanvas(): HTMLElement } };
    const el = [...document.querySelectorAll('*')].find((x) => '__aioMap' in x) as MapEl;
    const r = el.__aioMap.getCanvas().getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
  const cover = await big.boundingBox();
  if (!cover) throw new Error('no window');
  expect(cover.y).toBeGreaterThan(view.top);
  expect(cover.y).toBeLessThan(view.bottom);
  const free = cover.y - view.top;
  const middle = view.top + free / 2;
  // The pinned point stands in the middle of the free part (the badge is drawn at the point,
  // a few pixels of its own size aside). The map's own centre lies a fifth of the map's height
  // lower, nearer the window's edge than this allows.
  await expect
    .poll(
      async () => {
        const b = await pin.boundingBox();
        return b ? Math.abs(b.y + b.height / 2 - middle) : Number.POSITIVE_INFINITY;
      },
      { timeout: 15_000 },
    )
    .toBeLessThan(free * 0.2);
  const b = await pin.boundingBox();
  if (!b) throw new Error('no pin');
  expect(b.x + b.width / 2).toBeGreaterThan(view.left);
  expect(b.x + b.width / 2).toBeLessThan(view.right);
  // and nothing of the window is over it
  expect(b.y + b.height).toBeLessThan(cover.y);
});
