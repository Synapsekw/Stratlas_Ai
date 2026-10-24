/**
 * End to end on the real Masafi stockpile project (19 piles, two surveys): the native volumetric
 * workspace, with the kit's piles opened as volume measurements carrying their delivered figures
 * (volumetric parity W3: the kit's register, base maths and boundary editor are retired; a pile's
 * outline is edited through its measurement's vertices). Runs only where the real data holds
 * projects/masafi (realData.ts); skipped elsewhere. The project is copied to a temporary data root
 * (@realdata), so the conversion written here never touches the real data.
 */
import type { Locator, Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, realDataTest } from './fixtures';
import { islandGroup, islandTool, pickGroupTab, volumesView } from './island';
import { hasRealData, missingRealProject, realProjectDir } from './realData';

const MASAFI = realProjectDir('masafi');

interface Fcn {
  fill: number;
  cut: number;
  net: number;
}
interface VolumesJson {
  piles: { id: string; name: string; epochs: Record<string, { volumes: Record<string, Fcn> }> }[];
}

interface Inspect {
  __stratlas: {
    workspace: {
      getState(): {
        selection: { kind: string; id: string; layer?: string } | null;
        isLayerVisible(id: string): boolean;
      };
    };
    stage(): {
      scene: {
        getObjectByName(n: string): { visible: boolean; children: unknown[] } | undefined;
      };
    } | null;
    volumetric: {
      getState(): {
        status: string;
        selected: string | null;
        elevation?: { ramp: string; hillshade: boolean };
        select(pile: string | null): void;
      };
    };
  };
}

const test = realDataTest(['masafi'], {
  // start from the delivered volumes: edits saved while testing the real project are left out
  include: (rel) => rel !== 'edits',
  // the installed street map pack that covers the yard, when this machine has it
  packs: ['kuwait'],
  size: [1600, 960],
});

test.skip(!hasRealData('projects', 'masafi', 'volumes.json'), missingRealProject('masafi'));
test.setTimeout(180_000);

/**
 * Run a probe in the renderer with the app's inspection hook typed. The probe is sent as a
 * function (no eval in the page) and gets the window and an argument.
 */
async function inspect<T, A>(
  win: Page,
  probe: (x: { w: Inspect; a: A }) => T | Promise<T>,
  arg: A,
): Promise<T> {
  const w = await win.evaluateHandle(() => window);
  try {
    const fn = probe as unknown as (x: { w: Window; a: unknown }) => T | Promise<T>;
    const payload: { w: typeof w; a: unknown } = { w, a: arg };
    return await win.evaluate(fn, payload);
  } finally {
    await w.dispose();
  }
}

/** The project's saved boundary edits as text, or null when there are none. */
function boundariesOf(project: string): string | null {
  const f = join(project, 'edits', 'boundaries.json');
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}

async function openMasafi(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: 'Masafi' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
  await expect
    .poll(() => inspect(win, ({ w }) => w.__stratlas.volumetric.getState().status, null), {
      timeout: 30_000,
    })
    .toBe('ready');
  await expect
    .poll(
      () =>
        inspect(
          win,
          ({ w }) => w.__stratlas.stage()?.scene.getObjectByName('volumetric') !== undefined,
          null,
        ),
      {
        timeout: 30_000,
      },
    )
    .toBe(true);
}

/** The pile's volume body, toe line or base outline is drawn in 3D. */
const pileDrawn = (win: Page, id: string) =>
  inspect(
    win,
    ({ w, a }) => w.__stratlas.stage()?.scene.getObjectByName(`vol:${a}`) !== undefined,
    id,
  );

/** Every callout's text on the 3D stage. */
const calloutText = (win: Page) =>
  win.locator('[data-scene-view] .aio-stage-overlay').first().innerText();

interface Projectable {
  clone(): Projectable;
  applyMatrix4(m: unknown): Projectable;
  project(camera: unknown): { x: number; y: number };
}

/** Client coordinates of the middle of a scene node (a pile on the terrain). */
async function pileOnScreen(win: Page, node: string): Promise<{ x: number; y: number }> {
  const ndc = await inspect(
    win,
    ({ w, a }) => {
      const stage = w.__stratlas.stage() as unknown as {
        camera: unknown;
        scene: { getObjectByName(n: string): unknown };
      };
      const root = stage.scene.getObjectByName(a) as
        { traverse(cb: (o: unknown) => void): void } | undefined;
      const found: { x: number; y: number }[] = [];
      root?.traverse((o) => {
        const m = o as {
          isMesh?: boolean;
          matrixWorld: unknown;
          geometry?: {
            boundingSphere: { center: Projectable } | null;
            computeBoundingSphere(): void;
          };
        };
        if (found.length || !m.isMesh || !m.geometry) return;
        if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
        const c = m.geometry.boundingSphere?.center;
        if (c) found.push(c.clone().applyMatrix4(m.matrixWorld).project(stage.camera));
      });
      const p = found[0];
      return p ? { x: p.x, y: p.y } : null;
    },
    node,
  );
  const box = await win.locator('[data-scene-view] canvas').boundingBox();
  if (!ndc || !box) throw new Error(`${node} is not on screen`);
  return { x: box.x + ((ndc.x + 1) / 2) * box.width, y: box.y + ((1 - ndc.y) / 2) * box.height };
}

/** A number the app shows ("11,379.4 m³"): its first figure. */
const figure = (text: string): number => {
  const m = /-?[\d ,]*\d(?:\.\d+)?/.exec(text.replaceAll(String.fromCharCode(0xa0), ' '));
  return Number((m?.[0] ?? 'NaN').replace(/[ ,]/g, ''));
};

/** A pile's live card in the Volumes view, by its kit name. */
const pileCard = (view: Locator, name: string) =>
  view.getByTestId('volumes-pile').filter({ has: view.page().getByText(name, { exact: true }) });

/** Select a pile in the volumetric workspace, as a click on it in 3D does. */
const selectPile = (win: Page, pile: string | null) =>
  inspect(
    win,
    ({ w, a }) => {
      w.__stratlas.volumetric.getState().select(a);
    },
    pile,
  );

test('@realdata the stockpile project: piles as volume measurements, 3D selection, surfaces and section', async ({
  win,
}) => {
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await openMasafi(win);
  const vols = JSON.parse(readFileSync(join(MASAFI, 'volumes.json'), 'utf8')) as VolumesJson;
  const p02 = vols.piles.find((p) => p.id === 'P02');
  if (!p02) throw new Error('no P02 in volumes.json');
  const ids = vols.piles.map((p) => p.id);

  // Every kit pile is a volume measurement (volumetric parity W3): 19 in the Volumes view, each
  // with its old figure carried and labelled; the kit's register and base maths are retired.
  const view = await volumesView(win);
  await expect(view.getByTestId('volumes-pile')).toHaveCount(19, { timeout: 30_000 });
  await expect(win.getByTestId('vol-register')).toHaveCount(0);
  await pileCard(view, p02.name || p02.id).click();
  // the pile opens in its panel: the carried figure with its status, both dates in History
  const panel = view.getByTestId('pile-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('pile-status')).toContainText('From an earlier version');
  const shown = (l: Locator) => l.innerText().then((t) => figure(t.replace(/\s/g, ' ')));
  await panel.getByTestId('pile-tab-history').click();
  await expect(panel.getByTestId('pile-history-table').locator('tbody tr')).toHaveCount(2);
  const kpi = await shown(panel.getByTestId('pile-kpi-volume').locator('b'));
  await panel.getByTestId('pile-tab-overview').click();
  // its full card is the Measure tab's
  const card = win.getByTestId('survey-panel');
  await pickGroupTab(win, 'measure', card.getByTestId('card-primary'));
  // the pile's card never holds the window: it reads no terrain (a pile shows no terrain row), and
  // a card that does reads it off the render; the next frame comes at once, not minutes later
  const frameMs = await win.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const t0 = performance.now();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve(performance.now() - t0);
          });
        });
      }),
  );
  expect(frameMs).toBeLessThan(2_000);
  await expect(card.getByTestId('survey-cmp-status').first()).toHaveText(
    'From an earlier version (kit, Triangulated)',
  );
  // the delivered figure on the triangulated toe: 11,379 m³ on 10 Jan 2021, 14,687 m³ on 31 Dec
  const latest = p02.epochs.e2?.volumes.tin?.net ?? Number.NaN;
  const earlier = p02.epochs.e1?.volumes.tin?.net ?? Number.NaN;
  expect(Math.round(latest)).toBe(11_379);
  const primary = await card.getByTestId('card-primary').locator('.mc-value').innerText();
  expect(Math.abs(figure(primary) - latest)).toBeLessThan(0.5);
  expect(Math.abs(kpi - latest)).toBeLessThan(0.5);
  const rows = card.getByTestId('vol-time-table').locator('tbody tr');
  await expect(rows).toHaveCount(2);
  expect(
    Math.abs(figure(await rows.nth(0).locator('td').first().innerText()) - earlier),
  ).toBeLessThan(0.5);
  expect(
    Math.abs(figure(await rows.nth(1).locator('td').first().innerText()) - latest),
  ).toBeLessThan(0.5);
  // no surfaces prepared here: nothing to recompute with, and no area split for a carried figure
  await expect(card.getByTestId('survey-recompute')).toHaveCount(0);
  await expect(card.getByTestId('vol-method')).toHaveCount(0);

  // By default no pile is drawn in 3D: no bodies, toe lines or volume callouts.
  await selectPile(win, null);
  for (const id of ids) expect(await pileDrawn(win, id)).toBe(false);
  expect(await calloutText(win)).not.toContain('m³');
  // the survey's flat ortho is not drawn in 3D (its terrain carries the photo), the map has it
  expect(
    await inspect(
      win,
      ({ w }) => [
        w.__stratlas.workspace.getState().isLayerVisible('ortho-2021-01-10'),
        w.__stratlas.stage()?.scene.getObjectByName('layer:ortho-2021-01-10')?.visible,
      ],
      null,
    ),
  ).toEqual([true, false]);
  // the offline street map lies under the yard
  if (hasRealData('packs', 'kuwait.pmtiles'))
    await expect
      .poll(
        () =>
          inspect(
            win,
            ({ w }) =>
              w.__stratlas.stage()?.scene.getObjectByName('basemap:site-street-map')?.visible ??
              false,
            null,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);

  // Selecting a pile selects its node in 3D and draws its body and base plate (its outline is its
  // volume measurement's: the kit draws no toe line of its own for a measured pile).
  await selectPile(win, 'P02');
  expect(await inspect(win, ({ w }) => w.__stratlas.workspace.getState().selection, null)).toEqual({
    kind: 'asset',
    id: 'P02_e2',
    layer: 'terrain-2021-01-10',
  });
  await expect
    .poll(() =>
      inspect(
        win,
        ({ w }) => {
          const s = w.__stratlas.stage()?.scene;
          const g = s?.getObjectByName('vol:P02') as
            { getObjectByName(n: string): unknown } | undefined;
          return !!g && !!g.getObjectByName('base-plate') && !g.getObjectByName('toe-selected');
        },
        null,
      ),
    )
    .toBe(true);
  // only that pile; its callout reads the measurement's figure, as its card shows it
  expect(await pileDrawn(win, 'P05')).toBe(false);
  await expect.poll(() => calloutText(win)).toContain(primary);

  // Esc hides it again; a click on a pile on the terrain flies to it and reveals it.
  await win.locator('[data-scene-view] canvas').hover();
  await win.keyboard.press('Escape');
  await expect.poll(() => pileDrawn(win, 'P02')).toBe(false);
  expect(
    await inspect(win, ({ w }) => w.__stratlas.volumetric.getState().selected, null),
  ).toBeNull();
  await win.locator('body').press('h'); // whole site
  await win.waitForTimeout(1500);
  const at = await pileOnScreen(win, 'P05_e2');
  await win.mouse.click(at.x, at.y);
  await expect
    .poll(() => inspect(win, ({ w }) => w.__stratlas.volumetric.getState().selected, null))
    .toBe('P05');
  await expect.poll(() => pileDrawn(win, 'P05')).toBe(true);
  await selectPile(win, 'P02');

  // The other survey: its terrain shows, the other hides.
  await (
    await islandGroup(win, 'volumes')
  )
    .locator('.vol-dates button', { hasText: '31 Dec' })
    .click();
  expect(
    await inspect(
      win,
      ({ w }) => {
        const s = w.__stratlas.workspace.getState();
        return [s.isLayerVisible('terrain-2020-12-31'), s.isLayerVisible('terrain-2021-01-10')];
      },
      null,
    ),
  ).toEqual([true, false]);
  await (
    await islandGroup(win, 'volumes')
  )
    .locator('.vol-dates button', { hasText: '10 Jan' })
    .click();

  // Elevation colours drape on the shown survey, from the Volumes workbench.
  const surfaces = async () =>
    (await islandGroup(win, 'volumes')).getByRole('group', { name: 'Surface colours' });
  await (await surfaces()).getByRole('button', { name: 'Elevation' }).click();
  await expect
    .poll(
      () =>
        inspect(
          win,
          ({ w }) => w.__stratlas.stage()?.scene.getObjectByName('drape:e2')?.visible ?? false,
          null,
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  // its ramp, range (metres, auto from the surveys) and hillshade are chosen on the legend
  const elev = win.getByTestId('vol-elev');
  await expect(elev.getByRole('radio', { name: 'Turbo' })).toHaveAttribute('aria-checked', 'true');
  await expect(elev.locator('.ends')).toContainText(' m');
  const drapeKey = () =>
    inspect(
      win,
      ({ w }) => {
        const d = w.__stratlas.stage()?.scene.getObjectByName('drape:e2') as
          { uuid: string } | undefined;
        return d?.uuid ?? null;
      },
      null,
    );
  const first = await drapeKey();
  await elev.getByRole('radio', { name: 'Viridis' }).click();
  await expect.poll(drapeKey, { timeout: 20_000 }).not.toBe(first);
  await expect(elev.getByRole('radio', { name: 'Viridis' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await elev.getByRole('checkbox', { name: 'Hillshade' }).uncheck();
  await expect
    .poll(() =>
      inspect(win, ({ w }) => w.__stratlas.volumetric.getState().elevation?.hillshade, null),
    )
    .toBe(false);
  await elev.getByRole('checkbox', { name: 'Hillshade' }).check();
  await elev.getByRole('radio', { name: 'Turbo' }).click();

  // Cut and fill colours drape on the last survey.
  await (await surfaces()).getByRole('button', { name: 'Cut / fill' }).click();
  await expect
    .poll(
      () =>
        inspect(
          win,
          ({ w }) => w.__stratlas.stage()?.scene.getObjectByName('drape:e2')?.visible ?? false,
          null,
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  await (await surfaces()).getByRole('button', { name: 'Photo' }).click();
  await selectPile(win, null);

  // Swipe shows both surveys.
  await (
    await islandGroup(win, 'volumes')
  )
    .locator('.vol-dates button', { hasText: 'Swipe' })
    .click();
  await expect(win.getByTestId('vol-swipe')).toBeVisible();
  expect(
    await inspect(
      win,
      ({ w }) => {
        const s = w.__stratlas.workspace.getState();
        return [s.isLayerVisible('terrain-2020-12-31'), s.isLayerVisible('terrain-2021-01-10')];
      },
      null,
    ),
  ).toEqual([true, true]);
  await (
    await islandGroup(win, 'volumes')
  )
    .locator('.vol-dates button', { hasText: 'Swipe' })
    .click();

  // Section across the yard: a profile of both surveys with cut and fill areas.
  await win.locator('body').press('h'); // whole site
  await win.waitForTimeout(1200);
  await (await islandTool(win, 'volumes', 'Section line between the surveys')).click();
  const box = await win.locator('[data-scene-view] canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const camera = () =>
    inspect(
      win,
      ({ w }) => {
        const p = (
          w.__stratlas.stage() as unknown as {
            camera: { position: { x: number; y: number; z: number } };
          }
        ).camera.position;
        return [p.x, p.y, p.z].map((v) => Math.round(v * 100) / 100);
      },
      null,
    );
  await win.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.45);
  // after the first point the camera stays put while the mouse moves to the second
  const before = await camera();
  await win.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4, { steps: 12 });
  expect(await camera()).toEqual(before);
  await win.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4);
  // the shared chart's own areas (chart.cutArea, chart.fillArea): 'Cut 42.41 m²', and no second
  // pair of figures under the chart
  const areas = win.getByTestId('vol-section').getByTestId('chart-areas');
  await expect(areas.locator('[data-kind="cut"]')).toHaveText(/^Cut [\d\s,.]+ m²$/, {
    timeout: 20_000,
  });
  await expect(areas.locator('[data-kind="fill"]')).toHaveText(/^Fill [\d\s,.]+ m²$/);
  await expect(win.getByTestId('vol-section').getByText(/^Cut [\d\s,.]+ m²$/)).toHaveCount(1);
  // the section is drawn on the shared profile chart
  await expect(win.getByTestId('vol-section-chart')).toBeVisible();
  expect(
    await inspect(win, ({ w }) => w.__stratlas.volumetric.getState().selected, null),
  ).toBeNull();

  expect(errors).toEqual([]);
});

test('@realdata the stockpile project: volume over time as CSV from the Volumes view; the real data untouched', async ({
  app,
  win,
  realData,
}) => {
  const realMeasurements = join(MASAFI, 'survey', 'measurements.json');
  const realBefore = existsSync(realMeasurements) ? readFileSync(realMeasurements, 'utf8') : null;
  const boundariesBefore = boundariesOf(MASAFI);
  await openMasafi(win);
  const vols = JSON.parse(readFileSync(join(MASAFI, 'volumes.json'), 'utf8')) as VolumesJson;
  const view = await volumesView(win);
  await expect(view.getByTestId('volumes-pile')).toHaveCount(19, { timeout: 30_000 });

  // the copy is converted once and written; the real project never is
  await expect
    .poll(
      async () =>
        (
          JSON.parse(
            await readFile(join(realData.projectDir, 'survey', 'measurements.json'), 'utf8'),
          ) as { kitPilesConverted?: string[] }
        ).kitPilesConverted?.length ?? 0,
      { timeout: 30_000 },
    )
    .toBe(19);

  const target = join(realData.base, 'volumes.csv');
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path });
  }, target);
  await view.getByTestId('volumes-csv').click();
  await expect.poll(() => existsSync(target), { timeout: 30_000 }).toBe(true);
  const csv = await readFile(target, 'utf8');
  for (const p of vols.piles) expect(csv).toContain(p.name || p.id);
  // a row per pile and survey date, each figure marked as carried from the kit
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  expect(lines[0]).toContain('From an earlier version');
  expect(lines).toHaveLength(1 + 19 * 2);
  expect(csv).toContain('2020-12-31');
  expect(csv).toContain('2021-01-10');
  expect(existsSync(realMeasurements) ? readFileSync(realMeasurements, 'utf8') : null).toBe(
    realBefore,
  );
  expect(boundariesOf(MASAFI)).toBe(boundariesBefore);
});
