/**
 * Flight paths, point cloud colour, issue pins and the timeline on the real projects (founder
 * reports: "I cannot turn off the flight paths on Al-Zour", "I can't find where to change point
 * cloud colorization to elevation", "DAMAC: issue labels are visible through the building", "the
 * timeline, does this make sense with no videos?", "turn off the anomaly tags with one click",
 * "when I do a point cloud overlay, I'm not able to change the size of the point cloud", "point
 * size doesn't change the size of the points, it changes the colour").
 * Runs where the real data holds the projects (realData.ts); each project's tests skip without it
 * and run on a temporary copy of it (@realdata).
 */
import type { Page } from '@playwright/test';
import { expect, realDataTest } from './fixtures';
import { hasRealProject, missingRealProject } from './realData';

const has = hasRealProject;

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

const test = realDataTest([], { size: [1440, 900] });

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

interface NodeSize {
  key: string;
  layer: string;
  px: number;
  scale: number;
  colour: string;
}

/**
 * Every drawn cloud node, in the main scene or the EDL pass's own scene: its on-screen point
 * size in pixels at its centre (the vertex shader's formula, `pointSizePx` in @aio/pointcloud)
 * and its colour state (mode, elevation range, tint, class colours and flags).
 */
const cloudSizes = (win: Page) =>
  win.evaluate(() => {
    interface V3 {
      clone(): V3;
      applyMatrix4(m: unknown): V3;
      z: number;
    }
    interface P {
      isPoints?: boolean;
      name: string;
      userData: { layerId?: string; offscreen?: P[] };
      matrixWorld: unknown;
      geometry?: { boundingSphere: { center: V3 } | null };
      material?: { uniforms?: Record<string, { value: unknown } | undefined> };
      children: P[];
      updateMatrixWorld(force: boolean): void;
      getObjectByName(n: string): P | undefined;
    }
    const stage = (
      window as unknown as {
        __stratlas: { stage(): { scene: P; camera: { matrixWorldInverse: unknown } } | null };
      }
    ).__stratlas.stage();
    if (!stage) return [];
    const edl = stage.scene.getObjectByName('PointCloudEDLComposite');
    const scenes = [stage.scene, ...(edl?.userData.offscreen ?? [])];
    const out: NodeSize[] = [];
    const visit = (o: P) => {
      const u = o.material?.uniforms;
      if (o.isPoints && o.userData.layerId && u?.uSize) {
        const c = o.geometry?.boundingSphere?.center.clone();
        const view = stage.camera.matrixWorldInverse;
        const depth = c ? -c.applyMatrix4(o.matrixWorld).applyMatrix4(view).z : 1;
        const n = (k: string) => Number(u[k]?.value ?? NaN);
        const scale = u.uScale ? n('uScale') : 1;
        const att = (n('uSize') * n('uPxPerM')) / Math.max(0.01, depth);
        const px = Math.max(1, Math.min(n('uMaxPx'), Math.max(n('uMinPx'), att)) * scale);
        const hex = (v: unknown) => (v as { getHex(): number }).getHex();
        out.push({
          key: o.name,
          layer: o.userData.layerId,
          px,
          scale,
          colour: JSON.stringify([
            u.uMode?.value,
            (u.uHeight?.value as { toArray(): number[] }).toArray(),
            hex(u.uTint?.value),
            (u.uClassColours?.value as unknown[]).map(hex),
            u.uClassShown?.value,
          ]),
        });
      }
      for (const ch of o.children) visit(ch);
    };
    for (const sc of scenes) {
      sc.updateMatrixWorld(true);
      visit(sc);
    }
    return out;
  });

/**
 * Moves the point size slider and checks every drawn node of every cloud: its on-screen size
 * follows the slider (at least one pixel) and its colour does not change. `layers`: the cloud
 * layers that must be drawn. Waits for streaming to settle first, so the node set holds still.
 */
async function sizeTest(win: Page, layers: readonly string[]) {
  const panel = win.getByTestId('cloud-panel');
  if (!(await panel.isVisible()))
    await win.getByRole('button', { name: 'Point cloud', exact: true }).click();
  const slider = panel.getByRole('slider', { name: 'Point size' });
  await slider.fill('0');
  await expect
    .poll(async () => [...new Set((await cloudSizes(win)).map((n) => n.layer))].sort(), {
      timeout: 60_000,
    })
    .toEqual([...layers].sort());
  // streaming done: the node set no longer changes
  await expect(panel.getByText(/points shown$/)).toBeVisible({ timeout: 90_000 });
  await win.waitForTimeout(1000);
  const base = new Map((await cloudSizes(win)).map((n) => [n.key, n]));
  for (const [value, scale] of [
    ['-2', 0.25],
    ['1', 2],
    ['2', 4],
  ] as const) {
    await slider.fill(value);
    await expect(panel.getByText(`${scale.toFixed(2)}x`)).toBeVisible();
    /** Nodes whose size does not follow the slider or whose colour changed; how many compared. */
    const check = async () => {
      const now = await cloudSizes(win);
      const wrong: string[] = [];
      let compared = 0;
      for (const n of now) {
        const was = base.get(n.key);
        if (!was) continue;
        compared++;
        const want = Math.max(1, was.px * scale);
        if (Math.abs(n.px - want) > 1e-3) wrong.push(`${n.key}: ${n.px} px, want ${want}`);
        if (n.colour !== was.colour) wrong.push(`${n.key}: colour ${n.colour}, was ${was.colour}`);
      }
      // every cloud's points grow on screen with the slider, the ones under a pixel too
      if (scale > 1)
        for (const l of layers) {
          const px = Math.min(...now.filter((n) => n.layer === l).map((n) => n.px));
          if (px < scale) wrong.push(`${l}: ${px} px at ${scale}x`);
        }
      return { wrong: wrong.slice(0, 5), enough: compared >= layers.length };
    };
    await expect.poll(check).toEqual({ wrong: [], enough: true });
  }
  await slider.fill('0');
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

test.describe('@realdata Al-Zour', () => {
  test.skip(!has('alzour'), missingRealProject('alzour'));
  test.use({ realProjects: ['alzour'] });
  test('flight paths: all, active clip only, off, P, and per flight', async ({ win }) => {
    await pathsTest(win, 'Al-Zour', 5);
  });
  test('point cloud colour by elevation with a legend (png-packed, RGB)', async ({ win }) => {
    await colourTest(win, 'Al-Zour', true);
  });
  test('point size changes the size of COPC and png-packed points, not their colour', async ({
    win,
  }) => {
    await open(win, 'Al-Zour');
    // the thinned png-packed cloud is hidden by default: show it with the COPC one
    await win.evaluate(() => {
      const ws = (
        window as unknown as {
          __stratlas: {
            workspace: { getState(): { setLayerVisible(id: string, v: boolean): void } };
          };
        }
      ).__stratlas.workspace;
      ws.getState().setLayerVisible('cloud', true);
    });
    // the opening overview, where the octree nodes draw under a pixel; RGB, then elevation
    await sizeTest(win, ['cloud-full', 'cloud']);
    await win.getByTestId('cloud-panel').getByRole('button', { name: 'Elevation' }).click();
    await sizeTest(win, ['cloud-full', 'cloud']);
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

test.describe('@realdata DAMAC', () => {
  test.skip(!has('damac'), missingRealProject('damac'));
  test.use({ realProjects: ['damac'] });

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

test.describe('@realdata HCl', () => {
  test.skip(!has('hcl'), missingRealProject('hcl'));
  test.use({ realProjects: ['hcl'] });
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
  test('point size changes the size of every kit-packed cloud, not its colour', async ({ win }) => {
    await open(win, 'HCl');
    const clouds = Array.from({ length: 10 }, (_, i) => `cloud-${101 + i}`);
    await sizeTest(win, clouds);
    // three times farther out the 2.5 cm points fall under a pixel: the slider still works
    await win.evaluate(() => {
      const st = (
        window as unknown as {
          __stratlas: {
            stage(): {
              saveView(): { position: number[]; target: number[] };
              restoreView(v: unknown, animate: boolean): void;
            } | null;
          };
        }
      ).__stratlas.stage();
      if (!st) return;
      const { position, target } = st.saveView();
      const far = position.map((x, i) => (target[i] ?? 0) + 3 * (x - (target[i] ?? 0)));
      st.restoreView({ position: far, target }, false);
    });
    await sizeTest(win, clouds);
  });
});
