/**
 * Imagery and surface change (M8 C2) on the change demo (C8, synthetic): Run imagery change and
 * Run surface change from the Changes panel, checked against the demo's `truth.json` (the changes
 * the orthos show, the lighting-only cloud shadow and tint that must not count, the cut and fill
 * regions of the DSM height grids and their volumes). The pipelines run as jobs with the
 * development Python (`uv sync` in python/, or QUADRION_E2E_PYTHON); skipped without it. Then
 * Compare dates with two orthos and with two maps: Swipe drags the divider, Blend fades between
 * the dates, and the heat map shows its legend.
 */
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';

test.use({ appEnv: PIPELINE_ENV });

interface Win {
  __stratlas: {
    workspace: { getState(): { project: { manifest: { layers: { id: string }[] } } | null } };
  };
}

type XZ = [number, number];
interface RasterTruth {
  expected: { id: string; verdict: string; outlineLocal: XZ[] }[];
  clean: { id: string; outlineLocal: XZ[] }[];
  counts: { expected: number; large: number; clean: number };
}
interface SurfaceTruth {
  regions: {
    id: string;
    verdict: 'cut' | 'fill';
    bounds: { min: number[]; max: number[] };
    volume: { cutM3: number; fillM3: number };
  }[];
  totals: { cutM3: number; fillM3: number };
}
interface Item {
  verdict: string;
  at?: number[];
  bounds?: { min: number[]; max: number[] };
  areaM2?: number;
  volume?: { cutM3: number; fillM3: number };
}

const layerIds = (win: Page) =>
  win.evaluate(() =>
    ((window as unknown as Win).__stratlas.workspace.getState().project?.manifest.layers ?? []).map(
      (l) => l.id,
    ),
  );

/** The x and z extent of an outline, widened by `margin` metres. */
function box(outline: XZ[], margin = 0) {
  const xs = outline.map((p) => p[0]);
  const zs = outline.map((p) => p[1]);
  return {
    x0: Math.min(...xs) - margin,
    x1: Math.max(...xs) + margin,
    z0: Math.min(...zs) - margin,
    z1: Math.max(...zs) + margin,
  };
}
const inside = (at: number[] | undefined, b: ReturnType<typeof box>) =>
  at !== undefined &&
  (at[0] ?? NaN) >= b.x0 &&
  (at[0] ?? NaN) <= b.x1 &&
  (at[2] ?? NaN) >= b.z0 &&
  (at[2] ?? NaN) <= b.z1;

/** True when a region's bounds (x and z) meet the box. */
const meets = (i: Item, b: ReturnType<typeof box>) =>
  i.bounds !== undefined &&
  (i.bounds.min[0] ?? NaN) <= b.x1 &&
  (i.bounds.max[0] ?? NaN) >= b.x0 &&
  (i.bounds.min[2] ?? NaN) <= b.z1 &&
  (i.bounds.max[2] ?? NaN) >= b.z0;

/** Changes tab, the producer's Run button, then its layers in the reloaded manifest. */
async function run(win: Page, producer: string, layers: string[]) {
  await win.getByTestId('tab-changes').click();
  const button = win.getByTestId('change-panel').getByTestId(`change-producer-${producer}`);
  await expect(button).toBeEnabled();
  await button.click();
  await expect
    .poll(() => layerIds(win), { timeout: 240_000, intervals: [1000] })
    .toEqual(expect.arrayContaining(layers));
}

test.skip(!hasPipelinePython(), `no pipeline Python at ${VENV_PYTHON} (uv sync in python/)`);

test('imagery and surface change on the change demo, then swipe and blend', async ({
  demoProject,
}) => {
  test.setTimeout(420_000);
  const { win, root, truth } = demoProject;
  const { from, to } = truth.captures;
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(e.message));
  const pair = `${from}-${to}`;

  // 1. imagery change: the changes of truth.json; neither the cloud shadow nor the tint
  await run(win, 'raster', [`${pair}-raster-heat`, `${pair}-raster-regions`]);
  const raster = JSON.parse(
    await readFile(join(root, 'change', `${pair}-raster.json`), 'utf8'),
  ) as { items: Item[]; registration: { ok: boolean } };
  expect(raster.registration.ok).toBe(true);
  const rt = truth.changes.raster as unknown as RasterTruth;
  // the large changes (the markers are smaller than the default smallest area)
  const large = rt.expected.filter((e) => {
    const b = box(e.outlineLocal);
    return (b.x1 - b.x0) * (b.z1 - b.z0) >= 2;
  });
  expect(large).toHaveLength(rt.counts.large);
  // each large change lies in a region (a region may hold two changes that touch)
  for (const e of large)
    expect(
      raster.items.some((i) => meets(i, box(e.outlineLocal, 0.5))),
      e.id,
    ).toBe(true);
  for (const c of rt.clean)
    expect(
      raster.items.some((i) => inside(i.at, box(c.outlineLocal))),
      c.id,
    ).toBe(false);
  // every region holds one of truth's changes: nothing from light, tint or noise
  for (const i of raster.items)
    expect(
      rt.expected.some((e) => meets(i, box(e.outlineLocal, 0.5))),
      JSON.stringify(i.at),
    ).toBe(true);

  // 2. surface change on the DSM height grids: truth's cut and fill regions and volumes
  await run(win, 'surface', [`${pair}-surface-heat`, `${pair}-surface-regions`]);
  const surface = JSON.parse(
    await readFile(join(root, 'change', `${pair}-surface.json`), 'utf8'),
  ) as { items: Item[]; stats: Record<string, number> };
  const st = truth.changes.surface as unknown as SurfaceTruth;
  expect(surface.items).toHaveLength(st.regions.length);
  for (const r of st.regions) {
    const b = { x0: r.bounds.min[0] ?? 0, x1: r.bounds.max[0] ?? 0, z0: 0, z1: 0 };
    b.z0 = r.bounds.min[2] ?? 0;
    b.z1 = r.bounds.max[2] ?? 0;
    const got = surface.items.find((i) => i.verdict === r.verdict && inside(i.at, b));
    expect(got, r.id).toBeDefined();
    const want = r.verdict === 'cut' ? r.volume.cutM3 : r.volume.fillM3;
    const have = r.verdict === 'cut' ? got?.volume?.cutM3 : got?.volume?.fillM3;
    // a few per cent from the 2 cm noise of the grids (truth.json's note)
    expect(Math.abs((have ?? 0) - want) / want, r.id).toBeLessThan(0.03);
  }
  expect(Math.abs((surface.stats.cutM3 ?? 0) - st.totals.cutM3) / st.totals.cutM3).toBeLessThan(
    0.03,
  );
  expect(Math.abs((surface.stats.fillM3 ?? 0) - st.totals.fillM3) / st.totals.fillM3).toBeLessThan(
    0.03,
  );

  // 3. two orthos: side by side, then swipe and blend
  await win.keyboard.press('3');
  const left = win.getByTestId('pane-chooser-left').locator('select').first();
  const right = win.getByTestId('pane-chooser-right').locator('select').first();
  await left.selectOption('raster');
  await right.selectOption('raster');
  await expect(win.getByTestId('pane-raster')).toHaveCount(2);
  await win.getByTestId('pane-date-left').selectOption(from);
  await expect(win.getByTestId('pane-date-left')).toHaveValue(from);
  await expect(win.getByTestId('pane-date-right')).toHaveValue(to);
  const panes = win.locator('.stage-panes');
  const bar = win.getByTestId('compare-view');
  await expect(bar).toBeVisible();
  await expect(win.getByTestId('compare-view-side')).toHaveAttribute('aria-pressed', 'true');

  await win.getByTestId('compare-view-swipe').click();
  await expect(panes).toHaveAttribute('data-compare-view', 'swipe');
  const divider = win.getByTestId('compare-divider');
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  const stage = await panes.boundingBox();
  const handle = await divider.boundingBox();
  if (!stage || !handle) throw new Error('no stage or divider');
  // drag the divider to 30% of the stage
  await win.mouse.move(handle.x + handle.width / 2, stage.y + stage.height / 2);
  await win.mouse.down();
  await win.mouse.move(stage.x + stage.width * 0.3, stage.y + stage.height / 2, { steps: 8 });
  await win.mouse.up();
  await expect(divider).toHaveAttribute('aria-valuenow', '30');
  const rightPane = win.locator('.stage-panes > [data-side="right"]');
  const clip = await rightPane.evaluate((el) => getComputedStyle(el).clipPath);
  expect(clip).toMatch(/inset\(0px 0px 0px (\d+)px\)/);
  expect(Number(/(\d+)px\)$/.exec(clip)?.[1])).toBeCloseTo(stage.width * 0.3, -1);
  // both orthos fill the stage
  const lb = await win.locator('.stage-panes > [data-side="left"]').boundingBox();
  const rb = await rightPane.boundingBox();
  expect(Math.round(lb?.width ?? 0)).toBe(Math.round(rb?.width ?? -1));
  // the keyboard moves the divider too
  await divider.focus();
  await win.keyboard.press('Shift+ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '40');

  await win.getByTestId('compare-view-blend').click();
  await expect(panes).toHaveAttribute('data-compare-view', 'blend');
  await expect(divider).toHaveCount(0);
  await win.getByTestId('compare-blend').fill('50');
  await expect.poll(() => rightPane.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.5');
  await win.getByTestId('compare-blend').fill('100');
  await expect.poll(() => rightPane.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

  // the later ortho pane shows the heat map with its legend
  await win.getByTestId('compare-view-side').click();
  await expect(panes).not.toHaveAttribute('data-compare-view', /./);
  await win
    .locator('.pane-raster[data-side="right"] select[aria-label="Raster layer"]')
    .selectOption(`${pair}-raster-heat`);
  const legend = win.locator('.pane-raster[data-side="right"]').getByTestId('change-legend');
  await expect(legend).toBeVisible();
  await expect(legend).toContainText('Change score');
  await expect(legend).toContainText('100%');

  // 4. two maps (Compare dates from the map): swipe works on them too
  await win.keyboard.press('2');
  await win.getByTestId('compare-dates').click();
  await expect(win.getByTestId('pane-map-compare')).toBeVisible();
  await win.getByTestId('compare-view-swipe').click();
  await expect(panes).toHaveAttribute('data-compare-view', 'swipe');
  await expect(win.getByTestId('compare-divider')).toBeVisible();
  // leaving the comparison puts the stage back
  await win.getByTestId('compare-dates').click();
  await expect(panes).not.toHaveAttribute('data-compare-view', /./);

  expect(errors).toEqual([]);
});
