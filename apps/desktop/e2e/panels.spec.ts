/**
 * Both side panels fold away and come back (founder: "we should be able to collapse both
 * sidebars, left and right"): the tab on the inner edge of each panel, the keyboard and the
 * command search all do it, the main view takes the room and gives it back, the 3D view and the
 * map are redrawn at their new size, and the folded state is still there after a restart. The
 * tabs lie inside their panels: nowhere on the main view does a click land on one.
 *
 * Screenshots of the four states go to the test's output folder (test-results/), or to
 * QUADRION_E2E_SHOTS when it names a folder.
 */
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shortcutHint } from '@aio/ui';
import { sampleIssue } from '../src/main/testing';
import { expectAccessible } from './a11y';
import { expect, launchApp, NetworkGuard, test, type DataRoot } from './fixtures';

const SIZE: [number, number] = [1440, 900];
/** tokens.css and styles.css: the sidebar, its icon rail and the right panel. */
const SIDEBAR = 252;
const RAIL = 52;
const RIGHT = 360;
/** The right panel folded: its border and the tab (`--ph-w`). */
const STRIP = 13;
/** main/index.ts: the smallest window. */
const MIN_SIZE: [number, number] = [1100, 700];

/** The shortcuts as the app writes them on this platform ("Ctrl B"; on macOS "⌘B"). */
const MAC = process.platform === 'darwin';
const KEYS = {
  left: shortcutHint('global.sidebar', MAC),
  right: shortcutHint('global.rightPanel', MAC),
};

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

/**
 * Ask for both tabs to be brought into view the hard way (aligned to the start, as a test
 * runner or a screen reader may), then say how far the sidebar and the page have moved: the
 * sidebar's sideways scroll, the page's two scrolls and the top of the app. All 0.
 */
async function scrolledAfterReveal(win: Page): Promise<(number | undefined)[]> {
  return win.evaluate(() => {
    for (const tab of document.querySelectorAll('.ph'))
      tab.scrollIntoView({ block: 'start', inline: 'start' });
    const page = document.scrollingElement;
    return [
      document.querySelector('.sidebar')?.scrollLeft,
      page?.scrollLeft,
      page?.scrollTop,
      document.querySelector('.app')?.getBoundingClientRect().top,
    ];
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

// the click test folds and measures twelve layouts: slow on a software GPU
test.setTimeout(180_000);

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
    // each handle lies inside its panel, against the edge it moves, both at one height; it is
    // as wide as the panel's edge padding (12) and 56 tall
    const lb = await left.boundingBox();
    const rb = await right.boundingBox();
    if (!lb || !rb) throw new Error('no panel handle');
    expect(Math.min(lb.width, rb.width)).toBeGreaterThanOrEqual(12);
    expect(Math.min(lb.height, rb.height)).toBeGreaterThanOrEqual(48);
    expect(lb.x + lb.width).toBeLessThanOrEqual(SIDEBAR);
    expect(lb.x + lb.width).toBeGreaterThanOrEqual(SIDEBAR - 2);
    expect(rb.x).toBeGreaterThanOrEqual(view - RIGHT);
    expect(rb.x).toBeLessThanOrEqual(view - RIGHT + 2);
    expect(Math.abs(lb.y - rb.y)).toBeLessThanOrEqual(1);
    await shot(win, info, '1-expanded.png');
    await expectAccessible(win, 'Scene, both side panels shown');

    // the tool tip names the action and its shortcut
    await left.hover();
    await expect(left.locator('.tip')).toHaveText(`Collapse left sidebar ${KEYS.left}`);
    await expect(left.locator('.tip')).toHaveCSS('opacity', '1');
    await shot(win, info, '1b-hover-left.png', false);
    await right.hover();
    await expect(right.locator('.tip')).toHaveText(`Collapse right sidebar ${KEYS.right}`);
    await expect(right.locator('.tip')).toHaveCSS('opacity', '1');
    // bringing a tab into view, however it is asked for, moves neither its panel nor the page
    expect(await scrolledAfterReveal(win)).toEqual([0, 0, 0, 0]);
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

    // right: folds to a strip as wide as its tab at the window edge; the whole strip is the
    // handle that brings it back
    await right.click();
    await expect(win.locator('.ws.right-off')).toHaveCount(1);
    await expect(right).toHaveAttribute('aria-expanded', 'false');
    await expect(right).toHaveAccessibleName('Expand right sidebar');
    await expectWidth(win, '.right', STRIP);
    await expectWidth(win, '.stage', stage0 + RIGHT - STRIP);
    await expect.poll(() => sceneFits(win)).toBe(true);
    await expect(right).toBeInViewport();
    // nothing in the folded panel shows, takes focus or takes a click
    await expect(win.locator('.right')).toHaveAttribute('inert', '');
    await expect(win.locator('.right .ctx-tabs')).toBeHidden();
    // the strip is inside the window from top to bottom: reaching for it never scrolls the page
    await right.hover();
    await right.focus();
    const rc = await right.boundingBox();
    const ws = await win.locator('.ws').boundingBox();
    if (!rc || !ws) throw new Error('no folded strip');
    expect(rc.x).toBeGreaterThanOrEqual(view - STRIP - 1);
    expect(rc.x + rc.width).toBeLessThanOrEqual(view + 1);
    expect(Math.abs(rc.height - ws.height)).toBeLessThanOrEqual(1);
    await expect(right.locator('.tip')).toHaveText(`Expand right sidebar ${KEYS.right}`);
    expect(await scrolledAfterReveal(win)).toEqual([0, 0, 0, 0]);
    await shot(win, info, '3-right-collapsed.png');

    // both folded: only the rail and the strip are left beside the view
    await left.click();
    await expectWidth(win, '.stage', view - RAIL - STRIP);
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

/**
 * Where a click on the 3D view would land on something else than the view: a grid over the whole
 * stage, every pixel column of its first and last 32 px (where the tabs are nearest) and columns
 * across the middle, every 6 px down. Empty when no point of the stage belongs to a handle or to
 * a side panel.
 */
async function strayHits(win: Page): Promise<string[]> {
  return win.evaluate(() => {
    const stage = document.querySelector('.stage');
    if (!stage) return ['no stage'];
    const r = stage.getBoundingClientRect();
    const xs = new Set<number>();
    for (let k = 0; k < 32; k++) {
      xs.add(r.left + k + 0.5);
      xs.add(r.right - k - 0.5);
    }
    for (let k = 1; k < 16; k++) xs.add(r.left + (r.width * k) / 16);
    const out: string[] = [];
    const name = (e: Element | null | undefined) => e?.getAttribute('class') ?? 'nothing';
    for (const x of xs)
      for (let y = r.top + 0.5; y < r.bottom; y += 6) {
        const el = document.elementFromPoint(x, y);
        const stray = el?.closest('.ph, .sidebar, .right');
        if (!el || stray || !stage.contains(el))
          out.push(
            `${String(Math.round(x - r.left))},${String(Math.round(y - r.top))}: ${name(stray ?? el)}`,
          );
      }
    return out.slice(0, 8);
  });
}

/**
 * What is under the middle of the 3D canvas: `view` when it is the canvas or something the 3D
 * view draws over itself (the engine's overlay: a marker, a label).
 */
async function atCentre(win: Page): Promise<string> {
  return win.evaluate(() => {
    const canvas = document.querySelector('[data-scene-view] canvas');
    if (!canvas) return 'no canvas';
    const r = canvas.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!el) return 'nothing';
    if (el === canvas || el.closest('[data-scene-view]')) return 'view';
    // name it by itself and what holds it, so a failure says what was in the way
    const name = (e: Element | null) =>
      e ? `${e.tagName.toLowerCase()}.${e.getAttribute('class') ?? ''}` : '';
    return `${name(el)} in ${name(el.parentElement)} in ${name(el.parentElement?.parentElement ?? null)}`;
  });
}

/** Fold or unfold each panel with its own handle until it is as asked. */
async function fold(win: Page, left: boolean, right: boolean): Promise<void> {
  for (const [side, folded] of [
    ['left', left],
    ['right', right],
  ] as const) {
    const handle = win.getByTestId(`panel-handle-${side}`);
    if ((await handle.getAttribute('aria-expanded')) === String(folded)) await handle.click();
    await expect(handle).toHaveAttribute('aria-expanded', String(!folded));
  }
  await expect.poll(() => sceneFits(win)).toBe(true);
  // the fold has finished (180 ms) before anything is measured
  await win.waitForTimeout(300);
}

test('a click anywhere on the 3D view goes to the view, never to a handle', async ({
  dataRoot,
}) => {
  const run = await start(dataRoot);
  const { win, app } = run;
  try {
    await openScene(win);
    const canvas = win.locator('[data-scene-view] canvas');
    // The smallest window; the window of the software GPU fly-through as a macOS runner lays it
    // out (1280 wide, about 700 high: there the 3D canvas is 668 x 598 and the click that
    // perf.spec.ts makes 5 px in and 300 px down is at the height of the tabs); a usual window.
    for (const size of [MIN_SIZE, [1280, 700], SIZE] as [number, number][]) {
      await app.evaluate(({ BrowserWindow }, [w, h]) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(w, h);
      }, size);
      // the window takes the size, or the nearest one the display and its minimum allow
      await win.waitForTimeout(400);
      const inner = await win.evaluate(() => `${String(innerWidth)} x ${String(innerHeight)}`);
      for (const [left, right] of [
        [false, false],
        [true, false],
        [true, true],
        [false, true],
      ] as const) {
        await fold(win, left, right);
        const state = `window ${inner}, left ${left ? 'folded' : 'shown'}, right ${right ? 'folded' : 'shown'}`;
        expect(
          await strayHits(win),
          `points of the 3D view that are not the view (${state})`,
        ).toEqual([]);
        expect(await atCentre(win), `the middle of the 3D view (${state})`).toBe('view');
        // the very click of the fly-through: at the canvas edge, half-way down
        const box = await canvas.boundingBox();
        if (!box) throw new Error('no canvas');
        for (const y of [300, Math.round(box.height / 2)])
          await canvas.click({ position: { x: 5, y }, timeout: 5_000 });
        await canvas.click({ position: { x: box.width - 5, y: box.height / 2 }, timeout: 5_000 });
        // and it folded or unfolded nothing
        await expect(win.locator('.app')).toHaveAttribute(
          'data-sb',
          left ? 'collapsed' : 'expanded',
        );
        await expect(win.locator('.ws.right-off')).toHaveCount(right ? 1 : 0);
      }
      await fold(win, false, false);
    }
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
    await expectWidth(win, '.stage', view - RAIL - STRIP);
    // and they come back
    await win.getByTestId('panel-handle-right').click();
    await win.getByTestId('panel-handle-left').click();
    await expectWidth(win, '.stage', view - SIDEBAR - RIGHT);
  } finally {
    await stop(second);
  }
});
