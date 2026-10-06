/**
 * Imagery and surface change (M8 C2) on a synthetic two-date site: two orthos (the later one with
 * a painted square, a shaded patch and a slight tint) and two DSMs (the later one with a cone pile
 * and a pit), made by the pytest generators in `python/tests/imagery_synth.py`. The pipelines run
 * as jobs with the development Python (`uv sync` in python/, or STRATLAS_E2E_PYTHON), as
 * `volumetric-build.spec.ts` does; skipped without it. Then Compare dates with two orthos and
 * with two maps: Swipe drags the divider, Blend fades between the dates, and the heat map shows
 * its legend.
 *
 * When stream C8's two-date demo lands, this can switch to it (its ortho pair and DSM pair, with
 * the expected regions and volumes from its truth.json).
 */
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, launchApp, test } from './fixtures';

const repo = join(import.meta.dirname, '..', '..', '..');
const venvPython =
  process.env.STRATLAS_E2E_PYTHON ??
  (process.platform === 'win32'
    ? join(repo, 'python', '.venv', 'Scripts', 'python.exe')
    : join(repo, 'python', '.venv', 'bin', 'python'));

const PROJECT = 'e2e-change';

/** The synthetic site: orthos of 80 m at 25 cm, DSMs of 60 m at 10 cm, both dates. */
const MAKE_SITE = `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[2])
import imagery_synth as s
p = Path(sys.argv[1]); p.mkdir(parents=True, exist_ok=True)
big = s.ground(352, 352, 1)
a = s.noisy(big[16:336, 16:336], 101)
b = s.noisy(big[16:336, 16:336], 102)
b = s.tint(s.shade(s.paint(b, 60, 180, 80), 200, 40, 70, 0.6))
s.ortho_project(p, a, b, 0.25)
X, Z = s.surface_grid(0.1)
base = s.terrain(X, Z)
y1 = s.jitter(base, 11)
y2 = s.jitter(base + s.cone(X, Z, -10.0, -8.0, 1000.0, 6.0) - s.cone(X, Z, 14.0, 12.0, 300.0, 3.0), 12)
s.write_dsm(p / 'rasters/dsm-a.tif', y1, 0.1)
s.write_dsm(p / 'rasters/dsm-b.tif', y2, 0.1)
m = json.loads((p / 'manifest.json').read_text('utf-8'))
m['id'] = '${PROJECT}'
m['name'] = 'E2E change site'
m['layers'][0]['name'] = 'Ortho 2026-01-10'
m['layers'][1]['name'] = 'Ortho 2026-03-01'
for lid, cap, date in (('dsm-a', 'c1', '2026-01-10'), ('dsm-b', 'c2', '2026-03-01')):
    m['layers'].append({'kind': 'raster', 'id': lid, 'name': 'DSM ' + date, 'visible': True, 'capture': cap,
                        'role': 'dsm', 'format': 'cog', 'src': {'path': 'rasters/' + lid + '.tif'}})
(p / 'manifest.json').write_text(json.dumps(m, indent=1), 'utf-8')
`;

interface Win {
  aio: { invoke(channel: string, req: unknown): Promise<unknown> };
  __stratlas: {
    workspace: { getState(): { project: { manifest: { layers: { id: string }[] } } | null } };
    graphics(): { getState(): { tier: string; setOverride(t: string | null): void } };
  };
}

/** Start a pipeline job through the app's bridge and wait until it is done. */
async function runJob(win: Page, root: string, pipeline: string, params: unknown) {
  const id = await win.evaluate(
    async ({ root: project, pipeline: name, params: p }) => {
      const r = (await (window as unknown as Win).aio.invoke('jobs:start', {
        pipeline: name,
        project,
        params: p,
      })) as { ok: boolean; job?: { id: string }; error?: string };
      if (!r.ok || !r.job) throw new Error(r.error ?? 'no job');
      return r.job.id;
    },
    { root, pipeline, params },
  );
  await expect
    .poll(
      async () =>
        win.evaluate(async (jobId) => {
          const r = (await (window as unknown as Win).aio.invoke('jobs:list', {})) as {
            jobs: { id: string; status: string; error?: string }[];
          };
          const j = r.jobs.find((x) => x.id === jobId);
          return j?.status === 'failed' ? `failed: ${j.error ?? ''}` : (j?.status ?? 'none');
        }, id),
      { timeout: 150_000, intervals: [500, 1000] },
    )
    .toBe('done');
}

async function openProject(win: Page) {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E change site' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

function layerIds(win: Page) {
  return win.evaluate(() =>
    ((window as unknown as Win).__stratlas.workspace.getState().project?.manifest.layers ?? []).map(
      (l) => l.id,
    ),
  );
}

test.skip(!existsSync(venvPython), `no Python with aio_pipelines at ${venvPython}`);

test('imagery and surface change on two dates, then swipe and blend', async ({
  dataRoot,
  network,
}) => {
  test.setTimeout(300_000);
  const root = join(dataRoot.root, 'projects', PROJECT);
  execFileSync(venvPython, ['-c', MAKE_SITE, root, join(repo, 'python', 'tests')]);

  const app = await launchApp(dataRoot, { STRATLAS_PIPELINE_PYTHON: venvPython });
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(e.message));
    await openProject(win);

    // 1. imagery change: one region, the square of 20 x 20 m; the shade and the tint are not flagged
    await runJob(win, root, 'change.raster', {
      from: 'c1',
      to: 'c2',
      layerFrom: 'ortho-a',
      layerTo: 'ortho-b',
      method: 'gradient',
      threshold: 0.5,
      minAreaM2: 2,
      maxShiftPx: 2,
    });
    const raster = JSON.parse(
      await readFile(join(root, 'change', 'c1-c2-raster.json'), 'utf8'),
    ) as { items: { areaM2: number }[]; registration: { ok: boolean } };
    expect(raster.items).toHaveLength(1);
    expect(raster.items[0]?.areaM2).toBeGreaterThan(392);
    expect(raster.items[0]?.areaM2).toBeLessThan(408);
    expect(raster.registration.ok).toBe(true);

    // 2. surface change: the pile as fill, the pit as cut
    await runJob(win, root, 'change.surface', {
      from: { layer: 'dsm-a', kind: 'dsm' },
      to: { layer: 'dsm-b', kind: 'dsm' },
      captures: { from: 'c1', to: 'c2' },
    });
    const surface = JSON.parse(
      await readFile(join(root, 'change', 'c1-c2-surface.json'), 'utf8'),
    ) as { stats: Record<string, number> };
    expect(surface.stats.fillM3).toBeGreaterThan(990);
    expect(surface.stats.fillM3).toBeLessThan(1010);
    expect(surface.stats.cutM3).toBeGreaterThan(294);
    expect(surface.stats.cutM3).toBeLessThan(306);

    // the heat maps and the polygons are layers of the project once it is open again
    await openProject(win);
    await expect
      .poll(() => layerIds(win))
      .toEqual(
        expect.arrayContaining([
          'c1-c2-raster-heat',
          'c1-c2-raster-regions',
          'c1-c2-surface-heat',
          'c1-c2-surface-regions',
        ]),
      );

    // 3. two orthos: side by side, then swipe and blend
    await win.keyboard.press('3');
    const left = win.getByTestId('pane-chooser-left').locator('select').first();
    const right = win.getByTestId('pane-chooser-right').locator('select').first();
    await left.selectOption('raster');
    await right.selectOption('raster');
    await expect(win.getByTestId('pane-raster')).toHaveCount(2);
    await win.getByTestId('pane-date-left').selectOption('c1');
    await expect(win.getByTestId('pane-date-left')).toHaveValue('c1');
    await expect(win.getByTestId('pane-date-right')).toHaveValue('c2');
    const panes = win.locator('.stage-panes');
    const bar = win.getByTestId('compare-view');
    await expect(bar).toBeVisible();
    await expect(win.getByTestId('compare-view-side')).toHaveAttribute('aria-pressed', 'true');

    await win.getByTestId('compare-view-swipe').click();
    await expect(panes).toHaveAttribute('data-compare-view', 'swipe');
    const divider = win.getByTestId('compare-divider');
    await expect(divider).toHaveAttribute('aria-valuenow', '50');
    const box = await panes.boundingBox();
    const handle = await divider.boundingBox();
    if (!box || !handle) throw new Error('no stage or divider');
    // drag the divider to 30% of the stage
    await win.mouse.move(handle.x + handle.width / 2, box.y + box.height / 2);
    await win.mouse.down();
    await win.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 8 });
    await win.mouse.up();
    await expect(divider).toHaveAttribute('aria-valuenow', '30');
    const rightPane = win.locator('.stage-panes > [data-side="right"]');
    const clip = await rightPane.evaluate((el) => getComputedStyle(el).clipPath);
    expect(clip).toMatch(/inset\(0px 0px 0px (\d+)px\)/);
    expect(Number(/(\d+)px\)$/.exec(clip)?.[1])).toBeCloseTo(box.width * 0.3, -1);
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
      .selectOption('c1-c2-raster-heat');
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
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});
