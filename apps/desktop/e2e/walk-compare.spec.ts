/**
 * Comparing two 360 walks: a project with two survey dates, a walk on each that goes the same L
 * (the second later, faster and with a detour), both placed on the model above an ortho that lies
 * 6 m lower. The placed tracks lie on the ortho in 3D; the map's Beam turns with the 360 look;
 * "Compare with walk" on a walk's right-click menu plays both side by side, the follower paired by
 * place with the distance chip; the detour is shaded on the scrubber and seeking into it plays
 * that walk alone. Skipped when ffmpeg with libx264 is missing (CI installs it).
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  createWalkCompareProject,
  DETOUR_S,
  ffmpegReady,
  openWalkProject,
  ORTHO_Y,
  pairedT,
  rowAction,
  walkRow,
  WALK2_LAYER,
  WALK_LAYER,
} from './walkFixture';

interface Probe {
  __stratlas: {
    stage(): {
      scene: {
        getObjectByName(n: string): SceneNode | undefined;
      };
    } | null;
  };
}

interface SceneNode {
  visible: boolean;
  parent: SceneNode | null;
  isLine?: boolean;
  isLine2?: boolean;
  matrixWorld: { elements: number[] };
  geometry?: {
    getAttribute(n: string): { count: number; getY(i: number): number } | undefined;
  };
  traverse(fn: (o: SceneNode) => void): void;
}

/**
 * The world heights of the placed walks' tracks in the 3D view (every shown line of the walks'
 * group): lowest, highest and how many points. Null before the group is there.
 */
async function trackHeights(win: Page): Promise<{ min: number; max: number; n: number } | null> {
  return win.evaluate(() => {
    const g = (window as unknown as Probe).__stratlas.stage()?.scene.getObjectByName('aio-walks');
    if (!g) return null;
    let min = Infinity;
    let max = -Infinity;
    let n = 0;
    g.traverse((o) => {
      if (!(o.isLine || o.isLine2)) return;
      for (let p: SceneNode | null = o; p; p = p.parent) if (!p.visible) return;
      const pos = o.geometry?.getAttribute(o.isLine2 ? 'instanceStart' : 'position');
      if (!pos) return;
      // the walks' group is not moved or scaled: a point's height is its y plus the translation
      const e = o.matrixWorld.elements;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i) + (e[13] ?? 0);
        min = Math.min(min, y);
        max = Math.max(max, y);
        n++;
      }
    });
    return { min, max, n };
  });
}

const wrap = (a: number): number => ((((a + 180) % 360) + 360) % 360) - 180;

/** Drag the 360 view sideways by `dx` pixels, as a person turns to look about. */
async function dragView(win: Page, view: Locator, dx: number): Promise<void> {
  const b = await view.boundingBox();
  if (!b) throw new Error('no 360 view');
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x + dx / 2, y, { steps: 4 });
  await win.mouse.move(x + dx, y, { steps: 4 });
  await win.mouse.up();
}

/** The 360 pane (view and bar) whose view has compare role `role`. */
function comparePane(win: Page, role: 'lead' | 'follow'): Locator {
  return win
    .getByTestId('walk-360')
    .filter({ has: win.locator(`[data-testid="walk-view"][data-compare-role="${role}"]`) });
}

const timeOf = async (pane: Locator): Promise<number> =>
  Number(await pane.getByTestId('walk-bar').getAttribute('data-time'));

test.describe('comparing two walks', () => {
  test.skip(!ffmpegReady(), 'needs ffmpeg with libx264 on the PATH');

  test('two walks play side by side paired by place, with their detours, Beams and draped tracks', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(240_000);
    await createWalkCompareProject(dataRoot.root);
    await win.reload();
    await openWalkProject(win);

    // the placed walks' pins stand 6 m above the ortho: their tracks lie on the ortho, not the pins
    await expect
      .poll(
        async () => {
          const h = await trackHeights(win);
          return h && h.n > 0 ? Math.max(Math.abs(h.min - ORTHO_Y), Math.abs(h.max - ORTHO_Y)) : 99;
        },
        { timeout: 30_000 },
      )
      .toBeLessThan(0.5);

    // one walk in the 360 pane beside the map: its Beam turns with the look
    await rowAction(win, 'open', WALK2_LAYER);
    const one = win.getByTestId('walk-view');
    await expect(one).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    await win.getByRole('combobox', { name: 'Left side shows' }).selectOption({ label: 'Map' });
    const beam = win.locator(`[data-testid="walk-beam"][data-layer-id="${WALK2_LAYER}"]`);
    await expect(beam).toHaveCount(1, { timeout: 15_000 });
    await expect(beam).toHaveAttribute('data-look-deg', /^\d+$/);
    const lookBefore = Number(await beam.getAttribute('data-look-deg'));
    const yawBefore = Number(await one.getAttribute('data-yaw'));
    await dragView(win, one, 160);
    await expect
      .poll(async () => Math.abs(wrap(Number(await one.getAttribute('data-yaw')) - yawBefore)))
      .toBeGreaterThan(10);
    const turned = Math.abs(wrap(Number(await one.getAttribute('data-yaw')) - yawBefore));
    await expect
      .poll(async () =>
        Math.abs(wrap(Number(await beam.getAttribute('data-look-deg')) - lookBefore)),
      )
      .toBeGreaterThan(turned - 3);

    // the 3D view on the left: its Map menu chip stands over it, and the hidden map's credits do
    // not stand over the 360 pane
    await win.getByRole('combobox', { name: 'Left side shows' }).selectOption({ label: '3D view' });
    const sceneChip = win.getByTestId('scene-map-button');
    await expect(sceneChip).toBeVisible();
    const chipBox = await sceneChip.boundingBox();
    const viewBox = await one.boundingBox();
    expect(chipBox && viewBox ? chipBox.x + chipBox.width : Infinity).toBeLessThanOrEqual(
      viewBox?.x ?? 0,
    );
    const credits = win.locator('.maplibregl-ctrl-attrib:visible');
    await expect(credits).toHaveCount(0);

    // Compare with walk, from the first walk's right-click menu: it leads, the April walk follows
    const row = await walkRow(win, WALK_LAYER);
    await row.click({ button: 'right' });
    await win.getByTestId('menu-walk-compareWith').click();
    const pick = win.getByTestId(`compare-with-${WALK2_LAYER}`);
    await expect(pick).toBeVisible();
    await pick.click();
    const views = win.getByTestId('walk-view');
    await expect(views).toHaveCount(2, { timeout: 20_000 });
    await expect(views.nth(0)).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    await expect(views.nth(1)).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    const lead = comparePane(win, 'lead');
    const follow = comparePane(win, 'follow');
    await expect(lead).toHaveCount(1);
    await expect(follow).toHaveCount(1);
    await expect(lead).toHaveAttribute('data-walk', 'w1');
    // two 360 panes: no map or 3D chrome over them
    await expect(credits).toHaveCount(0);
    await expect(
      win.locator('[data-testid="scene-map-button"], [data-testid="basemap-button"]'),
    ).toHaveCount(0);

    // the follower goes to where the lead is, not to the same second: the April walk started 8 s
    // later. Pairing keeps to the pass it is on, so it may stop up to a few metres short of the
    // exact spot (walkCompare.ts, PASS_M)
    await lead.getByTestId('walk-scrub').fill('16');
    const want = pairedT(16);
    await expect.poll(() => timeOf(follow), { timeout: 15_000 }).toBeGreaterThan(want - 3.5);
    expect(await timeOf(follow)).toBeLessThan(want + 1);
    const chip = win.getByTestId('walk-compare-dist');
    await expect(chip).toBeVisible();
    await expect(chip).not.toHaveAttribute('data-apart', 'true');
    const dist = Number(await follow.getByTestId('walk-view').getAttribute('data-pair-dist'));
    expect(dist).toBeLessThan(5);

    // the detour is shaded on the follower's scrubber, where it went
    const bands = follow.getByTestId('walk-compare-detours').locator('.walk-detour');
    await expect(bands.first()).toBeVisible();
    const span = await bands.first().evaluate((el) => ({
      left: parseFloat((el as HTMLElement).style.left),
      width: parseFloat((el as HTMLElement).style.width),
    }));
    const duration = Number(await follow.getByTestId('walk-scrub').getAttribute('max'));
    const fromT = (span.left / 100) * duration;
    const toT = ((span.left + span.width) / 100) * duration;
    expect(fromT).toBeGreaterThan(DETOUR_S.from - 1);
    expect(toT).toBeLessThan(DETOUR_S.to + 1);

    // seeking into it plays that walk on its own: the lead stays where it was
    const leadAt = await timeOf(lead);
    const mid = (fromT + toT) / 2;
    await follow.getByTestId('walk-scrub').fill(mid.toFixed(2));
    await expect(follow.getByTestId('walk-view')).toHaveAttribute('data-compare-solo', 'true');
    await follow.getByTestId('walk-play').click();
    await expect.poll(() => timeOf(follow), { timeout: 15_000 }).toBeGreaterThan(mid + 1);
    await follow.getByTestId('walk-play').click();
    expect(Math.abs((await timeOf(lead)) - leadAt)).toBeLessThan(0.05);
  });
});
