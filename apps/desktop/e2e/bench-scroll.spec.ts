/**
 * Every workbench tab scrolls its own body (stage island D12): the tab body (`.wb-body`) is a
 * column that does not scroll, so each bench's root is the scroller (`.wb-scroll`). Asserted on
 * the layout itself, not through a click: Playwright's click scrolls even an `overflow: hidden`
 * box into view, which a person cannot. With the context/agent divider moved up to its smallest,
 * the bench is taller than its pane, and the mouse wheel alone brings its last section into view.
 * Runs at the CI window (1100 x 720) on the tiny project with a point cloud, so the Point cloud
 * and Clean up tabs are there too.
 */
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openCleanupFromMenu, writeNoisyProject } from './cleanupHelpers';
import { expect, test } from './fixtures';

interface Hooks {
  __stratlas: {
    workbench: { getState(): { open(id: string): void; reset(): void } };
    shell: { getState(): { setAnnotating(on: boolean): void } };
  };
}

/** The benches whose content is always taller than the smallest pane. */
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
  await expect(win.locator(`.right .wb-body[data-front="${id}"] > ${BENCH_ROOT}`)).toBeVisible();
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
  /** The bench's last section is inside the scroller's visible box. */
  lastShown: boolean;
}

const measure = (win: Page): Promise<Box | null> =>
  win.evaluate(() => {
    const body = document.querySelector('.right .wb-body');
    const root = body?.querySelector<HTMLElement>(':scope > :not(.wb-bench-head)');
    const last = root?.lastElementChild;
    if (!body || !root || !last) return null;
    const b = body.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    const l = last.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(root).overflowY,
      bounded: r.bottom <= b.bottom + 1,
      scrolls: root.scrollHeight > root.clientHeight + 1,
      atEnd: root.scrollTop + root.clientHeight >= root.scrollHeight - 1,
      lastShown: l.top >= r.top - 1 && l.bottom <= r.bottom + 1,
    };
  });

/** Wheel over the bench until it has scrolled to its end. */
async function wheelToEnd(win: Page): Promise<void> {
  const root = win.locator(`.right .wb-body > ${BENCH_ROOT}`);
  const box = await root.boundingBox();
  if (!box) throw new Error('no bench');
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 30 && !(await measure(win))?.atEnd; i++) {
    await win.mouse.wheel(0, 240);
    await win.waitForTimeout(60);
  }
}

test('every workbench tab scrolls its own body with the mouse wheel', async ({ win }, info) => {
  test.setTimeout(180_000);
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();

  // the divider where it always stands: each bench is already the scroller
  for (const id of [...LONG, ...SHORT]) {
    await openBench(win, id);
    const box = await measure(win);
    expect(box?.overflowY, `${id}: the bench scrolls`).toBe('auto');
    expect(box?.bounded, `${id}: the bench ends inside its tab`).toBe(true);
    await closeBench(win, id);
  }

  // the divider moved up as far as it goes: every long bench is taller than its pane
  const divider = win.getByRole('separator', { name: 'Resize the agent' });
  await divider.focus();
  await win.keyboard.press('Home');
  await expect
    .poll(() =>
      win.evaluate(() => document.querySelector('.right .rp-split')?.classList.contains('auto')),
    )
    .toBe(false);
  for (const id of LONG) {
    await openBench(win, id);
    const before = await measure(win);
    expect(before?.overflowY, `${id}: the bench scrolls`).toBe('auto');
    expect(before?.bounded, `${id}: the bench ends inside its tab`).toBe(true);
    expect(before?.scrolls, `${id}: the bench is taller than its pane`).toBe(true);
    expect(before?.lastShown, `${id}: the last section starts out of view`).toBe(false);
    await wheelToEnd(win);
    const after = await measure(win);
    expect(after?.atEnd, `${id}: the wheel scrolls the bench to its end`).toBe(true);
    expect(after?.lastShown, `${id}: the last section is reachable`).toBe(true);
    if (id === 'clouds' || id === 'cleanup') {
      const dir = process.env.QUADRION_E2E_SHOTS;
      if (dir) await mkdir(dir, { recursive: true });
      const name = `bench-scroll-${id}-end.png`;
      await win.screenshot({ path: dir ? join(dir, name) : info.outputPath(name) });
    }
    await closeBench(win, id);
  }
});
