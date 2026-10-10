/**
 * Street maps for the places of the library's projects (Settings, Offline maps, "Maps for your
 * projects"): the panel lists the missing areas with their sizes, an offline-only workstation
 * downloads nothing and says why, Download queues the chosen areas through the pack manager, and
 * the notice of an opened project leads to the same panel. The planet build is a stand-in served
 * from 127.0.0.1; nothing is ever fetched from the internet (the zero-network guard checks it).
 */
import { defaultGlobeSettings, ProjectManifest, type ProjectManifestInput } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { noise, pmtilesArchive, rangeServer, tilesOver } from '../src/main/testing';
import {
  createDataRoot,
  expect,
  launchApp,
  NetworkGuard,
  test,
  tinyGlb,
  tinyManifest,
  type DataRoot,
} from './fixtures';

// each test starts its own app (some two): room for a slow start on a busy machine
test.describe.configure({ timeout: 180_000 });

const SHOTS = process.env.QUADRION_SHOTS;
const shot = async (win: Page, name: string) => {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};

/** Made-up sites: one in Qatar (UTM 39N), one in Oman (UTM 40N), one with no place on the Earth. */
const SITES: Pick<ProjectManifestInput, 'id' | 'name' | 'crs' | 'origin'>[] = [
  { id: 'harbour-yard', name: 'Harbour Yard', crs: { epsg: 32639 }, origin: [553000, 2797000, 0] },
  { id: 'hill-quarry', name: 'Hill Quarry', crs: { epsg: 32640 }, origin: [643000, 2611000, 0] },
  {
    id: 'shed-model',
    name: 'Shed Model',
    crs: { wkt: 'LOCAL_CS["Site grid",UNIT["metre",1]]' },
    origin: [0, 0, 0],
  },
];
/** The stand-in planet build: full detail around the Qatar site only. */
const BUILD_BOX: [number, number, number, number] = [51.3, 25.1, 51.75, 25.5];

/** A data root with the three sites, and a profile whose street map notice is on (the default). */
async function sitesRoot(projectMaps: { offer?: boolean; auto?: boolean } = {}): Promise<DataRoot> {
  const data = await createDataRoot();
  await rm(data.projectDir, { recursive: true, force: true });
  for (const s of SITES) {
    const dir = join(data.root, 'projects', s.id);
    await mkdir(join(dir, 'models'), { recursive: true });
    const manifest = ProjectManifest.parse({ ...tinyManifest(), ...s, site: 'Synthetic site' });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
    await writeFile(
      join(dir, 'issues.json'),
      JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
    );
  }
  await writeFile(
    join(data.userData, 'globe.json'),
    JSON.stringify({ ...defaultGlobeSettings(), projectMaps }, null, 2),
  );
  return data;
}

async function openSettings(win: Page, page: string): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: page }).click();
  await expect(win.locator('.set-page h1')).toHaveText(page);
}

async function firstWindow(app: ElectronApplication): Promise<Page> {
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return win;
}

const packFiles = async (data: DataRoot) =>
  (await readdir(join(data.root, 'packs'))).filter((n) => n.endsWith('.pmtiles')).sort();

test('lists the areas the projects lack with their sizes; offline-only downloads nothing and says why', async () => {
  const data = await sitesRoot();
  const guard = new NetworkGuard();
  const app = await launchApp(data);
  await guard.attach(app);
  try {
    const win = await firstWindow(app);
    await openSettings(win, 'Offline maps');
    const panel = win.getByTestId('project-maps');
    await expect(panel.getByRole('heading', { name: /Maps for your projects/ })).toBeVisible();
    await expect(panel.getByTestId('project-maps-summary')).toHaveText(
      '2 of 3 projects have no detailed street map',
    );
    await expect(panel.getByTestId('project-maps-unplaced')).toContainText(
      '1 project is not placed on the Earth',
    );

    // a box per site, an overview per country, the world: nothing else
    const rows = panel.getByTestId('project-maps-region');
    await expect(rows).toHaveCount(5);
    const labels = [
      'Site area: Harbour Yard',
      'Site area: Hill Quarry',
      'Oman overview',
      'Qatar overview',
      'World overview',
    ];
    for (const [i, label] of labels.entries()) {
      await expect(rows.nth(i)).toContainText(label);
      await expect(rows.nth(i)).toContainText(/about \d/);
      await expect(panel.getByLabel(`Include ${label}`)).toBeChecked();
    }
    await expect(rows.nth(0)).toContainText('Zoom 15: full detail');
    await expect(rows.nth(3)).toContainText('Zoom 10: country overview');
    await expect(rows.nth(4)).toContainText('Zoom 6: world overview');
    const total = panel.getByTestId('project-maps-total');
    await expect(total).toHaveText(/^about \d+ MB$/);
    await expect(panel).toContainText('Total, 5 areas');
    await expect(panel).toContainText('build.protomaps.com');
    const all = (await total.textContent()) ?? '';
    await expect(panel.getByRole('button', { name: `Download ${all}` })).toBeEnabled();
    await shot(win, 'project-maps-panel');

    // unticking leaves an area out of the total and of the button
    for (const label of labels.slice(0, 4)) await panel.getByLabel(`Include ${label}`).uncheck();
    await expect(panel).toContainText('Total, 1 area');
    const world = (await rows.nth(4).locator('td').nth(4).textContent()) ?? '';
    expect(world).toMatch(/^about \d+ MB$/);
    await expect(total).toHaveText(world);
    await expect(panel.getByRole('button', { name: `Download ${world}` })).toBeEnabled();
    await panel.getByLabel('Include World overview').uncheck();
    await expect(panel.getByRole('button', { name: 'Download', exact: true })).toBeDisabled();
    await panel.getByLabel('Include World overview').check();

    // the automatic download is opt-in
    await expect(
      panel.getByRole('switch', { name: 'Download street maps for new projects automatically' }),
    ).toHaveAttribute('aria-checked', 'false');

    // offline-only: the list stays, Download is off, and the panel says how to get maps
    await openSettings(win, 'Privacy and cloud');
    await win.getByRole('switch', { name: 'Offline-only workstation' }).click();
    await openSettings(win, 'Offline maps');
    const note = win.getByTestId('project-maps-offline');
    await expect(note).toContainText('Offline only, so nothing is downloaded');
    await expect(note).toContainText('switch to Online in the title bar');
    await expect(note).toContainText('Privacy and cloud');
    await expect(note).toContainText('Import pack file');
    await expect(win.getByTestId('project-maps-region')).toHaveCount(5);
    await expect(
      win.getByTestId('project-maps').getByRole('button', { name: /^Download about/ }),
    ).toBeDisabled();
    await shot(win, 'project-maps-offline-only');
    // nor does opening a project without a street map say or start anything
    await win.locator('.nav-item', { hasText: 'Projects' }).click();
    await win.getByTestId('project-card').filter({ hasText: 'Harbour Yard' }).click();
    await expect(win.locator('.crumbs')).toContainText('Harbour Yard');
    await expect(win.getByTestId('project-map-notice')).toHaveCount(0);
    expect(await readdir(join(data.root, 'packs'))).toEqual([]);
    expect(await guard.outbound()).toEqual([]);
  } finally {
    await app.close();
    await rm(data.base, { recursive: true, force: true });
  }
});

test('an opened project without a detailed street map says so once and leads to the panel', async () => {
  const data = await sitesRoot();
  const guard = new NetworkGuard();
  const app = await launchApp(data);
  await guard.attach(app);
  try {
    const win = await firstWindow(app);
    await win.getByTestId('project-card').filter({ hasText: 'Harbour Yard' }).click();
    const notice = win.getByTestId('project-map-notice');
    await expect(notice).toContainText('No detailed street map here');
    await expect(notice).toContainText('Harbour Yard has no detailed street map');
    await expect(notice).toContainText('build.protomaps.com');
    // it names the areas and the size before anything is asked of the map host
    for (const label of ['Site area: Harbour Yard', 'Qatar overview', 'World overview'])
      await expect(notice).toContainText(label);
    await expect(notice).not.toContainText('Hill Quarry');
    await expect(notice.getByRole('button', { name: /^Download about \d+ MB$/ })).toBeVisible();
    await shot(win, 'project-maps-notice');

    await notice.getByRole('button', { name: 'Choose areas' }).click();
    await expect(win.locator('.set-page h1')).toHaveText('Offline maps');
    await expect(win.getByTestId('project-maps-region')).toHaveCount(5);
    await expect(notice).toHaveCount(0);

    // answered: the same project does not ask again; a project that is not placed never asks
    await win.locator('.nav-item', { hasText: 'Projects' }).click();
    await win.getByTestId('project-card').filter({ hasText: 'Shed Model' }).click();
    await expect(win.locator('.crumbs')).toContainText('Shed Model');
    await win.locator('.nav-item', { hasText: 'Projects' }).click();
    await win.getByTestId('project-card').filter({ hasText: 'Harbour Yard' }).click();
    await expect(win.locator('.crumbs')).toContainText('Harbour Yard');
    await expect(notice).toHaveCount(0);
    expect(await readdir(join(data.root, 'packs'))).toEqual([]);
    expect(await guard.outbound()).toEqual([]);
  } finally {
    await app.close();
    await rm(data.base, { recursive: true, force: true });
  }
});

test.describe('with a planet build stand-in on 127.0.0.1', () => {
  async function standIn() {
    const build = pmtilesArchive({
      tiles: tilesOver(BUILD_BOX, 0, 15, (z, x, y) =>
        noise(`${String(z)}/${String(x)}/${String(y)}`, 300),
      ),
      bbox: BUILD_BOX,
      leafSize: 16,
    });
    const server = await rangeServer(() => build, '/20261003.pmtiles', {
      '/builds.json': JSON.stringify([{ key: '20261003.pmtiles' }]),
    });
    const origin = new URL(server.url).origin;
    const env = { QUADRION_PACK_SOURCE: `${origin}/`, AIO_NETWORK_GUARD_ALLOW: origin };
    return { server, origin, env };
  }

  test('Download queues the chosen areas in Downloads; packs left without a project can be removed', async () => {
    const { server, origin, env } = await standIn();
    const data = await sitesRoot();
    const guard = new NetworkGuard([origin]);
    const app = await launchApp(data, env);
    await guard.attach(app);
    try {
      const win = await firstWindow(app);
      await openSettings(win, 'Offline maps');
      const panel = win.getByTestId('project-maps');
      await expect(panel.getByTestId('project-maps-region')).toHaveCount(5);
      // the stand-in has no Oman: leave those two areas out
      await panel.getByLabel('Include Site area: Hill Quarry').uncheck();
      await panel.getByLabel('Include Oman overview').uncheck();
      await expect(panel).toContainText('Total, 3 areas');
      expect(server.ranges).toEqual([]);
      await panel.getByRole('button', { name: /^Download about/ }).click();

      // the same Downloads list, verification and install as a region added by hand
      const jobs = win.getByTestId('pack-job');
      await expect(jobs).toHaveCount(3);
      for (const label of ['Site area: Harbour Yard', 'Qatar overview', 'World overview'])
        await expect(jobs.filter({ hasText: label })).toContainText('Installed', {
          timeout: 120_000,
        });
      const table = win.getByTestId('pack-table');
      for (const id of [
        /prj-site-harbour-yard-e\d+n\d+-z15/,
        'prj-country-qatar-z10',
        'prj-world-z6',
      ])
        await expect(table.locator('tr', { hasText: id })).toContainText('Downloaded');
      expect(await packFiles(data)).toEqual([
        'prj-country-qatar-z10.pmtiles',
        expect.stringMatching(/^prj-site-harbour-yard-e\d+n\d+-z15\.pmtiles$/),
        'prj-world-z6.pmtiles',
      ]);

      // only what was left out is still listed, and one project is still without its map
      await expect(panel.getByTestId('project-maps-region')).toHaveCount(2);
      await expect(panel.getByTestId('project-maps-region').nth(0)).toContainText('Hill Quarry');
      await expect(panel.getByTestId('project-maps-region').nth(1)).toContainText('Oman overview');
      await expect(panel.getByTestId('project-maps-summary')).toHaveText(
        '1 of 3 projects has no detailed street map',
      );
      await shot(win, 'project-maps-after-download');
      expect(await guard.outbound()).toEqual([]);
      expect((await guard.allowed()).every((u) => u.startsWith(origin))).toBe(true);
    } finally {
      await app.close();
    }

    // the Qatar project leaves the library: its two packs cover no project any more
    await rm(join(data.root, 'projects', 'harbour-yard'), { recursive: true, force: true });
    const again = await launchApp(data, env);
    const second = new NetworkGuard([origin]);
    await second.attach(again);
    try {
      const win = await firstWindow(again);
      await openSettings(win, 'Offline maps');
      const orphans = win.getByTestId('project-maps-orphans');
      await expect(orphans).toContainText('2 packs cover areas with no project any more');
      await orphans.getByRole('button', { name: 'Review' }).click();
      await expect(orphans).toContainText('Site area: Harbour Yard');
      await expect(orphans).toContainText('Qatar overview');
      await expect(orphans).not.toContainText('World overview');
      // the Remove flow of the page, with its confirmation
      const site = orphans.locator('.pm-orphan', { hasText: 'Site area: Harbour Yard' });
      await site.getByRole('button', { name: 'Remove' }).click();
      await site.getByRole('button', { name: 'Remove Site area: Harbour Yard' }).click();
      await expect(orphans).toContainText('1 pack covers an area with no project any more');
      await expect(orphans).not.toContainText('Site area: Harbour Yard');
      expect(await packFiles(data)).toEqual([
        'prj-country-qatar-z10.pmtiles',
        'prj-world-z6.pmtiles',
      ]);
      expect(await second.outbound()).toEqual([]);
    } finally {
      await again.close();
      await server.close();
      await rm(data.base, { recursive: true, force: true });
    }
  });

  test('with the automatic preference on, a newly opened project queues its areas and says so', async () => {
    const { server, origin, env } = await standIn();
    const data = await sitesRoot();
    const guard = new NetworkGuard([origin]);
    const app = await launchApp(data, env);
    await guard.attach(app);
    try {
      const win = await firstWindow(app);
      await openSettings(win, 'Offline maps');
      const auto = win
        .getByTestId('project-maps')
        .getByRole('switch', { name: 'Download street maps for new projects automatically' });
      await auto.click();
      await expect(auto).toHaveAttribute('aria-checked', 'true');
      // kept in the profile's globe.json, beside the Globe's own preferences
      await expect
        .poll(async () => {
          const saved = JSON.parse(await readFile(join(data.userData, 'globe.json'), 'utf8')) as {
            projectMaps?: { auto?: boolean };
            imagery?: string;
          };
          return [saved.projectMaps?.auto, saved.imagery];
        })
        .toEqual([true, 'auto']);
      expect(server.ranges).toEqual([]);
      expect(existsSync(join(data.root, 'packs', '.downloads'))).toBe(false);

      await win.locator('.nav-item', { hasText: 'Projects' }).click();
      await win.getByTestId('project-card').filter({ hasText: 'Harbour Yard' }).click();
      const notice = win.getByTestId('project-map-notice');
      await expect(notice).toContainText('Street maps are downloading');
      await expect(notice).toContainText('3 areas for Harbour Yard are in Downloads');
      await expect(notice).toContainText('turn this off in Settings, Offline maps');
      await shot(win, 'project-maps-auto');
      await notice.getByRole('button', { name: 'Show downloads' }).click();
      await expect(win.locator('.set-page h1')).toHaveText('Offline maps');
      const jobs = win.getByTestId('pack-job');
      await expect(jobs).toHaveCount(3);
      for (const label of ['Site area: Harbour Yard', 'Qatar overview', 'World overview'])
        await expect(jobs.filter({ hasText: label })).toContainText('Installed', {
          timeout: 120_000,
        });
      expect(await packFiles(data)).toHaveLength(3);
      expect(await guard.outbound()).toEqual([]);
      expect((await guard.allowed()).every((u) => u.startsWith(origin))).toBe(true);
    } finally {
      await app.close();
      await server.close();
      await rm(data.base, { recursive: true, force: true });
    }
  });
});
