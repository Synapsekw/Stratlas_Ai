/**
 * Flight paths, point cloud colour, issue pins and the timeline on the real projects (founder
 * reports: "I cannot turn off the flight paths on Al-Zour", "I can't find where to change point
 * cloud colorization to elevation", "DAMAC: issue labels are visible through the building", "the
 * timeline, does this make sense with no videos?", "turn off the anomaly tags with one click").
 * Runs where E:\Stratlas Data (or STRATLAS_HCL_DATA) holds the projects; each
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

/**
 * `groups`: the project has flights made of several clips, whose rows carry their own path eye
 * (Al-Zour). HCl has one whole clip per flight, so its rows are clips with the layer eye only.
 */
async function pathsTest(win: Page, card: string, flights: number, groups = true) {
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

  if (!groups) return;
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

interface PinLayoutDump {
  items: { kind: string; members: { issueId: string; p: [number, number, number] }[] }[];
  occluded: number;
}

/** The 3D pin layout: drawn items, pins in them, and pins on screen hidden by the model. */
const pinLayout = (win: Page) =>
  win.evaluate(() => {
    const scene = (window as unknown as Inspect).__stratlas.stage()?.scene;
    const group = scene?.getObjectByName('annotate-issue-pins') as
      { userData: { layout?: PinLayoutDump } } | undefined;
    const layout = group?.userData.layout;
    return layout
      ? {
          items: layout.items.length,
          pins: layout.items.reduce((n, i) => n + i.members.length, 0),
          occluded: layout.occluded,
        }
      : null;
  });

/**
 * Drawn pins (alone or in a badge) that a ray from the camera finds behind the model (an independent check of
 * the depth snapshot with the engine's raycast), and how many were checked.
 */
const pinsBehind = (win: Page) =>
  win.evaluate(() => {
    interface V {
      clone(): V;
      set(x: number, y: number, z: number): V;
      sub(v: V): V;
      length(): number;
    }
    const stage = (window as unknown as Inspect).__stratlas.stage() as unknown as {
      scene: { getObjectByName(n: string): { userData: { layout: PinLayoutDump } } };
      camera: { position: V };
      raycastRay(o: V, d: V): { distance: number } | null;
    };
    const drawn = stage.scene
      .getObjectByName('annotate-issue-pins')
      .userData.layout.items.flatMap((i) => i.members);
    let behind = 0;
    for (const { p } of drawn) {
      const o = stage.camera.position.clone();
      const d = o.clone().set(p[0], p[1], p[2]).sub(o);
      const dist = d.length();
      const hit = stage.raycastRay(o, d);
      if (hit && hit.distance < dist - Math.max(1, dist * 0.03) - 0.5) behind++;
    }
    return { behind, checked: drawn.length };
  });

async function openDamac(win: Page) {
  await open(win, 'DAMAC');
  await expect
    .poll(
      () =>
        win.evaluate(
          () =>
            (window as unknown as Inspect).__stratlas
              .stage()
              ?.scene.getObjectByName('layer:model') !== undefined,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
}

/** Focus the 3D view so single-key shortcuts reach the stage. */
const focusStage = (win: Page) => win.locator('[data-scene-view] canvas').focus();

test.describe('DAMAC', () => {
  test.skip(!has('damac'), `DAMAC project not found under ${DATA}`);

  test('pins behind the tower are hidden and left out of the badges', async ({ win }) => {
    await openDamac(win);
    await win.keyboard.press('h');
    // the far facades' pins are on screen but hidden
    await expect
      .poll(async () => (await pinLayout(win))?.occluded ?? 0, { timeout: 20_000 })
      .toBeGreaterThan(50);
    await win.waitForTimeout(1500);
    expect((await pinLayout(win))?.pins).toBeGreaterThan(50);
    // the drawn pins are in sight: the scene's own raycast agrees for nearly all of them
    const check = await pinsBehind(win);
    expect(check.checked).toBeGreaterThan(50);
    expect(check.behind).toBeLessThanOrEqual(Math.ceil(check.checked * 0.05));
  });

  test('one click and I turn the pins off and on, in step with the Layers popover', async ({
    win,
  }) => {
    await openDamac(win);
    await expect
      .poll(async () => (await pinLayout(win))?.items ?? 0, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const hide = win.getByRole('button', { name: 'Hide issue pins', exact: true });
    await expect(hide).toHaveAttribute('aria-keyshortcuts', 'I');
    await expect(hide).toHaveAttribute('aria-pressed', 'true');
    await hide.click();
    await expect.poll(async () => (await pinLayout(win))?.items).toBe(0);
    const show = win.getByRole('button', { name: 'Show issue pins', exact: true });
    await expect(show).toHaveAttribute('aria-pressed', 'false');
    // the popover shows the same setting; the heat map stays on with the pins off
    await win.getByRole('button', { name: 'Layers and issue pins' }).click();
    await expect(win.getByRole('button', { name: 'No pins' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await win.getByRole('checkbox', { name: 'Severity heat map' }).check();
    await win.getByRole('button', { name: 'Severity 2 and above' }).click();
    await win.keyboard.press('Escape');
    await expect(hide).toBeVisible();
    // I turns them off and back on to the popover's last choice
    await focusStage(win);
    await win.keyboard.press('i');
    await expect.poll(async () => (await pinLayout(win))?.items).toBe(0);
    await win.keyboard.press('i');
    await expect.poll(async () => (await pinLayout(win))?.items ?? 0).toBeGreaterThan(0);
    await win.getByRole('button', { name: 'Layers and issue pins' }).click();
    await expect(win.getByRole('button', { name: 'Severity 2 and above' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(win.getByRole('checkbox', { name: 'Severity heat map' })).toBeChecked();
  });

  test('no video: the timeline folds into a thin bar; T and the bar bring it back', async ({
    win,
  }) => {
    await openDamac(win);
    const timeline = win.locator('.tl-wrap [aria-label="Timeline"]');
    const bar = win.getByTestId('timeline-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('No video in this project');
    await expect(timeline).toHaveCount(0);
    expect((await bar.boundingBox())?.height ?? 99).toBeLessThanOrEqual(30);
    await bar.getByRole('button', { name: 'Show the timeline' }).click();
    await expect(timeline).toBeVisible();
    await win.getByRole('button', { name: 'Hide the timeline' }).click();
    await expect(bar).toBeVisible();
    await focusStage(win);
    await win.keyboard.press('t');
    await expect(timeline).toBeVisible();
    await win.keyboard.press('t');
    await expect(timeline).toHaveCount(0);
  });
});

test.describe('HCl', () => {
  test.skip(!has('hcl'), `HCl project not found under ${DATA}`);
  test('with clips the timeline shows as before', async ({ win }) => {
    await open(win, 'HCl');
    await expect(win.locator('.tl-wrap [aria-label="Timeline"]')).toBeVisible();
    await expect(win.getByTestId('timeline-bar')).toHaveCount(0);
  });
  test('flight paths: all, active clip only, off, P, and per flight', async ({ win }) => {
    await pathsTest(win, 'HCl', 10, false);
  });
  test('point cloud colour by elevation; RGB disabled for intensity-only clouds', async ({
    win,
  }) => {
    await colourTest(win, 'HCl', false);
  });
});
