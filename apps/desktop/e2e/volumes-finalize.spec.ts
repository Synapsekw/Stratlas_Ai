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
 * - A volume drawn in the view with Tools > Measure > Volume is a new pile, listed
 *   with the survey date's measurements and in Project > Volumes, with a volume once Recompute is
 *   pressed; the number beside "Volumes" is the list's.
 * - A pile's base switched to Lowest point and back to Toe surface: the figure follows, the base
 *   has one name in the panel, the inventory and the inventory CSV, and the figure is kept, not
 *   stale, after the project is closed and opened again. The weight calculator says its figure
 *   is not saved; the History CSV and the header's Export are named for volume over time.
 * - Tools > Volumes holds Draw volume and Swipe only; the Reports screen says what each of its two
 *   reports is for.
 *
 * Off-screen, zero network, pipeline Python needed.
 */
import { toWgs84 } from '@aio/geo';
import { MeasurementsFile, ProjectManifest } from '@aio/schema';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import {
  measureControl,
  measureRow,
  measureSaved,
  measureTree,
  showSurface,
  stageMode,
  volumesView,
} from './island';
import { pickBase, volumeSettled } from './measureCard';
import { openSection, selectedPile } from './panel';
import { openDemo } from './surveyJobs';
import type { SurveyDemoProject } from './surveyFixtures';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

const SP1 = 'Stockpile SP1';
const SP1_ID = 'm-sp1';
/** A weighed tonnage for the calculator, a figure no file of the demo holds. */
const WEIGHED = '4321.5';

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

  // the pile let go (opened by a click in 3D, it has no link back: Esc on its panel): the whole
  // site between the compare pair again
  await openSection(win, 'selection');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('pile-back')).toHaveCount(0);
  await panel.getByTestId('pile-tab-overview').focus();
  await win.keyboard.press('Escape');
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

test('a volume drawn in the view is a new pile with a volume, and the number beside Volumes counts the list', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(720_000);
  const before = await piles(quarryProject);
  await openDemo(win, quarryProject.name, quarryProject.id);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible({ timeout: 60_000 });
  // Project > Volumes as it opens: the demo's piles, and their number beside the section's name
  const view = await volumesView(win);
  const rows = view.getByTestId('volumes-pile');
  await expect(rows).toHaveCount(before.length, { timeout: 60_000 });
  const head = win.getByTestId('panel-section-project.volumes').locator('.wb-section-head');
  await expect(head.locator('.wb-section-title')).toHaveText('Volumes');
  await expect(head.locator('.wb-section-count')).toHaveText(String(before.length));

  // every survey prepared (quietly, on open): a volume has surfaces to be worked out on
  const strip = win.getByRole('region', { name: 'Dates strip' });
  await expect(strip.locator('[data-survey][data-state="ready"]')).toHaveCount(3, {
    timeout: 360_000,
  });

  // Tools > Measure > Volume, then four clicks around a pile, on the ground beside its toe
  await (await measureControl(win, 'survey-tool-volume')).click();
  const bar = win.getByTestId('survey-drawbar');
  await expect(bar).toBeVisible();
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
  const at = await labelAnchor3d(win, SP1_ID);
  const corners: [number, number][] = [
    [-45, -30],
    [45, -30],
    [45, 30],
    [-45, 30],
  ];
  for (const [i, [dx, dy]] of corners.entries()) {
    await win.mouse.click(at.x + dx, at.y + dy);
    await expect(bar).toContainText(`${String(i + 1)} point`);
  }
  await bar.getByTestId('survey-finish').click();
  // saved as a measurement; the tool stays up for the next one until it is stopped
  await expect(bar).toContainText('0 points');
  await bar.getByRole('button', { name: /^Stop/ }).click();
  await expect(bar).toHaveCount(0);

  // the new volume is the selected measurement, in the Measure card: drawn, not worked out yet
  const card = win.getByTestId('survey-panel');
  await expect(card).toBeVisible();
  const name = await card.getByRole('textbox', { name: 'Rename' }).inputValue();
  expect(before.map((x) => x.label)).not.toContain(name);
  await expect(card.getByTestId('vol-new-item')).toContainText('Not computed yet');
  await expect(card.getByTestId('survey-from')).toHaveText('Base: Toe surface');
  // with the other measurements of the survey date in the left sidebar, no figure yet
  await measureTree(win);
  const row = measureRow(win, name);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('No figure for this date');
  // Recompute works it out on the base shown, Toe surface
  await card.getByTestId('survey-recompute').click();
  await volumeSettled(card, 1, 240_000);
  await expect(row).not.toContainText('No figure for this date', { timeout: 60_000 });
  await expect(row).toContainText(/\d m³/);

  // Project > Volumes: one row more with its figure, and the number beside "Volumes" is the list's
  const list = await volumesView(win);
  await expect(list.getByTestId('volumes-pile')).toHaveCount(before.length + 1);
  const mine = list.getByTestId('volumes-pile').filter({ hasText: name });
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText(/\d/);
  await expect(head.locator('.wb-section-count')).toHaveText(String(before.length + 1));
});

/** Answer every save dialog with `<dir>/<the name the app proposed>`. */
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

/** A saved file's text, once it is there and holds still. */
async function savedText(file: string): Promise<string> {
  await expect.poll(() => existsSync(file), { timeout: 60_000 }).toBe(true);
  let text = '';
  await expect
    .poll(
      async () => {
        const now = await readFile(file, 'utf8');
        const same = now !== '' && now === text;
        text = now;
        return same;
      },
      { intervals: [300], timeout: 30_000 },
    )
    .toBe(true);
  return text;
}

/** The rows of a CSV the app wrote (no line breaks inside a field in these files). */
function csvRows(text: string): string[][] {
  const cells = (line: string): string[] => {
    const out: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i] ?? '';
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') {
        out.push(cell);
        cell = '';
      } else cell += c;
    }
    out.push(cell);
    return out;
  };
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    .split(/\r?\n/)
    .filter((l) => l !== '')
    .map(cells);
}

/** Stockpile inventory (CSV) from the Issues screen's Export menu, then back to the Scene. */
async function inventoryCsv(win: Page, out: string): Promise<string[][]> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Issues' }).click();
  await win.getByRole('button', { name: 'Export', exact: true }).click();
  await win.getByRole('menuitem', { name: /Stockpile inventory \(CSV\)/ }).click();
  const msg = win.getByTestId('export-toast-message').last();
  await expect(msg).toContainText('saved to', { timeout: 240_000 });
  await win.getByRole('button', { name: 'Dismiss' }).last().click();
  const rows = csvRows(await readFile(join(out, 'Quarry-demo-stockpile-inventory.csv'), 'utf8'));
  await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
  return rows;
}

/** The first figure of a text the app shows ("1 234.5 m3"). */
const figure = (text: string): number => {
  const m = /[-+−]?[\d ,]*\d(?:\.\d+)?/.exec(text.replace(/\s/g, ' '));
  return Number((m?.[0] ?? 'NaN').replace(/[ ,+]/g, '').replace('−', '-'));
};

test('a pile on Lowest point and back on Toe surface: one base name in the panel, the inventory and the CSV, kept across a reopen; the calculator note and the export names', async ({
  app,
  dataRoot,
  quarryProject,
  win,
}) => {
  test.setTimeout(900_000);
  const out = join(dataRoot.base, 'out');
  await mkdir(out, { recursive: true });
  await answerSaveDialogs(app, out);
  const panel = await pileOpened(win, quarryProject);
  const volume = panel.getByTestId('pile-kpi-volume').locator('b');
  const chip = panel.getByTestId('survey-from');
  const method = panel.locator('.pp-method');
  const inventoryRow = async (): Promise<(col: string) => string> => {
    const rows = await inventoryCsv(win, out);
    const row = rows.find((r) => r[0] === 'pile' && r[1] === SP1_ID);
    if (!row) throw new Error('no row for the first pile');
    return (col) => row[(rows[0] ?? []).indexOf(col)] ?? '';
  };

  /** Save in the Measure bench (Tools): nothing unsaved is left. */
  const saveMeasurements = async (): Promise<void> => {
    const save = (await measureSaved(win)).getByTestId('survey-list-save');
    if (await save.isEnabled()) await save.click();
    await expect(save).toBeDisabled();
  };

  // as the demo has it: the pile on its toe surface
  await expect(chip).toHaveText('Base: Toe surface');
  await expect(method).toContainText('Toe surface');
  await expect(panel.getByTestId('pile-status')).toHaveCount(0);
  const onToe = await volume.innerText();

  // Base: Lowest point. The figure follows (a level base under the whole pile: more volume)
  await pickBase(panel, 'lowest');
  await expect(chip).toHaveText('Base: Lowest point');
  await expect(volume).not.toHaveText(onToe, { timeout: 120_000 });
  await expect(panel.getByTestId('pile-status')).toHaveCount(0, { timeout: 120_000 });
  await expect(method).toContainText('Lowest point');
  await expect(method).not.toContainText('Toe surface');
  const onLowest = await volume.innerText();
  expect(figure(onLowest)).toBeGreaterThan(figure(onToe));
  // the same name in Project > Volumes (the caption names every base the counted piles stand on)
  let view = await volumesView(win);
  await expect(view.locator('.vi-cap')).toContainText('Lowest point');
  // and in the inventory CSV, with the pile's figure (the export reads the project as saved)
  await saveMeasurements();
  let csv = await inventoryRow();
  expect(csv('base')).toMatch(/^Lowest point/);
  expect(Math.abs(Number(csv('current_volume_m3')) - figure(onLowest))).toBeLessThan(0.06);

  // back to Toe surface: the figure it had
  await openSection(win, 'selection');
  await pickBase(panel, 'smart');
  await expect(chip).toHaveText('Base: Toe surface');
  await expect(volume).toHaveText(onToe, { timeout: 120_000 });
  await expect(panel.getByTestId('pile-status')).toHaveCount(0, { timeout: 120_000 });
  await expect(method).toContainText('Toe surface');
  await expect(method).not.toContainText('Lowest point');
  view = await volumesView(win);
  await expect(view.locator('.vi-cap')).toContainText('Grouped by material · Toe surface');
  await expect(view.locator('.vi-cap')).not.toContainText('Lowest point');
  await saveMeasurements();
  csv = await inventoryRow();
  expect(csv('base')).toBe('Toe surface');
  expect(Math.abs(Number(csv('current_volume_m3')) - figure(onToe))).toBeLessThan(0.06);

  // the weight calculator (Overview, More): a weighed tonnage typed, and the note beside it
  await openSection(win, 'selection');
  await panel.getByTestId('pile-tab-overview').click();
  await panel.getByTestId('pile-more').locator('summary').first().click();
  const weighed = panel.getByTestId('survey-weight');
  await weighed.scrollIntoViewIfNeeded();
  await weighed.fill(WEIGHED);
  await expect(panel.getByTestId('survey-weight-note')).toHaveText(
    'The weighed tonnage is not saved with the project.',
  );
  await expect(panel.getByTestId('survey-achieved-density')).toBeVisible();

  // History: Export CSV, a file named for the pile and volume over time, a row per survey date
  await panel.getByTestId('pile-tab-history').click();
  await expect(panel.getByTestId('pile-history-csv')).toHaveText('Export CSV');
  await panel.getByTestId('pile-history-csv').click();
  const history = csvRows(await savedText(join(out, 'Stockpile-SP1-Volume-over-time.csv')));
  const DAYS = ['2026-01-31', '2026-02-28', '2026-03-31'];
  const col = (rows: string[][], name: string) => (rows[0] ?? []).indexOf(name);
  expect(history[0]).toEqual(expect.arrayContaining(['Date', 'Volume (m³)', 'Tonnage (t)']));
  const mine = history.slice(1);
  expect(mine.map((r) => r[col(history, 'Measurement')])).toEqual([SP1, SP1, SP1]);
  expect(mine.map((r) => r[col(history, 'Date')])).toEqual(DAYS);
  // each date's tonnes are its volume at the pile's density (crushed rock, 1.6 t/m³)
  for (const r of mine)
    expect(
      Number(r[col(history, 'Tonnage (t)')]) / Number(r[col(history, 'Volume (m³)')]),
    ).toBeCloseTo(1.6, 2);
  expect(Number(mine[2]?.[col(history, 'Volume (m³)')])).toBeCloseTo(figure(onToe), 0);

  // the Volumes header's Export: a file named for volume over time, a row per pile and date
  view = await volumesView(win);
  await expect(view.getByTestId('volumes-csv')).toHaveText('Export');
  await view.getByTestId('volumes-csv').click();
  const series = csvRows(await savedText(join(out, 'Volume-over-time.csv')));
  const names = [...new Set(series.slice(1).map((r) => r[col(series, 'Measurement')] ?? ''))];
  expect(names).toEqual(expect.arrayContaining((await piles(quarryProject)).map((x) => x.label)));
  for (const name of names)
    expect(
      series
        .filter((r) => r[col(series, 'Measurement')] === name)
        .map((r) => r[col(series, 'Date')]),
      name,
    ).toEqual(DAYS);

  // saved, then closed and opened again: the base, the figure, nothing stale
  await saveMeasurements();
  await win.locator('.proj-switch').focus();
  await win.keyboard.press('Enter');
  await win
    .getByTestId('project-switcher')
    .getByRole('menuitem', { name: 'Close project' })
    .click();
  await expect(win.getByTestId('project-card').first()).toBeVisible({ timeout: 60_000 });
  const again = await pileOpened(win, quarryProject);
  await expect(again.getByTestId('survey-from')).toHaveText('Base: Toe surface');
  await expect(again.getByTestId('pile-kpi-volume').locator('b')).toHaveText(onToe);
  await expect(again.getByTestId('pile-status')).toHaveCount(0);
  await again.getByTestId('pile-tab-overview').click();
  await expect(again.locator('.pp-method')).toContainText('Toe surface');
  // as its note says, the weighed tonnage is not in the project's files
  for (const file of ['survey/measurements.json', 'manifest.json'])
    expect(await readFile(join(quarryProject.dir, ...file.split('/')), 'utf8'), file).not.toContain(
      WEIGHED,
    );
});

test('Tools > Volumes holds Draw volume and Swipe only, and the Reports screen says what each report is for', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(300_000);
  await openDemo(win, quarryProject.name, quarryProject.id);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible({ timeout: 60_000 });
  // Tools > Volumes: what acts on the view. No Table tile, no second cut and fill From and To
  const tools = await openSection(win, 'tools', 'tools.volumes');
  await expect(tools.getByTestId('tool-volumes.draw')).toHaveText(/Draw volume/);
  await expect(tools.getByTestId('tool-volumes.swipe')).toHaveText(/Swipe/);
  await expect(tools.locator('[data-testid^="tool-volumes."]')).toHaveCount(2);
  await expect(tools.getByText('Table', { exact: true })).toHaveCount(0);
  await expect(tools.getByTestId('vol-change-from')).toHaveCount(0);
  await expect(tools.getByTestId('vol-change-to')).toHaveCount(0);

  // Reports: the two reports that print piles, each with what it is for
  await win.locator('.sb-nav .nav-item', { hasText: 'Reports' }).click();
  const house = win.getByTestId('house-report');
  await expect(house).toContainText('Project report');
  await expect(house).toContainText(
    'The full survey record: every survey measurement and the processing accuracy, with Stockpile inventory and Volume over time inside. To hand the piles over to a customer, use the Volumetric report below.',
  );
  const customer = win.getByTestId('customer-reports');
  await expect(customer).toContainText('Volumetric report');
  await expect(customer).toContainText(
    'The hand-over for a customer: the piles with their figures and pictures, and texts you can edit. Export it as a PDF or as one HTML file that opens offline. The full survey record is the Project report above.',
  );
  await expect(customer.getByTestId('open-volumetric-report')).toHaveText('Open volumetric report');
});
