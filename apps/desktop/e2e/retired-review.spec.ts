import { writeZip } from '@aio/project/package';
import { ProjectManifest, SCHEMA_VERSION } from '@aio/schema';
import type { Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, test, type DataRoot } from './fixtures';

/**
 * Projects imported before 11 Oct 2026 keep a `legacy` layer and the delivered viewer under
 * `legacy/`. The app no longer shows that viewer: such a project opens like any other, with no
 * trace of the layer in the sidebar, the tree or the command search.
 */
const VIEWER = 'Old review viewer';

const HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Retired viewer fixture</title></head>
<body><h1>Retired viewer fixture</h1></body>
</html>
`;

const OUTLINE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [47.9, 29.3],
          [47.901, 29.301],
        ],
      },
    },
  ],
};

function manifestOf(id: string, name: string, withOutline: boolean) {
  return ProjectManifest.parse({
    schema: SCHEMA_VERSION,
    id,
    name,
    customer: 'E2E',
    crs: { epsg: 32639 },
    origin: [0, 0, 0],
    captures: [],
    layers: [
      {
        kind: 'legacy',
        id: 'review',
        name: VIEWER,
        viewer: 'volumetric',
        entry: { path: 'legacy/Old Review.html' },
      },
      ...(withOutline
        ? [
            {
              kind: 'vector',
              id: 'outline',
              name: 'Site outline',
              src: { path: 'vectors/outline.geojson' },
              format: 'geojson',
            },
          ]
        : []),
    ],
    severityModels: [],
    classCatalogues: [],
  });
}

async function writeProject(dataRoot: string, id: string, name: string, withOutline: boolean) {
  const dir = join(dataRoot, 'projects', id);
  await mkdir(join(dir, 'legacy', 'data'), { recursive: true });
  const manifest = manifestOf(id, name, withOutline);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, 'legacy', 'Old Review.html'), HTML);
  await writeFile(join(dir, 'legacy', 'data', 'site.js'), 'window.SITE_LOADED = true;\n');
  if (withOutline) {
    await mkdir(join(dir, 'vectors'), { recursive: true });
    await writeFile(join(dir, 'vectors', 'outline.geojson'), JSON.stringify(OUTLINE));
  }
}

/** Nothing of the retired viewer is offered anywhere in the window. */
async function expectNoReview(win: Page) {
  await expect(win.locator('.nav-item[aria-current="page"] .lbl')).toHaveText('Scene');
  await expect(win.locator('.sb-nav .nav-item', { hasText: 'Scene' })).toBeVisible();
  await expect(win.locator('.sb-nav .nav-item', { hasText: 'Original review' })).toHaveCount(0);
  await expect(win.getByTestId('tree-row-review')).toHaveCount(0);
  await expect(win.getByRole('treeitem').filter({ hasText: VIEWER })).toHaveCount(0);
  await expect(win.locator('iframe')).toHaveCount(0);

  await win.keyboard.press('Control+K');
  const palette = win.getByRole('dialog', { name: 'Command search' });
  await expect(palette).toBeVisible();
  const box = palette.getByRole('combobox');
  // The list answers what is typed: a known command first, so an empty answer means something.
  await box.fill('settings');
  await expect(palette.getByRole('option').first()).toBeVisible();
  await box.fill('original review');
  await expect(palette.getByRole('option').filter({ hasText: /original review/i })).toHaveCount(0);
  await box.fill(VIEWER);
  await expect(palette.getByRole('option').filter({ hasText: VIEWER })).toHaveCount(0);
  await win.keyboard.press('Escape');
  await expect(palette).toBeHidden();
}

test('a project that only holds a retired viewer opens on Scene', async ({ dataRoot, network }) => {
  await writeProject(dataRoot.root, 'e2e-retired-only', 'E2E retired viewer only', false);
  const app = await launchApp(dataRoot);
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    await win.getByTestId('project-card').filter({ hasText: 'E2E retired viewer only' }).click();
    await expectNoReview(win);
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});

test('a retired viewer has no row beside the other datasets', async ({ dataRoot, network }) => {
  await writeProject(dataRoot.root, 'e2e-retired-mixed', 'E2E retired viewer mixed', true);
  const app = await launchApp(dataRoot);
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    await win.getByTestId('project-card').filter({ hasText: 'E2E retired viewer mixed' }).click();
    await expect(win.getByTestId('tree-row-outline')).toBeVisible();
    await expectNoReview(win);
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});

test('a package made while the viewer was still shown opens without it', async ({ dataRoot }) => {
  const file = join(dataRoot.base, 'older.aio');
  const manifest = manifestOf('e2e-retired-package', 'E2E older package', true);
  await writeZip(file, [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: 'legacy/Old Review.html', data: Buffer.from(HTML) },
    { name: 'legacy/data/site.js', data: Buffer.from('window.SITE_LOADED = true;\n') },
    { name: 'vectors/outline.geojson', data: Buffer.from(JSON.stringify(OUTLINE)) },
  ]);
  const customer: DataRoot = {
    base: dataRoot.base,
    root: join(dataRoot.base, 'customer-data'),
    userData: join(dataRoot.base, 'customer-user'),
    projectId: '',
    projectDir: '',
  };
  await mkdir(customer.root, { recursive: true });
  const network = new NetworkGuard();
  const app = await launchApp(customer, {}, [file]);
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    await expect(win.getByTestId('welcome')).toContainText('E2E older package');
    await expect(win.getByTestId('readonly-chip')).toHaveText('Read-only package');
    await expect(win.getByTestId('welcome')).not.toContainText(/original review/i);
    await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).click();
    await expect(win.getByTestId('tree-row-outline')).toBeVisible();
    await expectNoReview(win);
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});
