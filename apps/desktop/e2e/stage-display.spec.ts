/**
 * Flight paths and point cloud colour on the real projects (founder reports: "I cannot turn off
 * the flight paths on Al-Zour", "I can't find where to change point cloud colorization to
 * elevation"). Runs where E:\Stratlas Data (or STRATLAS_HCL_DATA) holds the projects; each
 * project's tests skip without it. Read-only: nothing is written to the projects.
 */
import { test as base, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard } from './fixtures';

const DATA = process.env.STRATLAS_HCL_DATA ?? 'E:\\Stratlas Data';
const has = (id: string) => existsSync(join(DATA, 'projects', id, 'manifest.json'));

interface Obj {
  name: string;
  type: string;
  visible: boolean;
  isPoints?: boolean;
  material?: { uniforms?: { uMode?: { value: number } } };
  children: Obj[];
  getObjectByName(n: string): Obj | undefined;
}

interface Inspect {
  __stratlas: {
    workspace: { getState(): { hidden: Record<string, true> } };
    stage(): { scene: Obj } | null;
  };
}

const test = base.extend<{ app: ElectronApplication; win: Page }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  app: async ({}, use) => {
    const tmp = await mkdtemp(join(tmpdir(), 'aio-display-'));
    const network = new NetworkGuard();
    const app = await launchApp({
      base: tmp,
      root: DATA,
      userData: join(tmp, 'user'),
      projectId: '',
      projectDir: '',
    });
    await network.attach(app);
    try {
      await use(app);
      expect(await network.outbound(), 'the app made network requests').toEqual([]);
    } finally {
      await app.close();
      await rm(tmp, { recursive: true, force: true });
    }
  },
  win: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    await use(win);
  },
});

test.setTimeout(180_000);

async function open(win: Page, card: string) {
  await win.getByTestId('project-card').filter({ hasText: card }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
}

/** Visible and total flight path lines, and whether the drone marker and frustum show. */
const rig = (win: Page) =>
  win.evaluate(() => {
    const scene = (window as unknown as Inspect).__stratlas.stage()?.scene;
    const group = scene?.getObjectByName('VideoRig');
    const lines = group?.children.filter((o) => o.type === 'Line') ?? [];
    return {
      shown: lines.filter((l) => l.visible).length,
      total: lines.length,
      drone: group?.getObjectByName('Drone')?.visible ?? false,
      frustum: group?.children.find((o) => o.type === 'LineSegments')?.visible ?? false,
    };
  });

/** The colour mode uniform of every loaded cloud chunk (EDL off: the points are in the scene). */
const cloudModes = (win: Page) =>
  win.evaluate(() => {
    const modes = new Set<number>();
    const visit = (o: Obj) => {
      const v = o.isPoints ? o.material?.uniforms?.uMode?.value : undefined;
      if (v !== undefined) modes.add(v);
      for (const c of o.children) visit(c);
    };
    const scene = (window as unknown as Inspect).__stratlas.stage()?.scene;
    if (scene) visit(scene);
    return [...modes];
  });

async function pathsTest(win: Page, card: string, flights: number) {
  await open(win, card);
  await expect.poll(async () => (await rig(win)).total, { timeout: 30_000 }).toBe(flights);
  // many clips: only the active clip's flight path draws at first
  await expect.poll(async () => (await rig(win)).shown).toBe(1);
  await expect.poll(async () => (await rig(win)).drone, { timeout: 20_000 }).toBe(true);

  const tool = win.getByRole('button', { name: 'Flight paths' });
  await expect(tool).toHaveAttribute('aria-keyshortcuts', 'P');
  await tool.click();
  const panel = win.getByTestId('path-panel');
  await panel.getByRole('button', { name: 'All', exact: true }).click();
  await expect.poll(async () => (await rig(win)).shown).toBe(flights);
  await panel.getByRole('button', { name: 'Off', exact: true }).click();
  await expect.poll(async () => (await rig(win)).shown).toBe(0);
  // hiding the paths keeps the drone, its frustum and every clip
  expect(await rig(win)).toMatchObject({ drone: true, frustum: true });
  await panel.getByRole('button', { name: 'Active clip' }).click();
  await expect.poll(async () => (await rig(win)).shown).toBe(1);
  await win.keyboard.press('Escape');

  // P turns them off and back on
  await win.keyboard.press('p');
  await expect.poll(async () => (await rig(win)).shown).toBe(0);
  await win.keyboard.press('p');
  await expect.poll(async () => (await rig(win)).shown).toBe(1);

  // the eye on the active flight's row hides its path only
  const hiddenBefore = await win.evaluate(
    () => Object.keys((window as unknown as Inspect).__stratlas.workspace.getState().hidden).length,
  );
  await win
    .getByRole('button', { name: /^Hide the flight path of / })
    .first()
    .click();
  await expect.poll(async () => (await rig(win)).shown).toBe(0);
  expect(
    await win.evaluate(
      () =>
        Object.keys((window as unknown as Inspect).__stratlas.workspace.getState().hidden).length,
    ),
  ).toBe(hiddenBefore);
  expect((await rig(win)).drone).toBe(true);
}

async function colourTest(win: Page, card: string, rgb: boolean) {
  await open(win, card);
  await win.getByRole('button', { name: 'Point cloud', exact: true }).click();
  const panel = win.getByTestId('cloud-panel');
  await expect(panel.getByRole('button', { name: 'Elevation' })).toBeVisible();
  const show = panel.getByRole('checkbox').first();
  if (!(await show.isChecked())) await show.check();
  await panel.getByRole('checkbox', { name: 'Eye-dome lighting' }).uncheck();
  const rgbButton = panel.getByRole('button', { name: 'RGB' });
  if (rgb) await expect(rgbButton).toBeEnabled();
  else {
    await expect(rgbButton).toBeDisabled();
    await expect(rgbButton).toHaveAttribute('title', /no colour/i);
  }
  await panel.getByRole('button', { name: 'Intensity' }).click();
  await expect.poll(() => cloudModes(win), { timeout: 30_000 }).toEqual([1]);
  await panel.getByRole('button', { name: 'Elevation' }).click();
  await expect.poll(() => cloudModes(win)).toEqual([2]);
  await win.keyboard.press('Escape');
  const legend = win.locator('[data-component="elevation-legend"]');
  await expect(legend).toBeVisible();
  await expect(legend).toHaveAttribute('aria-label', /^Elevation colour ramp from -?\d+\.\d m to/);

  // Ctrl+K reaches the same choice
  await win.keyboard.press('Control+k');
  await win.keyboard.type('colour point cloud by intensity');
  await win.keyboard.press('Enter');
  await expect.poll(() => cloudModes(win)).toEqual([1]);
  await expect(legend).toHaveCount(0);

  // and so does the settings button on the cloud row in the sidebar
  await win.locator('.tgroup-btn', { hasText: 'Point clouds' }).click();
  await win
    .getByRole('button', { name: /^Point cloud colour and display/ })
    .first()
    .click();
  await expect(panel).toBeVisible();
}

test.describe('Al-Zour', () => {
  test.skip(!has('alzour'), `Al-Zour project not found under ${DATA}`);
  test('flight paths: all, active clip only, off, P, and per flight', async ({ win }) => {
    await pathsTest(win, 'Al-Zour', 5);
  });
  test('point cloud colour by elevation with a legend (png-packed, RGB)', async ({ win }) => {
    await colourTest(win, 'Al-Zour', true);
  });
});

test.describe('HCl', () => {
  test.skip(!has('hcl'), `HCl project not found under ${DATA}`);
  test('flight paths: all, active clip only, off, P, and per flight', async ({ win }) => {
    await pathsTest(win, 'HCl', 10);
  });
  test('point cloud colour by elevation; RGB disabled for intensity-only clouds', async ({
    win,
  }) => {
    await colourTest(win, 'HCl', false);
  });
});
