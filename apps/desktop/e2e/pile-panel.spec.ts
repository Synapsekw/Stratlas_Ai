/**
 * The pile panel (volumetrics redesign, spec section 3, Stage B) in the real app, on the synthetic
 * quarry demo: three monthly surveys, prepared quietly on open (`autoPrepareSurfaces`). A pile
 * opens in its panel in the right panel's Selection tab wherever it is picked: an Inventory row,
 * its body in 3D, its outline on the Map, its sidebar row, each with "Back to inventory" there,
 * which lets the pile go and shows Project > Volumes (Esc lets it go too), with the right
 * workbench folded too.
 * The panel shows the pile's volume, tonnes and change against the demo's `truth.json`; Profile
 * has a chip per survey and the chart along the pile's long axis, whose point shows on the line in
 * 3D and whose ends can be moved and whose line can be turned there with the mouse, the chart
 * following; Edit boundary from the pile's menu in 3D takes a corner dragged with the mouse, and
 * the volume follows; History has one row per survey; Esc lets the pile go. A
 * distance line drawn across a pile is picked as the line, the pile's body beside it opens the
 * pile. The panel's floats leave the view free at 1100 x 700. Off-screen, zero network, pipeline
 * Python needed.
 */
import { toWgs84 } from '@aio/geo';
import { MeasurementsFile, ProjectManifest } from '@aio/schema';
import type { Locator, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { measureTree, selectMeasure, stageMode, volumesView } from './island';
import { openSection, panelTab } from './panel';
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
 * line's last point): the label's own translate, read off its layer. The anchor is there while the
 * label is in view, also when a closer label has it waiting for hover (`labelDeclutter`).
 */
async function labelAnchor3d(win: Page, id: string): Promise<Pt> {
  const label = win.locator(`[data-scene-view] .sv-labels .sv-label[data-id="${id}"]`).first();
  await expect(label).toBeAttached({ timeout: 30_000 });
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
  // every survey prepared and its figures worked out: the dates strip draws the site on each
  const strip = win.getByRole('region', { name: 'Dates strip' });
  await expect(strip.locator('[data-survey][data-state="ready"]')).toHaveCount(DATES.length, {
    timeout: 360_000,
  });
  await expect(strip.locator('circle.ds-dot')).toHaveCount(DATES.length, { timeout: 240_000 });
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

  const panel = win.getByTestId('pile-panel');
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
  // opened from the inventory, the panel sits in Selection and offers the way back; a step with
  // the arrows kept it
  await expect(panelTab(win, 'selection')).toHaveAttribute('aria-selected', 'true');
  await expect(win.getByTestId('volumes-view').getByTestId('pile-panel')).toHaveCount(0);
  const back = panel.getByTestId('pile-back');
  await expect(back).toHaveText('Back to inventory');
  // it lets the pile go and returns to Project > Volumes, the list as it was
  await back.click();
  await expect(win.getByTestId('pile-panel')).toHaveCount(0);
  await expect(panelTab(win, 'project')).toHaveAttribute('aria-selected', 'true');
  const list = win.getByTestId('volumes-view');
  await expect(list).toBeVisible();
  await expect(list.getByTestId('volumes-pile')).toHaveCount(4);
  // nothing is selected any more
  await openSection(win, 'selection');
  await expect(win.getByTestId('selection-empty')).toBeVisible();

  // the link is there whichever way the pile was opened: from the inventory, then picked in the
  // left sidebar, the same pile still says "Back to inventory", and it goes there
  await (await volumesView(win)).getByTestId('volumes-pile').filter({ hasText: SP1 }).click();
  await expect(panel.getByTestId('pile-back')).toHaveText('Back to inventory');
  await measureTree(win);
  await selectMeasure(win, SP1);
  await expect(panel).toHaveAttribute('data-id', SP1_ID);
  await expect(panel.getByTestId('pile-back')).toHaveText('Back to inventory');
  await panel.getByTestId('pile-back').click();
  await expect(win.getByTestId('pile-panel')).toHaveCount(0);
  await expect(panelTab(win, 'project')).toHaveAttribute('aria-selected', 'true');
  await expect(win.getByTestId('volumes-view')).toBeVisible();
});

test('a click on the pile in 3D and on its outline in Map opens the same panel', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  await opened(win, quarryProject);
  const panel = win.getByTestId('pile-panel');
  await expect(panel).toHaveCount(0);

  // 3D: the pile's body, at its label's anchor (the outline's centroid)
  const body = await labelAnchor3d(win, SP1_ID);
  await win.mouse.click(body.x, body.y);
  await expect(panel).toHaveAttribute('data-id', SP1_ID);
  // the same panel in the same place, Selection, with its link to the inventory; Esc on the view
  // lets the pile go and stays in Selection
  await expect(panelTab(win, 'selection')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByTestId('pile-back')).toHaveText('Back to inventory');
  await win.keyboard.press('Escape');
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
  // from the Map too: Selection, and the link, which lets the pile go and shows Project > Volumes
  await expect(panelTab(win, 'selection')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByTestId('pile-back')).toHaveText('Back to inventory');
  await panel.getByTestId('pile-back').click();
  await expect(panel).toHaveCount(0);
  await expect(panelTab(win, 'project')).toHaveAttribute('aria-selected', 'true');
  await expect(win.getByTestId('volumes-view').getByTestId('volumes-pile')).toHaveCount(4);
});

/** Where the pile look's screenshots go (`PILE_SHOTS`); none taken without it. */
const SHOTS = process.env.PILE_SHOTS;

/** Wait until a measurement's label stops moving: the camera has settled. */
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
      { intervals: [500], timeout: 30_000 },
    )
    .toBe(true);
  return labelAnchor3d(win, id);
}

test('an opened pile shows as its glass box, framed, Solid or Height, and Edit boundary from its menu', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  const view = await opened(win, quarryProject);
  const scene = win.locator('[data-scene-view]').first();
  // the whole site at first: the box is for an opened pile only
  await expect(win.locator('[data-pile-look]')).toHaveCount(0);

  await view.getByTestId('volumes-pile').filter({ hasText: SP1 }).click();
  const panel = win.getByTestId('pile-panel');
  await expect(panel).toHaveAttribute('data-id', SP1_ID);
  // the box drawn in place of the pile's outline, solid red
  const box = win.locator(`[data-pile-look="${SP1_ID}"]`);
  await expect(box).toHaveCount(1, { timeout: 60_000 });
  await expect(box).toHaveAttribute('data-pile-surface', 'solid');

  // the camera framed it: the pile's middle near the middle of the view
  const at = await settled(win, SP1_ID);
  const r = await scene.boundingBox();
  if (!r) throw new Error('no scene view');
  expect(Math.abs(at.x - (r.x + r.width / 2))).toBeLessThan(r.width * 0.3);
  expect(Math.abs(at.y - (r.y + r.height / 2))).toBeLessThan(r.height * 0.3);
  if (SHOTS) await scene.screenshot({ path: join(SHOTS, 'final-solid.png') });

  // Surface: Height colours the top by height above the base, with its legend
  const surface = panel.getByTestId('pile-surface');
  await expect(surface.getByTestId('pile-surface-solid')).toHaveAttribute('aria-pressed', 'true');
  await surface.getByTestId('pile-surface-height').click();
  await expect(surface.getByTestId('pile-surface-height')).toHaveAttribute('aria-pressed', 'true');
  await expect(box).toHaveAttribute('data-pile-surface', 'height');
  const legend = win.getByTestId('pile-height-legend');
  await expect(legend).toBeVisible();
  await expect(legend).toContainText('Height above base');
  await expect(legend).toContainText(/0\.0 m/);
  if (SHOTS) await scene.screenshot({ path: join(SHOTS, 'final-height.png') });
  // the legend never takes the view's clicks
  const lb = await legend.boundingBox();
  if (!lb) throw new Error('no legend');
  expect(
    await win.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [
      lb.x + lb.width / 2,
      lb.y + lb.height / 2,
    ] as const),
  ).toBe('CANVAS');
  await surface.getByTestId('pile-surface-solid').click();
  await expect(legend).toHaveCount(0);
  await expect(box).toHaveAttribute('data-pile-surface', 'solid');

  // a click on it in 3D, in view: the camera stays
  const before = await settled(win, SP1_ID);
  await win.mouse.click(before.x, before.y);
  await expect(panel).toHaveAttribute('data-id', SP1_ID);
  await win.waitForTimeout(1_500);
  const after = await settled(win, SP1_ID);
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(3);

  // right-click on the box: Edit boundary enters the vertex edit of its outline
  await win.mouse.click(after.x, after.y, { button: 'right' });
  const menu = win.getByTestId('measure-menu');
  await expect(menu).toBeVisible();
  const edit = menu.getByRole('menuitem', { name: 'Edit boundary' });
  await expect(edit).toBeEnabled();
  if (SHOTS) await win.screenshot({ path: join(SHOTS, 'final-menu.png') });
  await edit.click();
  await expect(panel.getByTestId('pile-editing')).toBeVisible();
  // the box makes way for the outline and its handles
  await expect(box).toHaveCount(0);
  if (SHOTS) await scene.screenshot({ path: join(SHOTS, 'final-edit.png') });
  await panel.getByTestId('pile-edit-done').click();
  await expect(panel.getByTestId('pile-editing')).toHaveCount(0);
  await expect(box).toHaveCount(1, { timeout: 30_000 });

  if (SHOTS) {
    // a wide view: the other piles keep their outline, label and light fill
    const c = await settled(win, SP1_ID);
    await win.mouse.move(c.x, c.y);
    for (let i = 0; i < 5; i += 1) await win.mouse.wheel(0, 500);
    await win.waitForTimeout(2_500);
    await win.screenshot({ path: join(SHOTS, 'final-wide.png') });
  }
});

/** The live 3D view, as the app hands it to the specs (`bootstrap.ts`, `__stratlas`). */
interface Probe {
  __stratlas: {
    stage(): {
      camera: {
        updateMatrixWorld(): void;
        position: {
          clone(): {
            set(
              x: number,
              y: number,
              z: number,
            ): { project(c: unknown): { x: number; y: number; z: number } };
          };
        };
      };
      renderer: { domElement: HTMLCanvasElement };
    } | null;
  };
}

/**
 * The page point of a site point (E, N, Z) in the 3D view, and whether the view's own canvas is
 * what a pointer meets there. The scene's frame is the project's origin (`projectToLocal`).
 */
async function scenePoint(
  win: Page,
  origin: readonly number[],
  p: readonly [number, number, number],
): Promise<Pt & { onCanvas: boolean }> {
  const local: [number, number, number] = [
    p[0] - (origin[0] ?? 0),
    p[2] - (origin[2] ?? 0),
    (origin[1] ?? 0) - p[1],
  ];
  return win.evaluate((l) => {
    const st = (window as unknown as Probe).__stratlas.stage();
    if (!st) throw new Error('no stage');
    st.camera.updateMatrixWorld();
    const v = st.camera.position.clone().set(l[0], l[1], l[2]).project(st.camera);
    const canvas = st.renderer.domElement;
    const r = canvas.getBoundingClientRect();
    const at = { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    return { ...at, onCanvas: v.z <= 1 && document.elementFromPoint(at.x, at.y) === canvas };
  }, local);
}

async function originOf(p: SurveyDemoProject): Promise<number[]> {
  const m = ProjectManifest.parse(JSON.parse(await readFile(join(p.dir, 'manifest.json'), 'utf8')));
  return [...m.origin];
}

/** Press on `from`, move to `to` in small steps as a hand does, and let go. */
async function drag(win: Page, from: Pt, to: Pt): Promise<void> {
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  await win.mouse.move(to.x, to.y, { steps: 10 });
  await win.mouse.up();
}

test('Edit boundary from the menu in 3D: a corner dragged with the mouse changes the volume, and Done brings the glass box back', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(720_000);
  const view = await opened(win, quarryProject);
  await view.getByTestId('volumes-pile').filter({ hasText: SP1 }).click();
  const panel = win.getByTestId('pile-panel');
  await expect(panel).toHaveAttribute('data-id', SP1_ID);
  await figuresIn(panel);
  const box = win.locator(`[data-pile-look="${SP1_ID}"]`);
  await expect(box).toHaveCount(1, { timeout: 60_000 });
  const volume = panel.getByTestId('pile-kpi-volume').locator('b');
  await expect(panel.getByTestId('pile-status')).toHaveCount(0, { timeout: 120_000 });
  const before = figure(await volume.innerText());
  const footprint = figure(await panel.getByTestId('pile-footprint').innerText());

  // right-click the pile in 3D, Edit boundary: its outline with a handle on every corner
  const middle = await settled(win, SP1_ID);
  await win.mouse.click(middle.x, middle.y, { button: 'right' });
  const menu = win.getByTestId('measure-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Edit boundary' }).click();
  await expect(panel.getByTestId('pile-editing')).toBeVisible();
  await expect(box).toHaveCount(0);

  // a corner that is free in the view, and the point 45 % of the way to the pile's middle: the
  // drag cuts that corner of the pile off
  const ring = await outline(quarryProject, SP1_ID);
  const origin = await originOf(quarryProject);
  const centre = await settled(win, SP1_ID);
  let grab: { from: Pt; to: Pt } | null = null;
  for (const corner of ring) {
    const from = await scenePoint(win, origin, corner);
    const to = {
      x: from.x + (centre.x - from.x) * 0.45,
      y: from.y + (centre.y - from.y) * 0.45,
    };
    const free = await win.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS',
      [to.x, to.y] as const,
    );
    if (from.onCanvas && free && Math.hypot(to.x - from.x, to.y - from.y) > 12) {
      grab = { from, to };
      break;
    }
  }
  if (!grab) throw new Error('no corner of the pile is free in the view');
  await drag(win, grab.from, grab.to);
  // the drag was the corner's, not the camera's: the pile's middle is where it was on screen,
  // give or take the moved corner's pull on the centroid
  const after = await settled(win, SP1_ID);
  expect(Math.hypot(after.x - centre.x, after.y - centre.y)).toBeLessThan(
    Math.hypot(grab.to.x - grab.from.x, grab.to.y - grab.from.y),
  );

  // Done: the box is back, and the pile's figures are the smaller outline's
  await panel.getByTestId('pile-edit-done').click();
  await expect(panel.getByTestId('pile-editing')).toHaveCount(0);
  await expect(box).toHaveCount(1, { timeout: 30_000 });
  await expect
    .poll(async () => figure(await panel.getByTestId('pile-footprint').innerText()), {
      timeout: 60_000,
    })
    .toBeLessThan(footprint - 1);
  await expect
    .poll(async () => figure(await volume.innerText()), { timeout: 240_000 })
    .toBeLessThan(before - 1);
  await expect(panel.getByTestId('pile-status')).toHaveCount(0, { timeout: 240_000 });
  expect(figure(await volume.innerText())).toBeLessThan(before - 1);
});

test('the A, B and turn handles dragged in the scene with the mouse: the chart follows each', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(720_000);
  const view = await opened(win, quarryProject);
  await view.getByTestId('volumes-pile').filter({ hasText: SP1 }).click();
  const panel = win.getByTestId('pile-panel');
  await figuresIn(panel);
  await panel.getByTestId('pile-tab-profile').click();
  const profile = panel.getByTestId('pile-profile');
  const chart = profile.getByTestId('pile-profile-chart');
  await expect(chart).toBeVisible({ timeout: 120_000 });
  const series = chart.locator('polyline[data-series]').first();
  await expect(series).toBeAttached({ timeout: 120_000 });
  await settled(win, SP1_ID);

  const handle = (h: 'a' | 'b' | 'turn'): Locator =>
    win.locator(`[data-scene-view] [data-testid="pile-axis-${h}"]`).first();
  const centreOf = async (h: 'a' | 'b' | 'turn'): Promise<Pt> => {
    await expect(handle(h)).toBeVisible();
    const b = await handle(h).boundingBox();
    if (!b) throw new Error(`no ${h} handle`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const lengthM = async (): Promise<number> =>
    figure(await profile.getByTestId('pile-line').innerText());
  const drawn = (): Promise<string | null> => series.getAttribute('points');
  /** The chart has taken the line as it is now: its length said, its profile drawn anew. */
  const chartMoved = async (was: { length: number; points: string | null }, grew: boolean) => {
    if (grew) await expect.poll(lengthM, { timeout: 30_000 }).toBeGreaterThan(was.length + 1);
    await expect.poll(drawn, { timeout: 60_000 }).not.toBe(was.points);
  };

  // A dragged out along the line, away from B: the line is longer, and the chart is of that line
  let was = { length: await lengthM(), points: await drawn() };
  let a = await centreOf('a');
  let b = await centreOf('b');
  let len = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  await drag(win, a, { x: a.x + ((a.x - b.x) / len) * 40, y: a.y + ((a.y - b.y) / len) * 40 });
  await chartMoved(was, true);
  // the handle stands where it was let go, not where it was grabbed
  const a0 = a;
  await expect
    .poll(async () => {
      const now = await centreOf('a');
      return Math.hypot(now.x - a0.x, now.y - a0.y);
    })
    .toBeGreaterThan(20);

  // B dragged out the other way: longer again
  was = { length: await lengthM(), points: await drawn() };
  a = await centreOf('a');
  b = await centreOf('b');
  len = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  await drag(win, b, { x: b.x + ((b.x - a.x) / len) * 40, y: b.y + ((b.y - a.y) / len) * 40 });
  await chartMoved(was, true);
  const b0 = b;
  await expect
    .poll(async () => {
      const now = await centreOf('b');
      return Math.hypot(now.x - b0.x, now.y - b0.y);
    })
    .toBeGreaterThan(20);

  // the turn handle, grabbed at the line's middle, taken out towards B and swept a sixth of a
  // turn about the middle: the line turns with it (its ends leave where they stood) and the
  // chart is the profile along the turned line
  was = { length: await lengthM(), points: await drawn() };
  const a1 = await centreOf('a');
  const b1 = await centreOf('b');
  const c = await centreOf('turn');
  const reach = Math.max(60, Math.hypot(b1.x - c.x, b1.y - c.y) * 0.5);
  const start = Math.atan2(b1.y - c.y, b1.x - c.x);
  await win.mouse.move(c.x, c.y);
  await win.mouse.down();
  for (let k = 0; k <= 6; k += 1) {
    const angle = start + (k * Math.PI) / 18;
    await win.mouse.move(c.x + reach * Math.cos(angle), c.y + reach * Math.sin(angle), {
      steps: 4,
    });
  }
  await win.mouse.up();
  await chartMoved(was, false);
  await expect
    .poll(async () => {
      const [na, nb] = [await centreOf('a'), await centreOf('b')];
      return Math.min(Math.hypot(na.x - a1.x, na.y - a1.y), Math.hypot(nb.x - b1.x, nb.y - b1.y));
    })
    .toBeGreaterThan(10);
  // the pile is still the open one, on its Profile: no drag fell through to the view
  await expect(panel).toHaveAttribute('data-id', SP1_ID);
  await expect(chart).toBeVisible();
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
  // The folded workbench shows the panel in its drawer, and one Esc does one thing: on the panel
  // it closes the drawer and hands the focus to the island, the pile still picked; the next Esc
  // lets the pile go. Then from the sidebar's row too
  await expect(win.locator('.ws.right-off')).toHaveCount(1);
  await panel.getByTestId('pile-tab-overview').focus();
  await win.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(win.getByTestId('stage-hint')).toHaveAttribute('data-kind', 'pile');
  await win.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(win.getByTestId('stage-hint')).toHaveCount(0);
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
  const panel = win.getByTestId('pile-panel');
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
  // (the panel's head has the Surface choice too: the chart may sit below the fold at 720 px)
  await chart.locator('svg.pc-svg').scrollIntoViewIfNeeded();
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

test('Esc lets the pile go', async ({ quarryProject, win }) => {
  test.setTimeout(600_000);
  const view = await opened(win, quarryProject);
  await view.getByTestId('volumes-pile').filter({ hasText: SP1 }).click();
  const panel = win.getByTestId('pile-panel');
  await expect(panel).toBeVisible();
  await expect(win.getByTestId('stage-hint')).toHaveAttribute('data-kind', 'pile');
  await panel.getByTestId('pile-tab-overview').focus();
  await win.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(win.getByTestId('selection-empty')).toBeVisible();
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

  await opened(win, quarryProject);
  // the line, at its north end (its label's anchor): selected for the Measure tab, no pile panel
  const end = await labelAnchor3d(win, 'line-sp1');
  await win.mouse.click(end.x, end.y);
  await expect(
    win.getByTestId('survey-panel').getByRole('textbox', { name: 'Rename' }),
  ).toHaveValue('Line across SP1');
  await expect(win.getByTestId('pile-panel')).toHaveCount(0);

  // the pile's body, at its centre (20 m off the line): the pile panel
  // zoomed in on the pile first: at the whole-site view on a stage shortened by the dates strip,
  // its centre lies within the line's snap (a click there pins the line's point); close up, the
  // 20 m between them are many pixels
  const far = await labelAnchor3d(win, SP1_ID);
  await win.mouse.move(far.x, far.y);
  for (let i = 0; i < 4; i += 1) await win.mouse.wheel(0, -400);
  let last = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await labelAnchor3d(win, SP1_ID));
        const still = now === last;
        last = now;
        return still;
      },
      { intervals: [400], timeout: 30_000 },
    )
    .toBe(true);
  const body = await labelAnchor3d(win, SP1_ID);
  const lineEnd = await labelAnchor3d(win, 'line-sp1');
  expect(Math.hypot(lineEnd.x - body.x, lineEnd.y - body.y)).toBeGreaterThan(
    Math.hypot(end.x - far.x, end.y - far.y),
  );
  await win.mouse.click(body.x, body.y);
  await expect(win.getByTestId('pile-panel')).toHaveAttribute('data-id', SP1_ID);

  // and the line from the tree still goes to the Measure tab
  await measureTree(win, 'm3');
  await selectMeasure(win, 'Line across SP1');
  await expect(
    win.getByTestId('survey-panel').getByRole('textbox', { name: 'Rename' }),
  ).toHaveValue('Line across SP1');
});

test('Open larger opens one section window, and closing it leaves none', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  const view = await opened(win, quarryProject);
  await view.getByTestId('volumes-pile').filter({ hasText: SP1 }).click();
  const panel = win.getByTestId('pile-panel');
  await figuresIn(panel);
  await panel.getByTestId('pile-tab-profile').click();
  await expect(panel.getByTestId('pile-profile-chart')).toBeVisible({ timeout: 120_000 });
  // in view as the tab opens: found without scrolling
  await expect(panel.getByTestId('pile-open-larger')).toBeInViewport({ ratio: 1 });
  await panel.getByTestId('pile-open-larger').click();
  await expect(win.locator('.sec-window')).toHaveCount(1);
  // the window alone: the dock does not wait under it to show once the window closes
  await expect(win.getByTestId('section-dock')).toHaveCount(0);
  await win.getByTestId('section-window-close').click();
  await expect(win.locator('.sec-window')).toHaveCount(0);
  await expect(win.getByTestId('section-dock')).toHaveCount(0);
});

test('Profile and History show their actions without scrolling', async ({ quarryProject, win }) => {
  test.setTimeout(600_000);
  const view = await opened(win, quarryProject);
  await view.getByTestId('volumes-pile').filter({ hasText: SP1 }).click();
  const panel = win.getByTestId('pile-panel');
  await figuresIn(panel);
  // the Selection tab's scroll box, at its top as the pile opens. The test never scrolls it: at
  // this height the panel's head fills it, and a picked tab brings its own first row into view
  const scroller = win.locator('.right #wb-panel-selection > .wb-panel-scroll');
  await expect(scroller).toHaveCount(1);
  expect(await scroller.evaluate((el) => [el.scrollLeft, el.scrollTop])).toEqual([0, 0]);
  const port = await scroller.boundingBox();
  if (!port) throw new Error('no scroll box');
  /** Within the scroll box from side to side: nothing to scroll sideways for. */
  const inWidth = async (id: string) => {
    const box = await panel.getByTestId(id).boundingBox();
    if (!box) throw new Error(`no ${id}`);
    expect(box.x, id).toBeGreaterThanOrEqual(port.x);
    expect(box.x + box.width, id).toBeLessThanOrEqual(port.x + port.width);
    return box;
  };

  // Profile: Open larger, Export PNG and Add to report lead the tab, whole in view as it opens
  await panel.getByTestId('pile-tab-profile').click();
  for (const id of ['pile-open-larger', 'pile-profile-png']) {
    await expect(panel.getByTestId(id), id).toBeInViewport({ ratio: 1 });
    await inWidth(id);
  }
  // in a panel this narrow the third wraps under the two: in view too
  await expect(panel.getByTestId('pile-profile-report')).toBeInViewport();
  await inWidth('pile-profile-report');
  // above the chips and the chart
  await expect(panel.getByTestId('pile-profile-chart')).toBeVisible({ timeout: 120_000 });
  const larger = await inWidth('pile-open-larger');
  const chips = await panel.getByTestId('pile-chips').boundingBox();
  const chart = await panel.getByTestId('pile-profile-chart').boundingBox();
  if (!chips || !chart) throw new Error('no Profile chart');
  expect(larger.y + larger.height).toBeLessThanOrEqual(chips.y);
  expect(larger.y + larger.height).toBeLessThanOrEqual(chart.y);
  await expect(panel.getByTestId('pile-open-larger')).toBeInViewport({ ratio: 1 });

  // History: Export CSV beside the m³ | t | Both switch on the tab's first line, whole in view as
  // it opens and within the panel from side to side (the table under it is wider than the panel)
  await panel.getByTestId('pile-tab-history').click();
  const csv = panel.getByTestId('pile-history-csv');
  await expect(csv).toBeInViewport({ ratio: 1 });
  await expect(csv).toBeEnabled();
  await expect(csv).toHaveText('Export CSV');
  await expect(panel.getByTestId('pile-history-unit')).toBeInViewport({ ratio: 1 });
  const unit = await inWidth('pile-history-unit');
  const button = await inWidth('pile-history-csv');
  const table = await panel.getByTestId('pile-history-table').boundingBox();
  if (!table) throw new Error('no History table');
  // one line, the switch first
  expect(Math.abs(unit.y + unit.height / 2 - (button.y + button.height / 2))).toBeLessThan(3);
  expect(unit.x + unit.width).toBeLessThanOrEqual(button.x);
  expect(button.y + button.height).toBeLessThanOrEqual(table.y);
  // never sideways: the panel moved down only
  expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(0);
  // a pile with figures never shows the "no volume yet" line
  await expect(panel.getByTestId('pile-history-none')).toHaveCount(0);
});

test('a volume outline with no volume yet says so in History, and Recompute works it out', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  // the first pile's outline again as a volume with no comparison yet: nothing computed for it
  const mfile = join(quarryProject.dir, 'survey', 'measurements.json');
  const file = MeasurementsFile.parse(JSON.parse(await readFile(mfile, 'utf8')));
  const sp1 = file.measurements.find((x) => x.id === SP1_ID);
  if (!sp1) throw new Error('no first pile');
  const bare = { ...sp1, id: 'bare-outline', label: 'Bare outline', items: [], results: [] };
  delete bare.series;
  delete bare.previousResults;
  file.measurements.push(bare);
  await writeFile(mfile, JSON.stringify(MeasurementsFile.parse(file), null, 1));

  await openDemo(win, quarryProject.name, quarryProject.id);
  const view = await volumesView(win);
  await expect(view.getByTestId('volumes-pile')).toHaveCount(5, { timeout: 60_000 });
  // every survey prepared: Recompute has surfaces to work on
  const strip = win.getByRole('region', { name: 'Dates strip' });
  await expect(strip.locator('[data-survey][data-state="ready"]')).toHaveCount(DATES.length, {
    timeout: 360_000,
  });
  await view.getByTestId('volumes-pile').filter({ hasText: 'Bare outline' }).click();
  const panel = win.getByTestId('pile-panel');
  await expect(panel).toHaveAttribute('data-id', 'bare-outline');

  // History says why there is nothing to list or export, in view as the tab opens
  await panel.getByTestId('pile-tab-history').click();
  const none = panel.getByTestId('pile-history-none');
  await expect(none).toHaveText('This pile has no volume yet');
  await expect(none).toBeInViewport();
  await expect(panel.getByTestId('pile-history-table')).toHaveCount(0);
  await expect(panel.getByTestId('pile-history-chart')).toHaveCount(0);
  await expect(panel.getByTestId('pile-history-csv')).toBeDisabled();

  // Recompute, the volume card's own: the default base, then a figure on every survey date
  const recompute = panel.getByTestId('pile-history-recompute');
  await expect(recompute).toHaveText('Recompute');
  await recompute.click();
  await expect(none).toHaveCount(0, { timeout: 60_000 });
  const rows = panel.getByTestId('pile-history-table').locator('tbody tr');
  await expect(rows).toHaveCount(DATES.length);
  await figuresIn(panel);
  await expect(panel.getByTestId('pile-history-csv')).toBeEnabled();
  // the same outline on the same base as the first pile: the same volume
  const truth = (quarryProject.truth as unknown as QuarryTruth).stockpiles.sp1?.dates ?? {};
  await expect
    .poll(async () => figure(await rows.first().locator('td').first().innerText()), {
      timeout: 240_000,
    })
    .toBeGreaterThan(0);
  near(figure(await rows.first().locator('td').first().innerText()), truth.m3?.volumeM3 ?? NaN);
});

test('a pile picked in Project, In this project, Measurements opens in Selection and scrolls with the wheel over its middle', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  await opened(win, quarryProject);
  const list = await openSection(win, 'project', 'project.inThisProject');
  const group = list.getByTestId('wb-section-project-measurements');
  const head = group.locator('.wb-section-head').first();
  await head.scrollIntoViewIfNeeded();
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await group.getByTestId('project-measurement-row').filter({ hasText: SP1 }).click();
  // a picked pile opens in Selection (D2), its panel there
  await expect(panelTab(win, 'selection')).toHaveAttribute('aria-selected', 'true');
  const panel = win.locator('#wb-panel-selection').getByTestId('selection-pile');
  await expect(panel).toBeVisible();
  // the panel's scroller: the Selection tab's scroll box
  const scroller = win.locator('.right #wb-panel-selection > .wb-panel-scroll');
  await expect(scroller).toHaveCount(1);
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
  const box = await panel.boundingBox();
  const port = await scroller.boundingBox();
  if (!box || !port) throw new Error('no panel');
  // the middle of the panel's part in view
  const top = Math.max(box.y, port.y);
  const bottom = Math.min(box.y + box.height, port.y + port.height);
  await win.mouse.move(box.x + box.width / 2, (top + bottom) / 2);
  await win.mouse.wheel(0, 400);
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 5_000 })
    .toBeGreaterThan(100);
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
    const panel = win.getByTestId('pile-panel');
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
