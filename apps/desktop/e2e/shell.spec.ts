import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleIssue, sampleManifest, writeProject } from '../src/main/testing';
import { GPU_ARGS, quietStreetMapOffer } from './fixtures';

const ALLOWED = ['file:', 'aio:', 'devtools:', 'data:', 'blob:', 'chrome-extension:'];

async function launch(dataRoot: string, base: string) {
  // the opened project is placed on the Earth: no street map notice over the controls
  await quietStreetMapOffer(join(base, 'user'));
  const app = await electron.launch({
    args: [...GPU_ARGS, join(import.meta.dirname, '../out/main/index.js')],
    env: { ...process.env, QUADRION_USER_DATA: join(base, 'user'), QUADRION_DATA: dataRoot },
  });
  const outbound: string[] = [];
  app.context().on('request', (req) => {
    if (!ALLOWED.includes(new URL(req.url()).protocol)) outbound.push(req.url());
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, outbound };
}

test('an empty library explains where projects live', async () => {
  const base = await mkdtemp(join(tmpdir(), 'quadrion-shell-'));
  const dataRoot = join(base, 'data');
  await mkdir(join(dataRoot, 'projects'), { recursive: true });
  let app: ElectronApplication | undefined;
  try {
    const run = await launch(dataRoot, base);
    app = run.app;
    const { win } = run;
    await expect(
      win.getByRole('heading', { name: 'No projects in the library yet' }),
    ).toBeVisible();
    await expect(win.locator('.lib-empty')).toContainText(join(dataRoot, 'projects'));
    await expect(
      win.locator('.lib-empty').getByRole('button', { name: 'Add project folder' }),
    ).toBeVisible();
    expect(run.outbound).toEqual([]);
  } finally {
    await app?.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('open a project, drive the shell and keep the sidebar state', async () => {
  const base = await mkdtemp(join(tmpdir(), 'quadrion-shell-'));
  const dataRoot = join(base, 'data');
  await writeProject(join(dataRoot, 'projects', 'alzour'), sampleManifest(), {
    'issues.json': JSON.stringify({ schema: 'aio.issues/1', issues: [sampleIssue()] }),
  });
  let app: ElectronApplication | undefined;
  try {
    const run = await launch(dataRoot, base);
    app = run.app;
    const { win } = run;

    // Library card opens the project into the workspace.
    const card = win.getByTestId('project-card').filter({ hasText: 'Al-Zour LNG Terminal' });
    await expect(card).toBeVisible();
    await card.click();
    await expect(win.locator('.crumbs')).toContainText('Al-Zour LNG Terminal');
    await expect(win.locator('.crumbs b')).toHaveText('Scene');

    // Dataset tree groups the manifest layers with counts.
    const tree = win.getByRole('tree', { name: 'Datasets' });
    await expect(tree.locator('.tgroup-btn', { hasText: 'Models' })).toContainText('1');
    await expect(tree.locator('.tgroup-btn', { hasText: 'Video' })).toContainText('2');
    await expect(tree.locator('.tgroup-btn', { hasText: 'Annotations' })).toContainText('1');

    // Hiding a layer goes through the workspace.
    await tree.locator('.titem', { hasText: 'Plant model' }).hover();
    await tree.getByRole('button', { name: 'Hide Plant model' }).click();
    await expect(tree.getByRole('button', { name: 'Show Plant model' })).toBeVisible();

    // Timeline: the first clip is active and the clock sits at its start.
    await expect(win.getByTestId('timecode')).toContainText('09:00:00');
    // Pause once the clock has moved, however slowly this machine draws frames.
    await win.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(win.getByTestId('timecode')).not.toContainText('09:00:00.00');
    await win.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(win.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await expect(win.getByTestId('timecode')).not.toContainText('09:00:00.00');

    // Ctrl+B collapses the sidebar and persists through settings.
    await win.keyboard.press('Control+B');
    await expect(win.locator('.app')).toHaveAttribute('data-sb', 'collapsed');
    await expect
      .poll(() =>
        win.evaluate(() => window.aio.invoke('settings:get', {}).then((s) => s.sidebarCollapsed)),
      )
      .toBe(true);
    await win.keyboard.press('Control+B');
    await expect(win.locator('.app')).toHaveAttribute('data-sb', 'expanded');

    // Ctrl+K palette finds an issue and opens it in the Issues view.
    await win.keyboard.press('Control+K');
    const palette = win.getByRole('dialog', { name: 'Command search' });
    await expect(palette).toBeVisible();
    await win.keyboard.type('F01');
    await win.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect(win.locator('.crumbs b')).toHaveText('Issues');

    // Settings: providers, routing and cloud AI off by default.
    await win.locator('.sb-foot .nav-item', { hasText: 'Settings' }).click();
    await expect(win.getByRole('heading', { name: 'AI providers' })).toBeVisible();
    await expect(win.getByLabel('Anthropic API key')).toHaveAttribute('type', 'password');
    await expect(win.getByLabel('Provider for Agent chat')).toBeVisible();
    await expect(win.getByTestId('connection-chip')).toHaveText('Online');
    await expect(win.getByTestId('cloud-chip')).toHaveText('Cloud AI off');

    expect(run.outbound).toEqual([]);
  } finally {
    await app?.close();
    await rm(base, { recursive: true, force: true });
  }
});
