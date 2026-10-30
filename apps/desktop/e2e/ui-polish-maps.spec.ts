/**
 * Map polish from the UI revision (W1c): the "No map pack" note can be hidden for the session
 * and only one map shows it; the change demo's site features are labelled along their lines and
 * no label is drawn over another; a project opens framed with room around it and, while the
 * camera is still the map's own, a new map size frames it again.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, hasChangeDemo, openChangeDemo, test } from './fixtures';
import { stageMode } from './island';

test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } });

/** A view that was just created (the map loads its style, the 3D scene its model) takes a while. */
const VIEW_READY = { timeout: 30_000 };

interface MapProbe {
  getStyle(): { layers: { id: string; type: string; layout?: Record<string, unknown> }[] };
  queryRenderedFeatures(o?: { layers?: string[] }): {
    layer: { id: string };
    geometry: { type: string };
  }[];
  getZoom(): number;
  getCenter(): { lng: number; lat: number };
  jumpTo(o: { zoom: number }): void;
  loaded(): boolean;
}

async function showView(win: Page, view: '3D' | 'Map'): Promise<void> {
  await stageMode(win, view);
  await expect(win.locator('.stage')).toHaveAttribute('data-mode', view === '3D' ? '3d' : 'map');
}

/** The camera of the main map, as zoom and centre. */
const camera = (win: Page) =>
  win.evaluate(() => {
    const host = [...document.querySelectorAll('.pane-map div')].find((d) => '__aioMap' in d) as
      { __aioMap: MapProbe } | undefined;
    const map = host?.__aioMap;
    if (!map) return null;
    const c = map.getCenter();
    return { zoom: map.getZoom(), lng: c.lng, lat: c.lat };
  });

async function resizeWindow(app: ElectronApplication, win: Page, w: number, h: number) {
  await app.evaluate(
    ({ BrowserWindow }, [cw, ch]) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(cw, ch);
    },
    [w, h] as const,
  );
  await expect
    .poll(() =>
      win.evaluate(([cw, ch]) => Math.abs(innerWidth - cw) + Math.abs(innerHeight - ch), [
        w,
        h,
      ] as const),
    )
    .toBeLessThanOrEqual(4);
}

test('the no map pack note hides for the session, and one map shows it', async ({ win }) => {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible(VIEW_READY);
  await showView(win, 'Map');
  await expect(win.locator('.maplibregl-canvas')).toBeVisible(VIEW_READY);
  const note = win.getByTestId('map-no-packs');
  await expect(note).toHaveCount(1);
  await expect(note).toHaveText(
    'No map pack installed: project layers only. Add a pack in Settings, Offline maps.',
  );
  const hide = note.getByRole('button', { name: 'Hide this note' });
  // the button takes the click where it is drawn (nothing of the map's foot lies over it)
  const box = await hide.boundingBox();
  if (!box) throw new Error('the hide button has no box');
  const hit = await win.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'),
    [box.x + box.width / 2, box.y + box.height / 2] as const,
  );
  expect(hit).toBe('Hide this note');
  await hide.click();
  await expect(note).toHaveCount(0);
  // a new map (back from 3D) does not bring it back
  await showView(win, '3D');
  await showView(win, 'Map');
  await expect(win.locator('.maplibregl-canvas')).toBeVisible(VIEW_READY);
  await expect(win.locator('.maplibregl-ctrl-scale').first()).toBeVisible(VIEW_READY);
  await expect(note).toHaveCount(0);
});

test.describe('the change demo on the map', () => {
  test.skip(!hasChangeDemo(), `no change demo: run pnpm demo:change --quick`);

  test('change demo map labels do not overlap, lines are labelled along them', async ({ win }) => {
    await openChangeDemo(win);
    await showView(win, 'Map');
    await expect(win.locator('.maplibregl-canvas')).toBeVisible(VIEW_READY);
    const labels = () =>
      win.evaluate(() => {
        const host = [...document.querySelectorAll('.pane-map div')].find(
          (d) => '__aioMap' in d,
        ) as { __aioMap: MapProbe } | undefined;
        const map = host?.__aioMap;
        if (!map?.loaded()) return null;
        const ids = map
          .getStyle()
          .layers.filter((l) => l.type === 'symbol' && /^aio-ov-layer-.*label/.test(l.id));
        const along = ids.filter((l) => l.layout?.['symbol-placement'] === 'line');
        const point = ids.filter((l) => l.layout?.['symbol-placement'] !== 'line');
        const drawn = map.queryRenderedFeatures({ layers: ids.map((l) => l.id) });
        return {
          along: along.length,
          // every label keeps clear room and never stands over another
          clear: ids.every(
            (l) =>
              Number(l.layout?.['text-padding'] ?? 0) > 0 &&
              l.layout?.['text-allow-overlap'] === false,
          ),
          lineLabels: drawn.filter((f) => along.some((l) => l.id === f.layer.id)).length,
          // a line is never labelled at a point as well
          linesAtPoints: drawn.filter(
            (f) => point.some((l) => l.id === f.layer.id) && f.geometry.type.includes('LineString'),
          ).length,
        };
      });
    await expect.poll(async () => (await labels())?.lineLabels ?? 0, VIEW_READY).toBeGreaterThan(0);
    const got = await labels();
    expect(got?.along).toBeGreaterThan(0);
    expect(got?.clear).toBe(true);
    expect(got?.linesAtPoints).toBe(0);
  });

  test('the project opens framed, and frames again when the map is resized', async ({
    app,
    win,
  }) => {
    await openChangeDemo(win);
    await showView(win, 'Map');
    await expect(win.locator('.maplibregl-canvas')).toBeVisible(VIEW_READY);
    await expect.poll(async () => (await camera(win))?.zoom ?? 0, VIEW_READY).toBeGreaterThan(12);
    // a small site opens close, never past z19
    const first = await camera(win);
    expect(first?.zoom).toBeLessThanOrEqual(19);
    // a larger window: the map frames the project again, a little nearer
    await resizeWindow(app, win, 1400, 900);
    await expect
      .poll(async () => (await camera(win))?.zoom ?? 0)
      .toBeGreaterThan((first?.zoom ?? 99) + 0.05);
    // once the person moves the camera, a new size leaves it where it is
    await win.evaluate(() => {
      const host = [...document.querySelectorAll('.pane-map div')].find((d) => '__aioMap' in d) as
        { __aioMap: MapProbe } | undefined;
      const map = host?.__aioMap;
      if (map) map.jumpTo({ zoom: map.getZoom() + 1 });
    });
    const moved = await camera(win);
    await resizeWindow(app, win, 1100, 700);
    await win.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    expect((await camera(win))?.zoom).toBeCloseTo(moved?.zoom ?? 0, 3);
  });
});
