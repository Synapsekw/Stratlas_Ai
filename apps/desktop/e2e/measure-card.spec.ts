/**
 * The one measurement card (volumetric parity W2) in the real app, on the synthetic tiny project
 * given two survey dates, each with a small prepared surface written here (a tilted plane, the
 * second date 0.5 m higher), and three seeded measurements: a distance line, an elevation point
 * and a polygon with a stored fill opacity. The distance card has its primary value, the secondary
 * line and the profile chart over both dates; the point card charts its elevation on every date,
 * and Survey QA no longer has an elevation history of its own; imperial units change the card, the
 * tree's value and the map's label alike; the stored fill opacity is what the map draws. No
 * pipeline Python: the surfaces are written by the spec. Off-screen, zero network.
 */
import { HeightTiles, MeasurementsFile, ProjectManifest } from '@aio/schema';
import { encodeTile, TILE } from '@aio/survey';
import type { Locator, Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, openProject, test, tinyManifest } from './fixtures';
import { measureControl, measureRow, measureTree, siteDataButton, stageMode } from './island';
import { focusMeasure } from './measureCard';

/** The tiny project's origin (fixtures.ts `tinyManifest`). */
const E = 500000;
const N = 3200000;
/** The prepared surfaces: 5 cm cells, one 256 x 256 tile from 2 m south-west of the origin. */
const CELL = 0.05;
const E0 = E - 2;
const N0 = N - 2;
/** The ground on the first date: a plane rising 10 % to the east; the second date 0.5 m higher. */
const ground = (e: number, n: number, lift: number) => 10 + 0.1 * (e - E) + 0.02 * (n - N) + lift;

/** Filed under the newest survey date (an undated one waits under Needs a date, or the backfill moves it). */
const SEED = MeasurementsFile.parse({
  schema: 'aio.measurements/1',
  kitPilesConverted: [],
  measurements: [
    {
      // 3 m east and 4 m north: 5 m across, rising 1 m
      id: 'line-b',
      family: 'line',
      tool: 'distance',
      label: 'Line B',
      scope: { kind: 'survey', capture: 'capture-2' },
      points: [
        [E + 0.6, N + 0.7, 10.5],
        [E + 3.6, N + 4.7, 11.5],
      ],
      items: [],
      results: [],
      createdAt: '2026-10-20T00:00:00Z',
    },
    {
      id: 'spot-c',
      family: 'point',
      tool: 'elevation',
      label: 'Spot C',
      scope: { kind: 'survey', capture: 'capture-2' },
      points: [[E + 2, N + 2, ground(E + 2, N + 2, 0.5)]],
      items: [],
      results: [],
      createdAt: '2026-10-20T00:00:00Z',
    },
    {
      id: 'pad-a',
      family: 'polygon',
      tool: 'area',
      label: 'Pad A',
      scope: { kind: 'survey', capture: 'capture-2' },
      style: { color: '#3b82f6', fillOpacity: 0.6 },
      points: [
        [E + 5, N + 5, 0],
        [E + 7, N + 5, 0],
        [E + 7, N + 7, 0],
        [E + 5, N + 7, 0],
      ],
      items: [],
      results: [],
      createdAt: '2026-10-20T00:00:00Z',
    },
  ],
});

/** One prepared surface (`aio.height-tiles/1`) of a survey date, written as `survey.prepare` does. */
async function writeSurface(dir: string, capture: string, lift: number): Promise<void> {
  const id = `dsm-${capture}`;
  const heights = new Float64Array(TILE * TILE);
  let lo = Infinity;
  let hi = -Infinity;
  for (let row = 0; row < TILE; row++)
    for (let col = 0; col < TILE; col++) {
      const z = ground(E0 + (col + 0.5) * CELL, N0 + (row + 0.5) * CELL, lift);
      heights[row * TILE + col] = z;
      lo = Math.min(lo, z);
      hi = Math.max(hi, z);
    }
  const folder = join(dir, 'survey', 'surfaces', id);
  await mkdir(join(folder, '0'), { recursive: true });
  await writeFile(join(folder, '0', '0_0.bin'), await encodeTile(heights));
  const tiles = HeightTiles.parse({
    schema: 'aio.height-tiles/1',
    id,
    name: `${capture} DSM`,
    source: { kind: 'dsm', layer: id },
    capture,
    crs: { epsg: 32639 },
    cellM: CELL,
    tileSize: TILE,
    originE: E0,
    originN: N0,
    cols: 1,
    rows: 1,
    levels: 1,
    bounds: [E0, N0, lo, E0 + TILE * CELL, N0 + TILE * CELL, hi],
    tiles: ['0_0'],
    fingerprint: `e2e-${id}`,
    preparedAt: '2026-10-20T00:00:00Z',
  });
  await writeFile(join(folder, 'tiles.json'), JSON.stringify(tiles, null, 1));
}

test.beforeEach(async ({ dataRoot }) => {
  const dir = dataRoot.projectDir;
  const base = tinyManifest();
  const manifest = ProjectManifest.parse({
    ...base,
    captures: [...base.captures, { id: 'capture-2', label: 'Second capture', date: '2026-02-01' }],
  });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await mkdir(join(dir, 'survey'), { recursive: true });
  await writeFile(join(dir, 'survey', 'measurements.json'), JSON.stringify(SEED, null, 1));
  await writeSurface(dir, 'capture-1', 0);
  await writeSurface(dir, 'capture-2', 0.5);
});

async function openTiny(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe('e2e-tiny');
}

/** The card's primary value as one text ("5.099 m"), the way the tree and the labels print it. */
async function primaryText(card: Locator): Promise<string> {
  const primary = card.getByTestId('card-primary');
  await expect(primary).toBeVisible();
  const value = (await primary.locator('.mc-value').innerText()).trim();
  const unit = (await primary.locator('.mc-unit').innerText()).trim();
  return `${value} ${unit}`;
}

interface MapFeature {
  id: string;
  kind: string | null;
  label: string | null;
  fillOpacity: number | null;
  type: string;
}

/** The measurements on the main map: their features and the fill layer's opacity paint. */
const mapMeasurements = (win: Page) =>
  win.evaluate(() => {
    interface Feature {
      properties: Record<string, unknown>;
      geometry: { type: string };
    }
    interface MapProbe {
      getSource(id: string): { serialize?(): { data?: unknown } } | undefined;
      getLayer(id: string): unknown;
      getPaintProperty(layer: string, name: string): unknown;
    }
    const host = [...document.querySelectorAll('.pane-map div')].find((d) => '__aioMap' in d) as
      { __aioMap: MapProbe } | undefined;
    const map = host?.__aioMap;
    if (!map) return null;
    const data = map.getSource('aio-survey')?.serialize?.().data as
      { features?: Feature[] } | undefined;
    if (!data?.features) return null;
    return {
      fillPaint: map.getLayer('aio-survey-fill')
        ? map.getPaintProperty('aio-survey-fill', 'fill-opacity')
        : null,
      features: data.features.map((f): MapFeature => ({
        id: typeof f.properties.id === 'string' ? f.properties.id : '',
        kind: typeof f.properties.kind === 'string' ? f.properties.kind : null,
        label: typeof f.properties.label === 'string' ? f.properties.label : null,
        fillOpacity: typeof f.properties.fillOpacity === 'number' ? f.properties.fillOpacity : null,
        type: f.geometry.type,
      })),
    };
  });

/** The map label of a measurement, once the map draws it. */
async function mapLabel(win: Page, id: string): Promise<string | null> {
  const m = await mapMeasurements(win);
  return m?.features.find((f) => f.id === id && f.kind === 'label')?.label ?? null;
}

test('distance card: primary, secondary line with Horizontal · Height · Grade, profile chart', async ({
  win,
}) => {
  await openTiny(win);
  await measureTree(win, 'capture-2');
  const card = await focusMeasure(win, 'Line B');

  // the primary value is the slope length, 5.099 m (3, 4 and a 1 m rise)
  await expect(card.getByTestId('card-primary')).toContainText('Slope length');
  expect(
    Number.parseFloat(await card.getByTestId('card-primary').locator('.mc-value').innerText()),
  ).toBeCloseTo(Math.hypot(5, 1), 2);
  // one compact line under it: the horizontal length, the height change and the grade, in order
  const secondary = card.getByTestId('card-secondary');
  await expect(secondary).toHaveText(
    /^Horizontal length 5\.0+ m · Height change 1\.0+ m · Grade .+$/,
  );
  // "More" opens the full readout, not repeating what is above it twice
  await card.getByTestId('card-more').click();
  await expect(card.getByTestId('card-readout')).toContainText('Terrain length');

  // the profile over both dates: the date in focus (the second) is current, the first earlier
  const chips = card.getByTestId('line-chips');
  await expect(chips.locator('[data-chip]')).toHaveCount(2, { timeout: 30_000 });
  const chart = card.getByTestId('line-profile');
  await expect(chart.locator('polyline[data-series="capture-2"]').first()).toHaveAttribute(
    'data-kind',
    'current',
  );
  await expect(chart.locator('polyline[data-series="capture-1"]').first()).toHaveAttribute(
    'data-kind',
    'earlier',
  );
  // the terrain length per date under the chart
  await expect(card.getByTestId('terrain-lengths')).toContainText('Second capture');
  // the chart is named for what it shows, ends A and B, and is reachable by key
  await expect(chart.getByTestId('chart-plot')).toHaveAttribute(
    'aria-label',
    /Profile from A to B/,
  );
  await chart.getByTestId('chart-plot').focus();
  await expect(chart.getByTestId('chart-readout')).toBeVisible();
  await expect(chart.getByTestId('chart-readout')).toContainText('Second capture');
  await expect(chart.getByTestId('chart-readout')).toContainText('Synthetic capture');
  // the actions row: Notes, Export and Fly to; Export lists CSV, DXF and PNG
  await expect(card.getByTestId('card-actions')).toHaveAttribute('data-has-chart', 'true');
  await card.getByTestId('card-export').click();
  const formats = win.getByTestId('card-export-list');
  await expect(formats.getByRole('menuitem')).toHaveText(['CSV', 'DXF', 'PNG']);
  await win.keyboard.press('Escape');
  await expect(formats).toHaveCount(0);
  await expectAccessible(win, 'Measurement card', { include: '[data-testid="survey-panel"]' });
});

test('point card shows elevation over time; Survey QA has no history tab', async ({ win }) => {
  await openTiny(win);
  await measureTree(win, 'capture-2');
  const card = await focusMeasure(win, 'Spot C');

  // the elevation on every survey date, the latest marked
  const time = card.getByTestId('elevation-time');
  await expect(time).toBeVisible({ timeout: 30_000 });
  await expect(time).toHaveAttribute('data-kind', 'elevation');
  await expect(time.locator('circle[data-dot]')).toHaveCount(2);
  await expect(time.locator('circle[data-latest]')).toHaveAttribute('data-dot', 'capture-2');
  // 0.5 m higher on the second date
  const at = (capture: string) =>
    time.locator(`circle[data-dot="${capture}"]`).getAttribute('data-value');
  const first = Number.parseFloat((await at('capture-1')) ?? '');
  const second = Number.parseFloat((await at('capture-2')) ?? '');
  expect(first).toBeCloseTo(ground(E + 2, N + 2, 0), 2);
  expect(second - first).toBeCloseTo(0.5, 2);
  await time.getByTestId('time-plot').focus();
  await expect(time.getByTestId('time-readout')).toContainText('Elevation');
  await expect(card.getByTestId('elevation-time-none')).toHaveCount(0);

  // a design or a date to compare with is a chip; none is picked yet
  await expect(card.getByTestId('point-chips-add')).toBeVisible();

  // Survey QA keeps its checks, cleanup and surveys; the elevation history moved to the card
  await (await siteDataButton(win, 'Survey QA and cleanup')).click();
  const qa = win.getByTestId('survey-qa-tools');
  await expect(qa).toBeVisible();
  await expect(qa.getByRole('button')).toHaveCount(3);
  await expect(qa.getByTestId('survey-qa-open-history')).toHaveCount(0);
  await expect(qa.getByRole('button', { name: /history/i })).toHaveCount(0);
  await expect(win.getByTestId('elevation-history')).toHaveCount(0);
});

test('switching units to imperial changes the card, the tree value and the map label alike', async ({
  win,
}) => {
  await openTiny(win);
  await stageMode(win, 'Map');
  await measureTree(win, 'capture-2');
  const card = await focusMeasure(win, 'Line B');
  const metric = await primaryText(card);
  expect(metric).toMatch(/ m$/);
  await expect(measureRow(win, 'Line B')).toContainText(metric);
  await expect.poll(() => mapLabel(win, 'line-b'), { timeout: 30_000 }).toContain(metric);

  // the site's units: feet
  await (await measureControl(win, 'survey-units-open')).click();
  const dialog = win.getByTestId('survey-units-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('survey-unit-distance').selectOption('ft');
  await dialog.getByTestId('survey-units-save').click();
  await expect(dialog).toHaveCount(0);

  // the card, the tree's value and the map's label all say the same feet
  await expect(card.getByTestId('card-primary').locator('.mc-unit')).toHaveText('ft');
  const imperial = await primaryText(card);
  expect(Number.parseFloat(imperial)).toBeCloseTo(Math.hypot(5, 1) / 0.3048, 1);
  await expect(card.getByTestId('card-secondary')).toContainText('ft');
  await expect(card.getByTestId('card-secondary')).not.toContainText(' m ');
  await expect(measureRow(win, 'Line B')).toContainText(imperial);
  await expect.poll(() => mapLabel(win, 'line-b'), { timeout: 30_000 }).toContain(imperial);
});

test('a date without a surface shows as a chip, not "No survey data"', async ({
  win,
  dataRoot,
}) => {
  // an earlier survey date with neither a DSM nor a cloud: nothing to prepare it from
  const dir = dataRoot.projectDir;
  const manifest = ProjectManifest.parse(
    JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')),
  );
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        ...manifest,
        captures: [
          { id: 'capture-0', label: 'Earlier capture', date: '2025-12-01' },
          ...manifest.captures,
        ],
      },
      null,
      2,
    ),
  );
  await openTiny(win);
  await measureTree(win, 'capture-2');
  const card = await focusMeasure(win, 'Line B');

  // the latest date and the one before are chips; the earlier one joins from the add menu, and
  // without elevation it is a disabled chip that says why
  const chips = card.getByTestId('line-chips');
  await expect(chips.locator('[data-chip]')).toHaveCount(2, { timeout: 30_000 });
  await chips.getByTestId('line-chips-add').click();
  const menu = win.getByRole('menu', { name: '+ Add survey or design' });
  await expect(menu).toBeVisible();
  await menu
    .getByRole('group', { name: 'Surveys' })
    .getByRole('menuitem', { name: 'Earlier capture' })
    .click();
  await expect(menu).toHaveCount(0);
  await expect(chips.locator('[data-chip]')).toHaveCount(3);
  const none = chips.locator('[data-chip="capture-0"]');
  await expect(none).toHaveAttribute('data-state', 'none');
  const main = none.locator('.pc-chip-main');
  await expect(main).toHaveAttribute('aria-disabled', 'true');
  await expect(main).toHaveAccessibleDescription('No elevation for this date');
  await expect(chips.locator('[data-chip="capture-1"]')).toHaveAttribute('data-state', 'ready');
  // there is no line to show for it
  await expect(card.getByTestId('line-profile').locator('[data-series="capture-0"]')).toHaveCount(
    0,
  );
  await expect(card).not.toContainText('No survey data');

  // the point card charts the dates it has and names no "No survey data" either
  const spot = await focusMeasure(win, 'Spot C');
  await expect(spot.getByTestId('elevation-time')).toBeVisible({ timeout: 30_000 });
  await expect(spot.getByTestId('elevation-time').locator('circle[data-dot]')).toHaveCount(2);
  await expect(spot).not.toContainText('No survey data');
});

test('stored fill opacity is drawn on the map', async ({ win }) => {
  await openTiny(win);
  await stageMode(win, 'Map');
  await measureTree(win, 'capture-2');
  // the map's fill reads each measurement's own opacity
  await expect
    .poll(
      async () => {
        const m = await mapMeasurements(win);
        return m
          ? {
              paint: m.fillPaint,
              pad: m.features.find((f) => f.id === 'pad-a' && f.type === 'Polygon')?.fillOpacity,
            }
          : null;
      },
      { timeout: 30_000 },
    )
    .toEqual({ paint: ['get', 'fillOpacity'], pad: 0.6 });

  // the card's Style and label shows the same stored opacity
  const card = await focusMeasure(win, 'Pad A');
  const style = card.getByTestId('survey-style');
  await style.locator('summary').click();
  await expect(style.getByLabel('Fill opacity', { exact: true })).toHaveValue('0.6');
});
