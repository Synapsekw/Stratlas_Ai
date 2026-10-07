import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pmtilesFile } from '../src/main/testing';
import { expect, launchApp, test } from './fixtures';
import { copyRealData, hasRealData } from './realData';

/**
 * A road survey built in the app from raw inputs: the wizard (type Road), the ortho imported,
 * the centreline drawn on the map, the road builder run from the Jobs panel (road.build in the
 * pipeline runtime), and the project open in the road workspace. Needs a Python with
 * aio_pipelines (the development venv, or STRATLAS_E2E_PYTHON). Synthetic data only.
 */
const repo = join(import.meta.dirname, '..', '..', '..');
const venvPython =
  process.env.STRATLAS_E2E_PYTHON ??
  (process.platform === 'win32'
    ? join(repo, 'python', '.venv', 'Scripts', 'python.exe')
    : join(repo, 'python', '.venv', 'bin', 'python'));
const FIXTURE = join(import.meta.dirname, 'road-fixture.py');

interface Fixture {
  centre: [number, number];
  line: [number, number][];
  ortho: string;
  defects: string;
}

async function providePack(root: string): Promise<void> {
  const packs = join(root, 'packs');
  // the world overview map pack of the development machine, copied (read only) when it is there
  if (hasRealData('packs', 'world.pmtiles')) {
    for (const f of ['world.pmtiles', 'world.json'])
      await copyRealData(['packs', f], join(packs, f));
    return;
  }
  const data = pmtilesFile({ maxZoom: 14, bbox: [47.9, 29.3, 48.1, 29.45] });
  await writeFile(join(packs, 'kuwait.pmtiles'), data);
  await writeFile(
    join(packs, 'kuwait.json'),
    JSON.stringify({
      id: 'kuwait',
      label: 'Kuwait',
      bbox: [47.9, 29.3, 48.1, 29.45],
      maxZoom: 14,
      sizeBytes: data.length,
    }),
  );
}

/** Make the next native open dialog return these files (Electron main process). */
async function nextOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, files) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
      return Promise.resolve({ canceled: false, filePaths: files });
    };
  }, paths);
}

interface MapLike {
  getStyle(): { layers: { id: string }[] } | undefined;
  loaded(): boolean;
  fitBounds(
    b: [[number, number], [number, number]],
    o: { padding: number; animate: boolean },
  ): void;
  project(p: [number, number]): { x: number; y: number };
  queryRenderedFeatures(o: { layers: string[] }): unknown[];
}

/** Screen points of lon/lat positions on the map pane, after framing them. */
function screenPoints(win: Page, line: [number, number][]) {
  return win.evaluate((pts) => {
    const host = [...document.querySelectorAll('.pane-map div')].find(
      (d) => '__aioMap' in d,
    ) as unknown as (HTMLElement & { __aioMap: MapLike }) | undefined;
    if (!host?.__aioMap.getStyle() || !host.__aioMap.loaded()) return null;
    const map = host.__aioMap;
    const lons = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 120, animate: false },
    );
    const r = host.getBoundingClientRect();
    return pts.map((p) => {
      const q = map.project(p);
      return { x: r.left + q.x, y: r.top + q.y };
    });
  }, line);
}

/** What the maps on the page show for `layer`: for the poll, and for the message when it fails. */
interface MapProbe {
  maps: number;
  /** Features drawn on the first map that has the layer; -1 when no map has it. */
  rendered: number;
  perMap: { loaded: boolean; visible: boolean; overlays: string[] }[];
}

function probeMaps(win: Page, layer: string): Promise<MapProbe> {
  return win.evaluate((id) => {
    const hosts = [...document.querySelectorAll('div')].filter(
      (d) => '__aioMap' in d,
    ) as unknown as (HTMLElement & {
      __aioMap: MapLike;
    })[];
    let rendered = -1;
    const perMap = hosts.map((h) => {
      const map = h.__aioMap;
      const layers = map.getStyle()?.layers ?? [];
      if (rendered < 0 && layers.some((l) => l.id === id))
        rendered = map.queryRenderedFeatures({ layers: [id] }).length;
      return {
        loaded: map.loaded(),
        visible: h.getBoundingClientRect().width > 0,
        overlays: layers.map((l) => l.id).filter((n) => n.startsWith('aio-ov-')),
      };
    });
    return { maps: hosts.length, rendered, perMap };
  }, layer);
}

test.skip(!existsSync(venvPython), `no Python with aio_pipelines at ${venvPython}`);

test('a road survey from raw inputs: wizard, drawn centreline, road builder job, road workspace', async ({
  dataRoot,
  network,
}) => {
  test.setTimeout(300_000);
  const fx = JSON.parse(
    execFileSync(venvPython, [FIXTURE, join(dataRoot.base, 'raw')], { encoding: 'utf8' }),
  ) as Fixture;
  await providePack(dataRoot.root);
  const app = await launchApp(dataRoot, { STRATLAS_PIPELINE_PYTHON: venvPython });
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    const logs: string[] = [];
    win.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`);
    });
    win.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));

    // 1. The wizard: a road takes the ASTM D6433 road grading by default.
    await win.getByTestId('new-project').first().click();
    const wiz = win.getByTestId('new-project-wizard');
    await wiz.getByLabel('Project name').fill('Road e2e');
    await wiz
      .getByRole('group', { name: 'Project type' })
      .getByRole('button', { name: /^Road/ })
      .click();
    await wiz.getByRole('button', { name: 'Next' }).click();
    await wiz.getByRole('button', { name: 'Typed coordinate' }).click();
    await wiz
      .getByLabel('Origin coordinate')
      .fill(`${String(fx.centre[0])}, ${String(fx.centre[1])}, 0`);
    await expect(wiz.getByTestId('origin-readout')).toContainText('E 7');
    await wiz.getByRole('button', { name: 'Next' }).click();
    await expect(wiz.getByRole('option', { name: /Road distress \(ASTM D6433\)/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await wiz.getByRole('button', { name: 'Next' }).click();
    await wiz.getByRole('button', { name: 'Create project' }).click();
    // A road survey without its road model waits in setup.
    const setup = win.getByTestId('road-setup');
    await expect(setup).toBeVisible({ timeout: 30_000 });
    const root = join(dataRoot.root, 'projects', 'road-e2e');
    const created = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
      crs: { epsg: number };
      type: string;
      classCatalogues: { assetType: string }[];
    };
    expect(created.crs.epsg).toBe(32638);
    expect(created.type).toBe('road');
    expect(created.classCatalogues[0]?.assetType).toBe('road');

    // 2. The ortho imported as raw data, to draw over it.
    await nextOpenDialog(app, [fx.ortho]);
    await win.getByRole('button', { name: 'Import files' }).click();
    const panel = win.getByTestId('import-panel');
    await expect(panel).toContainText('Imported 1 of 1 files', { timeout: 60_000 });
    await panel.getByRole('button', { name: 'Close' }).click();

    // 3. Draw the centreline on the map, from km 0 to the end, and save it in the project.
    await setup.getByRole('button', { name: 'Draw centreline' }).click();
    await expect(win.locator('.stage')).toHaveAttribute('data-mode', 'map');
    // the map registers its click handler once it has loaded
    const framed: { pts: { x: number; y: number }[] } = { pts: [] };
    await expect
      .poll(
        async () => {
          framed.pts = (await screenPoints(win, fx.line)) ?? [];
          return framed.pts.length;
        },
        { timeout: 30_000 },
      )
      .toBe(2);
    for (const p of framed.pts) await win.mouse.click(p.x, p.y);
    await expect(setup.getByTestId('road-setup-count')).toHaveText(/^2 points, 1\d\d\.\d m$/);
    await setup.getByRole('button', { name: 'Finish' }).click();
    await expect(setup).toContainText('Centreline saved as road/centreline-drawn.geojson.');
    const drawn = JSON.parse(
      await readFile(join(root, 'road', 'centreline-drawn.geojson'), 'utf8'),
    ) as { features: { geometry: { coordinates: [number, number][] } }[] };
    const [a, b] = drawn.features[0]?.geometry.coordinates ?? [];
    // within a metre or two of the fixture line (a click lands on a whole pixel)
    expect(Math.abs((a?.[0] ?? 0) - (fx.line[0]?.[0] ?? 0))).toBeLessThan(3e-5);
    expect(Math.abs((b?.[1] ?? 0) - (fx.line[1]?.[1] ?? 0))).toBeLessThan(3e-5);

    // 4. The road builder from the Jobs panel, the drawn centreline filled in.
    await setup.getByRole('button', { name: 'Run the road builder' }).click();
    await expect(win.getByLabel('Pipeline', { exact: true })).toHaveValue('road.build');
    await expect(win.locator('#job-f-centreline')).toHaveValue('road/centreline-drawn.geojson');
    await expect(win.locator('#job-f-project')).toHaveValue(root);
    await win.locator('#job-f-ortho').fill(fx.ortho);
    await win.locator('#job-f-defects').fill(fx.defects);
    await win.locator('#job-f-unitLength').fill('30');
    await win.getByTestId('job-start').click();
    const detail = win.locator('.job-detail');
    await expect(detail.locator('.jd-h .job-state')).toHaveText('Done', { timeout: 240_000 });
    await expect(detail.locator('.job-log')).toContainText('network PCI');

    const road = JSON.parse(await readFile(join(root, 'road.json'), 'utf8')) as {
      centreline: { lengthKm: number };
      pci: {
        layout: string;
        units: { id: string; pci: { medium: number }; fromKm: number; toKm: number }[];
        network: { medium: number };
      };
    };
    expect(road.pci.layout).toBe('chainage');
    expect(road.centreline.lengthKm).toBeGreaterThan(0.18);
    expect(road.pci.units.length).toBe(6);
    expect(road.pci.units[0]?.fromKm).toBe(0);
    expect(road.pci.network.medium).toBeLessThan(100);
    const issues = JSON.parse(await readFile(join(root, 'issues.json'), 'utf8')) as {
      issues: { code: string; severity: number; sightings: { on: string }[] }[];
    };
    expect(issues.issues.map((i) => [i.code, i.severity])).toEqual([
      ['D0000', 1],
      ['D0001', 3],
      ['D0002', 2],
    ]);
    expect(issues.issues.every((i) => i.sightings.some((s) => s.on === 'image'))).toBe(true);
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
      layers: { id: string; kind: string; format?: string; visible: boolean }[];
    };
    expect(manifest.layers.find((l) => l.id === 'ortho')).toMatchObject({
      format: 'kit-pyramid',
      visible: true,
    });
    expect(manifest.layers.find((l) => l.format === 'image')?.visible).toBe(false);
    expect(manifest.layers.some((l) => l.id === 'closeups')).toBe(true);

    // 5. The project reopened in the road workspace: map, chainage ruler, defects, PCI.
    await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).click();
    await expect(win.getByLabel('Chainage', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(win.getByTestId('road-setup')).toHaveCount(0);
    await expect(win.getByTestId('defect-count')).toHaveText('3 of 3 defects');
    await win.keyboard.press('p');
    await expect(win.getByLabel('PCI legend')).toBeVisible();
    // On a failure, say what the maps held and what the page logged (CI runners differ).
    let probe: MapProbe | null = null;
    try {
      await expect
        .poll(
          async () => {
            probe = await probeMaps(win, 'aio-ov-road-pci-fill');
            return probe.rendered;
          },
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
    } catch (e) {
      throw new Error(
        [`PCI units not drawn. Maps: ${JSON.stringify(probe)}`, 'Page console:', ...logs].join(
          '\n',
        ),
        { cause: e },
      );
    }
    await win.locator('.rr-row').first().click();
    await expect(win.getByRole('complementary', { name: 'Close-up' })).toBeVisible();

    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});
