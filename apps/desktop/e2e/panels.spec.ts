/**
 * Both side panels fold away and come back (founder: "we should be able to collapse both
 * sidebars, left and right"): the tab on the inner edge of each panel, the keyboard and the
 * command search all do it, the main view takes the room and gives it back, the 3D view and the
 * map are redrawn at their new size, and the folded state is still there after a restart.
 *
 * Screenshots of the four states go to the test's output folder (test-results/), or to
 * QUADRION_E2E_SHOTS when it names a folder.
 */
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sampleIssue } from '../src/main/testing';
import { expectAccessible } from './a11y';
import { expect, launchApp, NetworkGuard, test, type DataRoot } from './fixtures';

const SIZE: [number, number] = [1440, 900];
/** tokens.css and styles.css: the sidebar, its icon rail and the right panel. */
const SIDEBAR = 252;
const RAIL = 52;
const RIGHT = 360;

interface Probe {
  __stratlas: {
    workspace: {
      getState(): {
        selection: { kind: string; id: string } | null;
        select(s: { kind: string; id: string; layer?: string }): void;
      };
    };
  };
}

interface Run {
  app: ElectronApplication;
  win: Page;
  network: NetworkGuard;
}

async function start(dataRoot: DataRoot): Promise<Run> {
  const app = await launchApp(dataRoot);
  const network = new NetworkGuard();
  await network.attach(app);
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(w, h);
  }, SIZE);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, network };
}

async function stop(run: Run): Promise<void> {
  const outbound = await run.network.outbound();
  await run.app.close();
  expect(outbound, 'the app made network requests').toEqual([]);
}

async function openScene(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.crumbs b')).toHaveText('Scene');
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
}

const width = async (win: Page, selector: string): Promise<number> =>
  (await win.locator(selector).boundingBox())?.width ?? -1;

/** The element settles at `expected` pixels wide (within a pixel: display scaling rounds). */
async function expectWidth(win: Page, selector: string, expected: number): Promise<void> {
  await expect
    .poll(async () => Math.abs((await width(win, selector)) - expected) <= 1, {
      message: `${selector} is ${String(await width(win, selector))} wide, not ${String(expected)}`,
    })
    .toBe(true);
}

/** The 3D canvas fills its pane and its drawing buffer matches (redrawn, not stretched). */
async function sceneFits(win: Page): Promise<boolean> {
  return win.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-scene-view] canvas');
    const pane = canvas?.closest<HTMLElement>('[data-scene-view]');
    if (!canvas || !pane) return false;
    const shown = canvas.getBoundingClientRect().width;
    const buffer = canvas.width / window.devicePixelRatio;
    return Math.abs(shown - pane.clientWidth) <= 1 && Math.abs(buffer - shown) <= 2;
  });
}

/** The map canvas fills its pane and its drawing buffer matches. */
async function mapFits(win: Page): Promise<boolean> {
  return win.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.maplibregl-canvas');
    const pane = canvas?.closest<HTMLElement>('.maplibregl-map');
    if (!canvas || !pane) return false;
    const shown = canvas.getBoundingClientRect().width;
    const buffer = canvas.width / window.devicePixelRatio;
    return Math.abs(shown - pane.clientWidth) <= 1 && Math.abs(buffer - shown) <= 2;
  });
}

async function shot(win: Page, info: TestInfo, name: string, rest = true): Promise<void> {
  // the pointer rests away from the tabs, so no tool tip or hover state is in the picture
  if (rest) await win.mouse.move(700, 300);
  await win.waitForTimeout(350);
  const dir = process.env.QUADRION_E2E_SHOTS;
  if (dir) await mkdir(dir, { recursive: true });
  await win.screenshot({ path: dir ? join(dir, name) : info.outputPath(name) });
}

test.setTimeout(120_000);

test('each side panel folds away and comes back, and the views take the room', async ({
  dataRoot,
}, info) => {
  const run = await start(dataRoot);
  const { win } = run;
  try {
    await openScene(win);
    const left = win.getByTestId('panel-handle-left');
    const right = win.getByTestId('panel-handle-right');

    // both panels shown: the defaults
    await expect(win.locator('.app')).toHaveAttribute('data-sb', 'expanded');
    await expect(win.locator('.ws.right-off')).toHaveCount(0);
    await expect(left).toHaveAttribute('aria-expanded', 'true');
    await expect(left).toHaveAccessibleName('Collapse left sidebar');
    await expect(left).toHaveAttribute('aria-controls', 'app-sidebar');
    await expect(right).toHaveAttribute('aria-expanded', 'true');
    await expect(right).toHaveAccessibleName('Collapse right sidebar');
    await expect(right).toHaveAttribute('aria-controls', 'right-panel');
    await expectWidth(win, '.sidebar', SIDEBAR);
    await expectWidth(win, '.right', RIGHT);
    const view = await win.evaluate(() => window.innerWidth);
    const stage0 = view - SIDEBAR - RIGHT;
    await expectWidth(win, '.stage', stage0);
    await expect.poll(() => sceneFits(win)).toBe(true);
    // each handle is a target of at least 24 x 24, centred on the edge it moves, at one height
    const lb = await left.boundingBox();
    const rb = await right.boundingBox();
    if (!lb || !rb) throw new Error('no panel handle');
    expect(Math.min(lb.width, lb.height, rb.width, rb.height)).toBeGreaterThanOrEqual(24);
    expect(Math.abs(lb.x + lb.width / 2 - SIDEBAR)).toBeLessThanOrEqual(1);
    expect(Math.abs(rb.x + rb.width / 2 - (view - RIGHT))).toBeLessThanOrEqual(1);
    expect(Math.abs(lb.y - rb.y)).toBeLessThanOrEqual(1);
    // and its tab shows in the main view, against that edge
    expect(
      Math.abs(((await left.locator('.ph-tab').boundingBox())?.x ?? 0) - SIDEBAR),
    ).toBeLessThanOrEqual(1);
    await shot(win, info, '1-expanded.png');
    await expectAccessible(win, 'Scene, both side panels shown');

    // the tool tip names the action and its shortcut
    await left.hover();
    await expect(left.locator('.tip')).toHaveText(/Collapse left sidebar\s*Ctrl B/);
    await expect(left.locator('.tip')).toHaveCSS('opacity', '1');
    await shot(win, info, '1b-hover-left.png', false);
    await right.hover();
    await expect(right.locator('.tip')).toHaveText(/Collapse right sidebar\s*Ctrl Alt B/);
    await shot(win, info, '1c-hover-right.png', false);

    // left: folds to the icon rail, the main view grows by the difference
    await left.click();
    await expect(win.locator('.app')).toHaveAttribute('data-sb', 'collapsed');
    await expect(left).toHaveAttribute('aria-expanded', 'false');
    await expect(left).toHaveAccessibleName('Expand left sidebar');
    await expectWidth(win, '.sidebar', RAIL);
    await expectWidth(win, '.stage', stage0 + SIDEBAR - RAIL);
    await expect.poll(() => sceneFits(win)).toBe(true);
    await expect(left).toBeInViewport();
    await shot(win, info, '2-left-collapsed.png');
    await left.click();
    await expect(win.locator('.app')).toHaveAttribute('data-sb', 'expanded');
    await expectWidth(win, '.stage', stage0);
    await expect.poll(() => sceneFits(win)).toBe(true);

    // right: folds to nothing, its tab stays at the window edge
    await right.click();
    await expect(win.locator('.ws.right-off')).toHaveCount(1);
    await expect(right).toHaveAttribute('aria-expanded', 'false');
    await expect(right).toHaveAccessibleName('Expand right sidebar');
    await expectWidth(win, '.right', 0);
    await expectWidth(win, '.stage', stage0 + RIGHT);
    await expect.poll(() => sceneFits(win)).toBe(true);
    await expect(right).toBeInViewport();
    await expect
      .poll(async () => {
        const b = await right.locator('.ph-tab').boundingBox();
        return b ? Math.abs(b.x + b.width - view) <= 1 : false;
      })
      .toBe(true);
    // nothing in the folded panel takes focus or a click
    await expect(win.locator('.right')).toHaveAttribute('inert', '');
    // the tab at the window edge is a whole target inside the window: reaching for it never
    // scrolls the page
    await right.hover();
    await right.focus();
    const rc = await right.boundingBox();
    expect(rc && rc.width >= 24 && rc.x + rc.width <= view + 1).toBe(true);
    expect(
      await win.evaluate(() => {
        const page = document.scrollingElement;
        const app = document.querySelector('.app');
        return [page?.scrollLeft, page?.scrollTop, app?.getBoundingClientRect().top];
      }),
    ).toEqual([0, 0, 0]);
    await shot(win, info, '3-right-collapsed.png');

    // both folded: only the rail is left beside the view
    await left.click();
    await expectWidth(win, '.stage', view - RAIL);
    await expect.poll(() => sceneFits(win)).toBe(true);
    await shot(win, info, '4-both-collapsed.png');
    await expectAccessible(win, 'Scene, both side panels folded');

    // the 3D view and the map side by side follow the panels too
    await win.keyboard.press('3');
    await expect(win.locator('.stage')).toHaveAttribute('data-mode', 'split');
    await expect(win.locator('.maplibregl-canvas')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => mapFits(win)).toBe(true);
    await right.click();
    await expect(win.locator('.ws.right-off')).toHaveCount(0);
    await expectWidth(win, '.stage', view - RAIL - RIGHT);
    await expect.poll(() => mapFits(win)).toBe(true);
    await expect.poll(() => sceneFits(win)).toBe(true);
    await left.click();
    await expectWidth(win, '.stage', stage0);
    await expect.poll(() => mapFits(win)).toBe(true);
    await expect.poll(() => sceneFits(win)).toBe(true);
    await shot(win, info, '5-split-expanded.png');
    await win.keyboard.press('1');

    // the keyboard does the same, and the tabs say so
    await win.keyboard.press('Control+B');
    await expect(left).toHaveAttribute('aria-expanded', 'false');
    await win.keyboard.press('Control+Alt+b');
    await expect(right).toHaveAttribute('aria-expanded', 'false');
    await left.focus();
    await win.keyboard.press('Enter');
    await expect(left).toHaveAttribute('aria-expanded', 'true');
    await expect(left).toBeFocused();

    // and the command search, in the same words
    await win.keyboard.press('Control+K');
    const palette = win.getByRole('dialog', { name: 'Command search' });
    await expect(palette).toBeVisible();
    await win.keyboard.type('Expand right sidebar');
    await win.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect(right).toHaveAttribute('aria-expanded', 'true');
    await win.keyboard.press('Control+K');
    await win.keyboard.type('Collapse left sidebar');
    await win.keyboard.press('Enter');
    await expect(left).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await stop(run);
  }
});

test('a folded panel opens for an action that needs it, not for a selection', async ({
  dataRoot,
}) => {
  await writeFile(
    join(dataRoot.projectDir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [sampleIssue()] }),
  );
  const run = await start(dataRoot);
  const { win } = run;
  try {
    await openScene(win);
    const right = win.getByTestId('panel-handle-right');
    await right.click();
    await expect(win.locator('.ws.right-off')).toHaveCount(1);

    // selecting a layer changes what the panel would show, and leaves it folded
    await win.getByRole('tree', { name: 'Datasets' }).getByText('Unit quad').click();
    await expect
      .poll(() =>
        win.evaluate(
          () => (window as unknown as Probe).__stratlas.workspace.getState().selection?.kind,
        ),
      )
      .toBe('layer');
    await expect(win.locator('.ws.right-off')).toHaveCount(1);
    await expect(right).toHaveAttribute('aria-expanded', 'false');

    // picking an issue asks for its card: the panel comes back with it
    await win.evaluate(() => {
      (window as unknown as Probe).__stratlas.workspace.getState().select({
        kind: 'issue',
        id: 'i1',
      });
    });
    await expect(win.locator('.ws.right-off')).toHaveCount(0);
    await expect(right).toHaveAttribute('aria-expanded', 'true');
    await expect(win.getByTestId('issue-card')).toBeVisible();
  } finally {
    await stop(run);
  }
});

test('the folded panels are still folded after a restart', async ({ dataRoot }) => {
  const first = await start(dataRoot);
  try {
    const { win } = first;
    await openScene(win);
    await win.getByTestId('panel-handle-left').click();
    await win.getByTestId('panel-handle-right').click();
    await expect(win.locator('.app')).toHaveAttribute('data-sb', 'collapsed');
    await expect(win.locator('.ws.right-off')).toHaveCount(1);
    // the left state is a setting (settings.json), the right one a choice of this workstation
    await expect
      .poll(() =>
        win.evaluate(() => window.aio.invoke('settings:get', {}).then((s) => s.sidebarCollapsed)),
      )
      .toBe(true);
    expect(await win.evaluate(() => localStorage.getItem('quadrion.panels'))).toBe(
      '{"rightCollapsed":true}',
    );
  } finally {
    await stop(first);
  }

  const second = await start(dataRoot);
  try {
    const { win } = second;
    await expect(win.locator('.app')).toHaveAttribute('data-sb', 'collapsed');
    await openScene(win);
    await expect(win.locator('.ws.right-off')).toHaveCount(1);
    await expect(win.getByTestId('panel-handle-left')).toHaveAttribute('aria-expanded', 'false');
    await expect(win.getByTestId('panel-handle-right')).toHaveAttribute('aria-expanded', 'false');
    await expectWidth(win, '.sidebar', RAIL);
    const view = await win.evaluate(() => window.innerWidth);
    await expectWidth(win, '.stage', view - RAIL);
    // and they come back
    await win.getByTestId('panel-handle-right').click();
    await win.getByTestId('panel-handle-left').click();
    await expectWidth(win, '.stage', view - SIDEBAR - RIGHT);
  } finally {
    await stop(second);
  }
});
