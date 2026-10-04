/**
 * M6 X1: packages and map packs end to end.
 *
 * 1. HCl (a temp copy: manifest, issues, model and photos) is exported with the Kuwait region
 *    embedded and opened as a customer with an empty packs folder: the map draws the basemap
 *    from the pack inside the package. The customer then extracts it to edit and pins an issue.
 * 2. A region download cut off by quitting the app resumes from its partial file after a
 *    restart, against a planet build served from 127.0.0.1 (the only origin the zero-network
 *    guard lets through, explicitly).
 *
 * Test 1 needs E:\Stratlas Data\projects\hcl and packs\kuwait.pmtiles (or STRATLAS_HCL_DATA) and
 * is skipped elsewhere; it only reads them. Set STRATLAS_SHOTS to keep screenshots.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noise, pmtilesArchive, rangeServer, tilesOver } from '../src/main/testing';
import { expect, launchApp, NetworkGuard, test, type DataRoot } from './fixtures';

const SHOTS = process.env.STRATLAS_SHOTS;
const shot = async (win: Page, name: string) => {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`) });
};
const fwd = (p: string) => p.replace(/\\/g, '/');

const DATA = process.env.STRATLAS_HCL_DATA ?? 'E:\\Stratlas Data';
const HCL = join(DATA, 'projects', 'hcl');
const KUWAIT = join(DATA, 'packs', 'kuwait.pmtiles');

interface StratlasWindow {
  __stratlas: {
    workspace: {
      getState: () => {
        setLayerVisible: (id: string, v: boolean) => void;
        flyTo: (t: { kind: 'home' }) => void;
        project: { id: string } | null;
      };
    };
    stage: () => {
      raycast: (
        x: number,
        y: number,
      ) => {
        point: { x: number; y: number; z: number };
        object: { userData: Record<string, unknown>; parent: unknown };
      } | null;
    } | null;
  };
}

/** Screen points over the 3D canvas whose ray hits the given mesh layer. */
async function meshHits(win: Page, layerId: string) {
  return win.evaluate((id) => {
    const st = (window as unknown as StratlasWindow).__stratlas.stage();
    const canvas = document.querySelector('[data-scene-view] canvas');
    if (!st || !canvas) return [];
    const r = canvas.getBoundingClientRect();
    const out: { x: number; y: number }[] = [];
    for (let i = 12; i < 52; i += 2)
      for (let j = 12; j < 50; j += 2) {
        const nx = (i / 64) * 2 - 1;
        const ny = -((j / 62) * 2 - 1);
        const hit = st.raycast(nx, ny);
        if (!hit) continue;
        let o = hit.object as { userData: Record<string, unknown>; parent: unknown } | null;
        let lid: unknown = null;
        while (o && lid === null) {
          lid = o.userData.layerId ?? null;
          o = o.parent as typeof o;
        }
        if (lid === id)
          out.push({ x: r.left + ((nx + 1) / 2) * r.width, y: r.top + ((1 - ny) / 2) * r.height });
      }
    return out;
  }, layerId);
}

interface MapLike {
  getStyle(): { sources: Record<string, { tiles?: string[] }> } | undefined;
  queryRenderedFeatures(): { source: string }[];
  loaded(): boolean;
}

/** Basemap features MapLibre has loaded from the offline packs (through the controller hook). */
function basemapFeatures(win: Page) {
  return win.evaluate(() => {
    const host = [...document.querySelectorAll('div')].find((d) => '__aioMap' in d) as unknown as
      { __aioMap: MapLike } | undefined;
    const map = host?.__aioMap;
    const style = map?.getStyle();
    if (!map || !style) return 0;
    const source = Object.entries(style.sources).find(([, s]) =>
      s.tiles?.some((u) => u.includes('://tiles/')),
    )?.[0];
    return source ? map.queryRenderedFeatures().filter((f) => f.source === source).length : 0;
  });
}

async function stubSaveDialog(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
  }, file);
}

/** A temp copy of HCl with its model and photos (no clips or clouds), and the Kuwait pack. */
async function hclCopy(root: string): Promise<void> {
  const dest = join(root, 'projects', 'hcl');
  await mkdir(dest, { recursive: true });
  const manifest = JSON.parse(await readFile(join(HCL, 'manifest.json'), 'utf8')) as {
    layers: { id: string; kind: string }[];
  };
  manifest.layers = manifest.layers.filter((l) => l.kind === 'mesh' || l.kind === 'photos');
  await writeFile(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const f of ['issues.json', 'thumbnail.jpg']) await cp(join(HCL, f), join(dest, f));
  for (const d of ['models', 'photos']) await cp(join(HCL, d), join(dest, d), { recursive: true });
  await mkdir(join(root, 'packs'), { recursive: true });
  await cp(KUWAIT, join(root, 'packs', 'kuwait.pmtiles'));
  await cp(join(DATA, 'packs', 'kuwait.json'), join(root, 'packs', 'kuwait.json'));
}

test.describe('HCl with an embedded map region', () => {
  test.skip(
    !existsSync(join(HCL, 'manifest.json')) || !existsSync(KUWAIT),
    `HCl or the Kuwait pack not found under ${DATA}`,
  );
  test.setTimeout(420_000);

  test('the player draws the basemap from the package, then a copy is extracted and annotated', async () => {
    const base = await mkdtemp(join(tmpdir(), 'aio-x1-'));
    const file = join(base, 'HCl customer.aio');
    const builder: DataRoot = {
      base,
      root: fwd(join(base, 'builder-data')),
      userData: join(base, 'builder-user'),
      projectId: 'hcl',
      projectDir: join(base, 'builder-data', 'projects', 'hcl'),
    };
    try {
      await hclCopy(builder.root);
      const issuesBefore = JSON.parse(
        await readFile(join(builder.projectDir, 'issues.json'), 'utf8'),
      ) as { issues: unknown[] };

      // 1. The builder exports the package with the Kuwait region around the tank.
      const network = new NetworkGuard();
      const app = await launchApp(builder);
      await network.attach(app);
      try {
        const win = await app.firstWindow();
        await win.waitForLoadState('domcontentloaded');
        await app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
        });
        await win.getByTestId('project-card').filter({ hasText: 'HCl' }).first().click();
        await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
        await win.locator('.nav-item', { hasText: 'Reports' }).first().click();
        await win.getByTestId('export-package').click();
        const dialog = win.getByTestId('package-export');
        await expect(dialog.getByTestId('pkg-size')).not.toContainText('...');
        const before = await dialog.getByTestId('pkg-size').innerText();
        await dialog.getByRole('switch', { name: 'Include the map region for this site' }).click();
        await dialog.getByLabel('Detail up to zoom').selectOption('14');
        const size = dialog.getByTestId('pkg-map-size');
        await expect(size).toContainText(/From Kuwait streets: \d+ tiles, [\d.]+ (KB|MB)/);
        await expect(dialog.getByTestId('pkg-size')).not.toHaveText(before);
        await dialog
          .getByRole('switch', { name: 'Allow the customer to extract an editable copy' })
          .click();
        await shot(win, 'x1-01-export-dialog');
        await stubSaveDialog(app, file);
        await dialog.getByTestId('pkg-export').click();
        await expect(dialog.getByTestId('pkg-done')).toBeVisible({ timeout: 180_000 });
        expect(await network.outbound()).toEqual([]);
      } finally {
        await app.close();
      }
      const pkgBytes = (await stat(file)).size;
      const pkgTime = (await stat(file)).mtimeMs;

      // 2. A customer opens it on a machine with an empty packs folder.
      const customer: DataRoot = {
        base,
        root: fwd(join(base, 'customer-data')),
        userData: join(base, 'customer-user'),
        projectId: '',
        projectDir: '',
      };
      await mkdir(join(customer.root, 'packs'), { recursive: true });
      const guard = new NetworkGuard();
      const c = await launchApp(customer, {}, [file]);
      await guard.attach(c);
      try {
        const win = await c.firstWindow();
        await win.waitForLoadState('domcontentloaded');
        await c.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
        });
        await expect(win.getByTestId('welcome')).toContainText('HCl Tank 710-D-130335');
        const packs = await win.evaluate(() =>
          (
            window as unknown as {
              aio: { invoke(c: string, r: object): Promise<{ id: string; source?: string }[]> };
            }
          ).aio.invoke('packs:list', {}),
        );
        expect(packs).toEqual([
          expect.objectContaining({ id: 'pkg-hcl-customer-kuwait', source: 'package' }),
        ]);
        await shot(win, 'x1-02-welcome');

        // The map draws the street basemap from inside the package.
        await win.getByTestId('welcome-start').click();
        await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
        await win.keyboard.press('2');
        await expect(win.locator('.maplibregl-canvas')).toBeVisible({ timeout: 20_000 });
        await expect.poll(() => basemapFeatures(win), { timeout: 30_000 }).toBeGreaterThan(10);
        await win.waitForTimeout(1500);
        await shot(win, 'x1-03-player-basemap');
        await win.keyboard.press('1');

        // 3. Extract to edit: a new project in the customer's data folder opens.
        await win.locator('.nav-item', { hasText: 'Reports' }).first().click();
        await win.getByTestId('extract-to-edit').click();
        await expect(win.getByTestId('origin-chip')).toHaveText('Copy of HCl customer.aio', {
          timeout: 120_000,
        });
        await expect(win.getByTestId('readonly-chip')).toHaveCount(0);
        const editRoot = join(customer.root, 'projects', 'hcl-customer-edit');
        const origin = JSON.parse(
          await readFile(join(editRoot, 'package-origin.json'), 'utf8'),
        ) as { package: string; exportedAt: string };
        expect(origin.package).toBe('HCl customer.aio');
        await shot(win, 'x1-04-extracted');

        // 4. Annotate the copy: a pin on the tank becomes an issue saved in the new folder.
        await win.locator('.nav-item', { hasText: 'Scene' }).first().click();
        await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
        await win.evaluate(() => {
          const ws = (window as unknown as StratlasWindow).__stratlas.workspace.getState();
          ws.setLayerVisible('photos', false);
          ws.flyTo({ kind: 'home' });
        });
        await win.waitForTimeout(2500);
        await win.locator('[data-scene-view] canvas').click({ position: { x: 5, y: 5 } });
        await win.keyboard.press('a');
        await win.locator('.ann-subbar').getByRole('button', { name: 'Pin' }).click();
        await expect.poll(async () => (await meshHits(win, 'tank')).length).toBeGreaterThan(0);
        const hits = await meshHits(win, 'tank');
        const pin = hits[Math.floor(hits.length / 2)];
        if (!pin) throw new Error('no point on the tank');
        await win.mouse.click(pin.x, pin.y);
        const pop = win.getByRole('dialog', { name: 'New issue' });
        await expect(pop).toBeVisible();
        await pop.getByRole('listbox', { name: 'Class' }).getByRole('button').first().click();
        await pop.getByRole('group', { name: 'Severity' }).getByRole('button').nth(1).click();
        await pop.getByRole('button', { name: 'Create issue' }).click();
        await expect
          .poll(
            async () =>
              (
                JSON.parse(await readFile(join(editRoot, 'issues.json'), 'utf8')) as {
                  issues: unknown[];
                }
              ).issues.length,
            { timeout: 15_000 },
          )
          .toBe(issuesBefore.issues.length + 1);
        await shot(win, 'x1-05-annotated-copy');
        expect(await guard.outbound()).toEqual([]);
      } finally {
        await c.close();
      }
      // The package file itself was never written.
      expect((await stat(file)).size).toBe(pkgBytes);
      expect((await stat(file)).mtimeMs).toBe(pkgTime);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

const QATAR: [number, number, number, number] = [50.74, 24.47, 51.65, 26.2];

test('a map pack download cut off by quitting the app resumes from its partial file', async () => {
  test.setTimeout(180_000);
  // A planet build stand-in over Qatar, served from this machine only.
  const build = pmtilesArchive({
    tiles: tilesOver(QATAR, 0, 10, (z, x, y) =>
      noise(`${String(z)}/${String(x)}/${String(y)}`, 4000),
    ),
    bbox: QATAR,
    leafSize: 16,
  });
  const server = await rangeServer(() => build, '/20261003.pmtiles', {
    '/builds.json': JSON.stringify([{ key: '20261003.pmtiles' }]),
  });
  const origin = new URL(server.url).origin;
  const env = { STRATLAS_PACK_SOURCE: `${origin}/`, AIO_NETWORK_GUARD_ALLOW: origin };
  const base = await mkdtemp(join(tmpdir(), 'aio-x1-dl-'));
  const data: DataRoot = {
    base,
    root: fwd(join(base, 'data')),
    userData: join(base, 'user'),
    projectId: '',
    projectDir: '',
  };
  const part = join(base, 'data', 'packs', '.downloads', 'qatar-z10.pmtiles.part');
  await mkdir(join(data.root, 'packs'), { recursive: true });
  try {
    // 1. Start the download; the server sends some tile data, then stalls.
    server.stallAfter(30_000, 20_000);
    const first = new NetworkGuard([origin]);
    const app = await launchApp(data, env);
    await first.attach(app);
    try {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      await win.locator('.nav-item', { hasText: 'Settings' }).click();
      await win.locator('.set-nav button', { hasText: 'Offline maps' }).click();
      await win.getByRole('button', { name: 'Add a region' }).click();
      const panel = win.getByTestId('add-region');
      await panel.getByLabel('Country').selectOption('qatar');
      await panel.getByLabel('Maximum zoom').selectOption('10');
      await panel.getByRole('button', { name: /^Download/ }).click();
      const job = win.getByTestId('pack-job');
      await expect(job).toContainText('Downloading');
      await expect
        .poll(async () => (existsSync(part) ? (await stat(part)).size : 0))
        .toBeGreaterThan(20_000);
      await shot(win, 'x1-06-download-running');
      expect(await first.outbound()).toEqual([]);
      expect((await first.allowed()).every((u) => u.startsWith(origin))).toBe(true);
    } finally {
      // 2. Quit mid-download.
      await app.close();
    }
    const partial = (await stat(part)).size;
    expect(partial).toBeGreaterThan(20_000);

    // 3. Next session: the job is interrupted with its bytes kept; Resume continues from there.
    server.stallAfter(null);
    server.ranges.length = 0;
    const second = new NetworkGuard([origin]);
    const again = await launchApp(data, env);
    await second.attach(again);
    try {
      const win = await again.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      await win.locator('.nav-item', { hasText: 'Settings' }).click();
      await win.locator('.set-nav button', { hasText: 'Offline maps' }).click();
      const job = win.getByTestId('pack-job');
      await expect(job).toContainText('Interrupted');
      await expect(job).toContainText('Resume continues from there');
      await shot(win, 'x1-07-interrupted');
      await job.getByRole('button', { name: 'Resume' }).click();
      const row = win.getByTestId('pack-table').locator('tr', { hasText: 'qatar-z10' });
      await expect(row).toBeVisible({ timeout: 60_000 });
      await expect(row).toContainText('Downloaded');
      await shot(win, 'x1-08-resumed');
      // The resume asked only for the missing tile data, from where the partial file ended.
      expect(server.ranges).not.toContain('bytes=0-16383');
      const starts = server.ranges.map((r) => Number(/^bytes=(\d+)-/.exec(r)?.[1] ?? -1));
      expect(Math.min(...starts)).toBeGreaterThan(16_384);
      expect(await second.outbound()).toEqual([]);
    } finally {
      await again.close();
    }
    expect(existsSync(part)).toBe(false);
    expect((await stat(join(base, 'data', 'packs', 'qatar-z10.pmtiles'))).size).toBeGreaterThan(
      partial,
    );
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
