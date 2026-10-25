/**
 * Show, Cut & fill in Map mode (volumetric report plan, bug 4) on the synthetic quarry demo: the
 * map draws the whole site's cut and fill heat map above the survey photos, whether Cut & fill was
 * picked on the map or in the 3D view before it, and the stockpiles' labels show on the map in the
 * 3D view's label style, the pile's name only. Off-screen, zero network, pipeline Python needed.
 */
import type { Page } from '@playwright/test';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { stageMode, showSurface, volumesView } from './island';
import { openDemo } from './surveyJobs';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

const PILES = { 'm-sp1': 'Stockpile SP1', 'm-sp2': 'Stockpile SP2', 'm-sp3': 'Stockpile SP3' };

interface HeatProbe {
  /** The heat image's source is on the map. */
  source: boolean;
  /** Its layer is shown. */
  shown: boolean;
  /** Its layer is drawn above every survey photo and surface raster. */
  abovePhotos: boolean;
}

/** The stage's map: whether it draws the heat map, and where in its layer order. */
const heat = (win: Page): Promise<HeatProbe> =>
  win.evaluate(() => {
    interface M {
      getStyle(): { layers: { id: string }[] };
      getSource(id: string): unknown;
      getLayer(id: string): unknown;
      getLayoutProperty(id: string, p: string): unknown;
    }
    const el = [...document.querySelectorAll('.pane-map *')].find((x) => '__aioMap' in x) as
      (Element & { __aioMap: M }) | undefined;
    const map = el?.__aioMap;
    if (!map) return { source: false, shown: false, abovePhotos: false };
    const ids = map.getStyle().layers.map((l) => l.id);
    const at = ids.indexOf('aio-survey-heat-layer');
    const rasters = ids.flatMap((id, i) => (/^aio-(raster|pyr)-/.test(id) ? [i] : []));
    return {
      source: map.getSource('aio-survey-heat') !== undefined,
      shown: at >= 0 && map.getLayoutProperty('aio-survey-heat-layer', 'visibility') !== 'none',
      abovePhotos: at >= 0 && rasters.length > 0 && rasters.every((i) => i < at),
    };
  });

/** The pile label chips over the map: their text by measurement id, and how many are seen. */
async function mapLabels(win: Page): Promise<{ text: Record<string, string>; visible: number }> {
  return win.locator('.pane-map').evaluate((pane) => {
    const chips = [...pane.querySelectorAll<HTMLElement>('.sv-labels .sv-label')];
    const text: Record<string, string> = {};
    for (const c of chips) text[c.dataset.id ?? ''] = c.textContent;
    const visible = chips.filter((c) => {
      const s = getComputedStyle(c);
      const r = c.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    }).length;
    return { text, visible };
  });
}

async function expectDrawn(win: Page): Promise<void> {
  await expect(win.locator('.stage-slot [data-testid="cutfill-legend"]')).toBeVisible({
    timeout: 240_000,
  });
  await expect
    .poll(() => heat(win), { timeout: 120_000 })
    .toEqual({ source: true, shown: true, abovePhotos: true });
  await expect
    .poll(async () => {
      const { text } = await mapLabels(win);
      return Object.fromEntries(Object.keys(PILES).map((id) => [id, text[id] ?? '']));
    })
    .toEqual(PILES);
  await expect.poll(async () => (await mapLabels(win)).visible).toBeGreaterThan(0);
}

test('Map mode, Show → Cut & fill: the heat map is drawn above the photos and the pile labels show', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  await openDemo(win, quarryProject.name, quarryProject.id);
  const view = await volumesView(win);
  await expect(
    win
      .getByRole('region', { name: 'Survey dates chart' })
      .locator('[data-survey][data-state="ready"]'),
  ).toHaveCount(3, { timeout: 360_000 });
  await expect(view.getByTestId('volumes-site-total')).toBeVisible({ timeout: 120_000 });

  // Cut & fill picked on the map
  await stageMode(win, 'Map');
  await showSurface(win, 'Cut & fill');
  await expectDrawn(win);

  // Cut & fill picked in the 3D view, then the map
  await showSurface(win, 'Photo');
  await expect.poll(async () => (await heat(win)).source).toBe(false);
  await stageMode(win, '3D');
  await showSurface(win, 'Cut & fill');
  await stageMode(win, 'Map');
  await expectDrawn(win);
});
