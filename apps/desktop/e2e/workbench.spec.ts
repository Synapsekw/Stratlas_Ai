/**
 * The right sidebar as the workbench (stage island D11, D13 to D17) in the real app: a tool that
 * starts takes the front, except from an issue being edited, where its tab waits live beside it;
 * a pinned tab stays when a tool starts and an unpinned one gives way; a bench's sections fold
 * and open all at once and the search keeps only what matches; the sidebar's dragged width is
 * remembered across a relaunch. The agent pane (agent-pane.spec.ts) and the drawer
 * (drawer.spec.ts) have their own specs.
 *
 * Screenshots go to the test's output folder (test-results/), or to QUADRION_E2E_SHOTS.
 */
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, openProject, test } from './fixtures';
import { islandGroup, islandRow, measureBench, openBench } from './island';

const VIEW_READY = { timeout: 30_000 };

interface Inspect {
  __stratlas: {
    workspace: {
      getState(): {
        issues: { id: string }[];
        select(s: { kind: 'issue'; id: string } | null): void;
      };
    };
    workbench: { getState(): { tabs: { id: string; pinned: boolean }[] } };
  };
}

/**
 * The tabs the workbench has open, pinned or not: on the row or, where the row is too narrow
 * (1100 px), in its More tabs menu, whose tabs leave the DOM.
 */
const openTabs = (win: Page) =>
  win.evaluate(() =>
    (window as unknown as Inspect).__stratlas.workbench
      .getState()
      .tabs.map((t) => `${t.id}${t.pinned ? ' pinned' : ''}`),
  );

async function openCard(win: Page, id: string): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E two dates' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible(VIEW_READY);
  await expect.poll(async () => (await openProject(win)).id, VIEW_READY).toBe(id);
}

async function shot(win: Page, name: string): Promise<void> {
  await win.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const dir = process.env.QUADRION_E2E_SHOTS;
  if (dir) await mkdir(dir, { recursive: true });
  await win.screenshot({ path: dir ? join(dir, name) : test.info().outputPath(name) });
}

/** M on the 3D view: Measure a distance starts, or stops again. */
async function pressM(win: Page): Promise<void> {
  await win.locator('[data-scene-view] canvas').first().focus();
  await win.keyboard.press('m');
}

const tab = (win: Page, id: string) => win.locator(`.right #wb-tab-${id}`);
const liveDot = (win: Page, id: string) =>
  tab(win, id).getByRole('img', { name: 'Live', exact: true });

test.describe('following (D14)', () => {
  test('a tool takes the front, but waits live beside an issue being edited', async ({
    twoDateProject,
    win,
  }) => {
    await openCard(win, twoDateProject.id);
    await expect(tab(win, 'selection')).toHaveAttribute('aria-selected', 'true');

    // nothing edited: Measure opens live, in front
    await pressM(win);
    await expect(tab(win, 'measure')).toHaveAttribute('aria-selected', 'true');
    await expect(liveDot(win, 'measure')).toBeVisible();
    await expect(win.getByTestId('survey-drawbar')).toBeVisible();
    // stopped, the tab it opened closes and Selection is in front again (D13)
    await pressM(win);
    await expect(tab(win, 'measure')).toHaveCount(0);
    await expect(tab(win, 'selection')).toHaveAttribute('aria-selected', 'true');

    // an issue's edit form open in Selection
    const issueId = await win.evaluate(() => {
      const ws = (window as unknown as Inspect).__stratlas.workspace.getState();
      const id = ws.issues[0]?.id ?? '';
      ws.select({ kind: 'issue', id });
      return id;
    });
    expect(issueId).not.toBe('');
    const card = (await openBench(win, 'selection')).getByTestId('issue-card');
    await expect(card).toHaveAttribute('data-issue', issueId);
    await card.locator('.ic-edit > summary').click();
    await expect(card.locator('.ic-edit')).toHaveAttribute('open', '');

    // M while it is edited: Measure starts, its tab waits live behind the issue
    await pressM(win);
    await expect(win.locator('.island [data-live="tool"]')).toContainText('Distance');
    await expect(liveDot(win, 'measure')).toBeVisible();
    await expect(tab(win, 'measure')).toHaveAttribute('aria-selected', 'false');
    await expect(tab(win, 'selection')).toHaveAttribute('aria-selected', 'true');
    await expect(card.locator('.ic-edit')).toHaveAttribute('open', '');
    await shot(win, 'workbench-follow-issue-edit.png');

    // the person brings it forward when they want it
    await tab(win, 'measure').click();
    await expect(tab(win, 'measure')).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator('.right #wb-panel-measure')).toBeVisible();
    await pressM(win);
    await expect(tab(win, 'measure')).toHaveCount(0);
  });
});

test.describe('pins (D15)', () => {
  test('a pinned tab stays when a tool starts; an unpinned panel gives way', async ({
    twoDateProject,
    win,
  }) => {
    await openCard(win, twoDateProject.id);
    // Display from the island, pinned
    await islandGroup(win, 'display');
    await expect(tab(win, 'display')).toHaveAttribute('aria-selected', 'true');
    const pin = win.locator('.right').getByRole('button', { name: 'Pin Display', exact: true });
    await pin.click();
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    // Environment from the View row: an unpinned panel beside it
    const row = await islandRow(win, 'view');
    await row.getByRole('button', { name: 'Environment and time of day', exact: true }).click();
    await expect(tab(win, 'environment')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => openTabs(win)).toContain('display pinned');
    await expect.poll(() => openTabs(win)).toContain('environment');

    // a tool starts: the unpinned panel closes, the pinned one stays, the tool is in front
    await pressM(win);
    await expect(tab(win, 'measure')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => openTabs(win)).not.toContain('environment');
    expect(await openTabs(win)).toContain('display pinned');
    // where the row has no room for it, the More tabs menu lists it, ticked as pinned
    if ((await tab(win, 'display').count()) === 0) {
      const more = win.locator('.right').getByRole('button', { name: 'More tabs', exact: true });
      await more.click();
      const menu = win.getByRole('menu', { name: 'More tabs' });
      await expect(menu.getByRole('menuitemcheckbox', { name: 'Display' })).toBeChecked();
      await shot(win, 'workbench-pin-survives-tool.png');
      // (closed by its button: Esc would also put the live tool away)
      await more.click();
      await expect(menu).toHaveCount(0);
    } else {
      await expect(pin).toHaveAttribute('aria-pressed', 'true');
      await shot(win, 'workbench-pin-survives-tool.png');
    }

    // and when it stops, the pinned tab is still there
    await pressM(win);
    await expect(tab(win, 'measure')).toHaveCount(0);
    expect(await openTabs(win)).toContain('display pinned');
  });
});

test.describe('sections (D16)', () => {
  test('Collapse all and Expand all, and the search keeps only what matches', async ({
    twoDateProject,
    win,
  }) => {
    await openCard(win, twoDateProject.id);
    const bench = await measureBench(win);
    const panel = win.locator('.right #wb-panel-measure');
    const heads = bench.locator('.wb-section-head');
    await expect(heads.first()).toBeVisible();
    const total = await heads.count();
    expect(total).toBeGreaterThan(3);

    const collapse = panel.getByRole('button', { name: 'Collapse all', exact: true });
    await collapse.click();
    await expect(bench.locator('.wb-section-head[aria-expanded="true"]')).toHaveCount(0);
    await expect(heads).toHaveCount(total);
    await shot(win, 'workbench-sections-collapsed.png');
    const expand = panel.getByRole('button', { name: 'Expand all', exact: true });
    await expand.click();
    await expect(bench.locator('.wb-section-head[aria-expanded="false"]')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Collapse all', exact: true })).toBeVisible();

    // the search: only Line, opened, with only Grade and slope
    const shown = () =>
      bench.evaluate((el) =>
        [...el.querySelectorAll('.wb-section')].map((s) =>
          (s.getAttribute('data-testid') ?? '').replace('wb-section-', ''),
        ),
      );
    const search = bench.getByRole('searchbox', { name: 'Search tools' });
    await search.fill('slope');
    await expect.poll(shown).toEqual(['line']);
    const line = bench.getByTestId('wb-section-line');
    await expect(line.locator('.wb-section-head')).toHaveAttribute('aria-expanded', 'true');
    await expect(line.locator('.meb-name')).toHaveText(['Grade and slope']);
    await shot(win, 'workbench-search-slope.png');
    // nothing matches: an empty state says so
    await search.fill('nothing like this');
    await expect.poll(shown).toEqual([]);
    await expect(bench.locator('.empty-state')).toBeVisible();
    // cleared, every section is back
    await search.fill('');
    await expect(heads).toHaveCount(total);
  });
});

test.describe('the sidebar width (D17)', () => {
  test('is as wide as it was dragged, and still that wide after a relaunch', async ({
    twoDateProject,
    dataRoot,
  }) => {
    test.setTimeout(180_000);
    const width = (win: Page) =>
      win.locator('.ws > .right').evaluate((el) => Math.round(el.getBoundingClientRect().width));
    const run = async (body: (win: Page) => Promise<void>) => {
      const app = await launchApp(dataRoot);
      const network = new NetworkGuard();
      try {
        await network.attach(app);
        const win = await app.firstWindow();
        await win.waitForLoadState('domcontentloaded');
        await openCard(win, twoDateProject.id);
        await body(win);
        expect(await network.outbound(), 'the app made network requests').toEqual([]);
      } finally {
        await app.close();
      }
    };

    let dragged = 0;
    await run(async (win) => {
      const before = await width(win);
      const edge = win.getByRole('separator', { name: 'Resize right sidebar' });
      const box = await edge.boundingBox();
      if (!box) throw new Error('no sidebar edge');
      const x = box.x + box.width / 2;
      // above the middle, where the panel's fold tab sits on the edge
      const y = box.y + box.height / 4;
      // dragged 60 px towards the stage: the sidebar grows by as much
      await win.mouse.move(x, y);
      await win.mouse.down();
      await win.mouse.move(x - 30, y, { steps: 4 });
      await win.mouse.move(x - 60, y, { steps: 4 });
      await win.mouse.up();
      await expect.poll(() => width(win)).toBe(before + 60);
      dragged = await width(win);
      await shot(win, 'workbench-width-dragged.png');
    });

    // the next start, on this computer: the same width
    await run(async (win) => {
      await expect.poll(() => width(win)).toBe(dragged);
      await shot(win, 'workbench-width-relaunched.png');
    });
  });
});
