/**
 * Every right-panel tab scrolls its sections in one box (UI revision D2): the tab body
 * (`.wb-body`) is a column that does not scroll, its `.wb-panel-scroll` is the one scroller, and a
 * bench in an open section sizes to its content inside it. Asserted on the layout itself, not
 * through a click: Playwright's click scrolls even an `overflow: hidden` box into view, which a
 * person cannot. With the context/agent divider moved up to its smallest, the tab is taller than
 * its pane, and the mouse wheel alone brings the end of the open bench into view.
 * Runs at the CI window (1100 x 720) on the tiny project with a point cloud, so the Point cloud
 * and Clean up tabs are there too.
 */
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openCleanupFromMenu, writeNoisyProject } from './cleanupHelpers';
import { expect, test } from './fixtures';
import { openAgentOff } from './agentPane';

interface Hooks {
  __stratlas: {
    workbench: { getState(): { open(id: string): void; reset(): void } };
    shell: { getState(): { setAnnotating(on: boolean): void } };
  };
}

/** The benches whose content is always taller than the smallest pane. */
// ('measure' is Tools > Measure: the catalogue and the live tool card)
const LONG = ['display', 'clouds', 'video', 'annotate', 'measure', 'cleanup'] as const;
/** Short panel tabs: they only have to be the scroller. */
const SHORT = ['environment', 'cutaway'] as const;
type Bench = (typeof LONG)[number] | (typeof SHORT)[number];
/** The bench itself: what the tab body holds besides the Collapse all row. */
const BENCH_ROOT = ':not(.wb-bench-head)';

test.beforeEach(async ({ dataRoot }) => {
  await writeNoisyProject(dataRoot.projectDir);
});

async function openBench(win: Page, id: Bench): Promise<void> {
  if (id === 'cleanup') await openCleanupFromMenu(win);
  else if (id === 'annotate')
    await win.evaluate(() => {
      (window as unknown as Hooks).__stratlas.shell.getState().setAnnotating(true);
    });
  else
    await win.evaluate((tab) => {
      (window as unknown as Hooks).__stratlas.workbench.getState().open(tab);
    }, id);
  await expect(
    win.locator(`.right .wb-psec-inner[data-front="${id}"] > ${BENCH_ROOT}`).first(),
  ).toBeVisible();
}

async function closeBench(win: Page, id: Bench): Promise<void> {
  if (id === 'annotate')
    await win.evaluate(() => {
      (window as unknown as Hooks).__stratlas.shell.getState().setAnnotating(false);
    });
  await win.evaluate(() => {
    (window as unknown as Hooks).__stratlas.workbench.getState().reset();
  });
}

interface Box {
  overflowY: string;
  /** The scroller ends inside the tab body (it is bounded, not as tall as its content). */
  bounded: boolean;
  scrolls: boolean;
  atEnd: boolean;
  /**
   * The bottom edge of the open bench's last section is inside the scroller's visible box: the
   * end of the bench is reached (the section itself may be taller than the pane, as the Measure
   * catalogue is).
   */
  lastShown: boolean;
}

const measure = (win: Page, id: Bench): Promise<Box | null> =>
  win.evaluate((front) => {
    const body = document.querySelector('.right .wb-body');
    const root = body?.querySelector<HTMLElement>(':scope .wb-panel-scroll');
    const bench = body?.querySelector(
      `.wb-psec-inner[data-front="${front}"] > :not(.wb-bench-head)`,
    );
    const last = bench?.lastElementChild ?? bench;
    if (!body || !root || !last) return null;
    const b = body.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    const l = last.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(root).overflowY,
      bounded: r.bottom <= b.bottom + 1,
      scrolls: root.scrollHeight > root.clientHeight + 1,
      atEnd: root.scrollTop + root.clientHeight >= root.scrollHeight - 1,
      lastShown: l.bottom >= r.top - 1 && l.bottom <= r.bottom + 1,
    };
  }, id);

/**
 * Wheel over the tab until the open bench's end shows (or the tab is at its end). The tab's other
 * sections follow the bench, so a notch never moves more than half the box: a bigger one could
 * carry the bench's end past the box's top in one go.
 */
async function wheelToEnd(win: Page, id: Bench): Promise<void> {
  const root = win.locator('.right .wb-body .wb-panel-scroll');
  const box = await root.boundingBox();
  if (!box) throw new Error('no bench');
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const notch = Math.max(20, Math.min(240, Math.floor(box.height / 2)));
  // (until the bench's end shows: sections under it may scroll on further)
  for (let i = 0; i < 120; i++) {
    const at = await measure(win, id);
    if (at?.lastShown || at?.atEnd) break;
    await win.mouse.wheel(0, notch);
    await win.waitForTimeout(60);
  }
}

test('every tab scrolls its sections in one box with the mouse wheel', async ({ win }, info) => {
  test.setTimeout(180_000);
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();

  // the divider where it always stands: the tab's scroll box holds each bench
  for (const id of [...LONG, ...SHORT]) {
    await openBench(win, id);
    const box = await measure(win, id);
    expect(box?.overflowY, `${id}: the tab scrolls`).toBe('auto');
    expect(box?.bounded, `${id}: the scroller ends inside its tab`).toBe(true);
    await closeBench(win, id);
  }

  // the divider moved up as far as it goes: every long bench is taller than its pane (with the
  // AI off the agent is one row with no divider until it is opened)
  await openAgentOff(win);
  const divider = win.getByRole('separator', { name: 'Resize Ask AI' });
  await divider.focus();
  await win.keyboard.press('Home');
  await expect
    .poll(() =>
      win.evaluate(() => document.querySelector('.right .rp-split')?.classList.contains('auto')),
    )
    .toBe(false);
  for (const id of LONG) {
    await openBench(win, id);
    const before = await measure(win, id);
    expect(before?.overflowY, `${id}: the tab scrolls`).toBe('auto');
    expect(before?.bounded, `${id}: the scroller ends inside its tab`).toBe(true);
    expect(before?.scrolls, `${id}: the tab is taller than its pane`).toBe(true);
    await wheelToEnd(win, id);
    const after = await measure(win, id);
    expect(after?.lastShown, `${id}: the end of the last section is reachable`).toBe(true);
    if (id === 'clouds' || id === 'cleanup') {
      const dir = process.env.QUADRION_E2E_SHOTS;
      if (dir) await mkdir(dir, { recursive: true });
      const name = `bench-scroll-${id}-end.png`;
      await win.screenshot({ path: dir ? join(dir, name) : info.outputPath(name) });
    }
    await closeBench(win, id);
  }
});
