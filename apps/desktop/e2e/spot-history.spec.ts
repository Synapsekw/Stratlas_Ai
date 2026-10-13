/**
 * Spot history (timeline S1) in the real app: from a photo of the change demo (C8, two survey
 * dates, the same six photos a little moved on the second date, a drone clip each) and from a
 * panorama of `e2e-pano-dates` (panoFixtures.ts), the viewer shows the spot on every date, steps
 * with the arrow keys, compares side by side and swiped, and leaves the main view alone.
 */
import type { Page } from '@playwright/test';
import { expect, openProject, test } from './fixtures';
import { createPanoDateProject, PANO_DATE_PROJECT_NAME } from './panoFixtures';

interface Hook {
  __stratlas: {
    workspace: {
      getState(): {
        selection: unknown;
        hidden: Record<string, true>;
        select(s: { kind: string; id: string; layer: string }): void;
      };
    };
  };
}

async function goTo(win: Page, name: 'Scene' | 'Media') {
  await win.locator('.sb-nav .nav-item', { hasText: name }).first().click();
}
const select = (win: Page, s: { kind: string; id: string; layer: string }) =>
  win.evaluate((s) => {
    (window as unknown as Hook).__stratlas.workspace.getState().select(s);
  }, s);
/** The hidden layers and the selection (any screen). */
const wsView = (win: Page) =>
  win.evaluate(() => {
    const s = (window as unknown as Hook).__stratlas.workspace.getState();
    return JSON.stringify({ hidden: s.hidden, selection: s.selection });
  });
/** What the main view shows: the date bar's date (on Scene, where the bar is) and the above. */
async function mainView(win: Page) {
  await goTo(win, 'Scene');
  return [await win.getByTestId('date-bar-open').getAttribute('aria-label'), await wsView(win)];
}
const head = (win: Page) => win.getByTestId('spot-head');

test('a photo shows its spot on both dates, steps with the keys and compares', async ({
  demoProject,
}) => {
  test.setTimeout(120_000);
  const { win } = demoProject;
  // a photo picked on Scene opens in Media (Stage.tsx); read the main view with it selected
  await select(win, { kind: 'photo', id: 'p05', layer: 'photos-d1' });
  const before = await mainView(win);
  await goTo(win, 'Media');
  const inline = win.getByTestId('spot-inline');
  await expect(inline.getByTestId('spot-slot-d1')).toHaveAttribute('data-empty', 'false');
  await expect(inline.getByTestId('spot-slot-d2')).toHaveAttribute('data-empty', 'false');
  const ws = await wsView(win);

  await win.getByTestId('spot-history-open').first().click();
  const dialog = win.getByTestId('spot-viewer');
  await expect(dialog).toBeVisible();
  await expect(head(win)).toHaveAttribute('data-capture', 'd1');
  await expect(head(win)).toHaveAttribute('data-item', 'p05');

  await win.keyboard.press('ArrowRight');
  await expect(head(win)).toHaveAttribute('data-capture', 'd2');
  await expect(head(win)).toHaveAttribute('data-item', 'p05');
  expect(Number(await head(win).getAttribute('data-distance'))).toBeLessThan(1.5);
  await win.keyboard.press('ArrowRight');
  await expect(head(win)).toHaveAttribute('data-capture', 'd2');
  expect(await wsView(win)).toEqual(ws);
  // founder decision 2, checked while the viewer stood on the other date: close it on d2, and the
  // main view's date, selection and layers are still those of before
  await win.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await mainView(win)).toEqual(before);

  await goTo(win, 'Media');
  await win.getByTestId('spot-history-open').first().click();
  await expect(head(win)).toHaveAttribute('data-capture', 'd1');
  await win.keyboard.press('ArrowRight');
  await expect(head(win)).toHaveAttribute('data-capture', 'd2');
  await win.keyboard.press('ArrowLeft');
  await expect(head(win)).toHaveAttribute('data-capture', 'd1');
  expect(await wsView(win)).toEqual(ws);

  await win.getByTestId('spot-compare').click();
  const cmp = win.getByTestId('spot-compare-view');
  await expect(cmp).toHaveAttribute('data-mode', 'side');
  await expect(win.getByTestId('spot-compare-date-left')).toHaveValue('d1');
  await expect(win.getByTestId('spot-compare-date-right')).toHaveValue('d2');
  await win.getByTestId('spot-mode-swipe').click();
  await expect(cmp).toHaveAttribute('data-mode', 'swipe');
  const handle = win.getByTestId('frames-swipe');
  const was = Number(await handle.getAttribute('aria-valuenow'));
  await handle.focus();
  await win.keyboard.press('ArrowRight');
  await expect
    .poll(async () => Number(await handle.getAttribute('aria-valuenow')))
    .toBeGreaterThan(was);
  // the slider owns the arrow: the dates stay put
  await expect(head(win)).toHaveAttribute('data-capture', 'd1');

  // Esc leaves Compare on the left date; the dialog takes focus back, so a second Esc closes it
  await win.keyboard.press('Escape');
  await expect(cmp).toHaveCount(0);
  await expect(head(win)).toHaveAttribute('data-capture', 'd1');
  await win.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await mainView(win)).toEqual(before);
});

test('a drone photo finds the drone photo of the other date', async ({ demoProject }) => {
  const { win } = demoProject;
  await select(win, { kind: 'photo', id: 'p01', layer: 'photos-d1' });
  await goTo(win, 'Media');
  await win.getByTestId('spot-history-open').first().click();
  await win.keyboard.press('ArrowRight');
  await expect(head(win)).toHaveAttribute('data-capture', 'd2');
  await expect(head(win)).toHaveAttribute('data-kind', 'drone');
  // p01 and p02 of the second date both aim at the origin with their own jitter, so either may
  // rank first: p01 is among the candidates of the date (Down cycles them)
  const count = Number(
    await win.getByTestId('spot-viewer').getByTestId('spot-slot-d2').getAttribute('data-count'),
  );
  expect(count).toBeGreaterThan(0);
  const items: string[] = [];
  for (let i = 0; i < count; i++) {
    const item = await head(win).getAttribute('data-item');
    if (item !== null) items.push(item);
    await win.keyboard.press('ArrowDown');
    if (i < count - 1) await expect(head(win)).not.toHaveAttribute('data-item', item ?? '');
  }
  expect(items).toContain('p01');
});

const panoTest = test.extend<{ panoProject: { id: string } }>({
  panoProject: async ({ dataRoot }, use) => {
    await use(await createPanoDateProject(dataRoot));
  },
});

async function openPanoDates(win: Page, id: string) {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: PANO_DATE_PROJECT_NAME }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe(id);
}

/** Other dates of the selection from its card in Scene's context panel (the Selection tab). */
async function openFromSelection(win: Page) {
  const tab = win.getByRole('tab', { name: 'Selection' });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const open = win.getByRole('region', { name: 'Selection' }).getByTestId('spot-history-open');
  await expect(open).toBeVisible();
  await open.click();
  await expect(win.getByTestId('spot-viewer')).toBeVisible();
}

panoTest(
  'a 360 finds the nearest 360 of each date and shows the gaps',
  async ({ panoProject, win }) => {
    await openPanoDates(win, panoProject.id);
    await select(win, { kind: 'pano', id: 'p2', layer: 'pano-oct' });
    await openFromSelection(win);
    await expect(head(win)).toHaveAttribute('data-capture', 'oct');
    await expect(head(win)).toHaveAttribute('data-kind', 'pano');
    await win.keyboard.press('ArrowRight');
    await expect(head(win)).toHaveAttribute('data-capture', 'nov');
    await expect(head(win)).toHaveAttribute('data-item', 'p2');
    await win.keyboard.press('Escape');
    await expect(win.getByTestId('spot-viewer')).toHaveCount(0);

    // p3 of 6 Nov stands at x = 60: no 360 of September or October within 25 m
    await select(win, { kind: 'pano', id: 'p3', layer: 'pano-nov' });
    await openFromSelection(win);
    await expect(win.getByTestId('spot-viewer').getByTestId('spot-slot-sep')).toHaveAttribute(
      'data-empty',
      'true',
    );
    await expect(win.getByTestId('spot-viewer').getByTestId('spot-slot-oct')).toContainText(
      'Nothing within 25 m',
    );
    await win.keyboard.press('ArrowLeft');
    await expect(head(win)).toHaveAttribute('data-capture', 'nov');
  },
);
