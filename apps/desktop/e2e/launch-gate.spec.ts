/**
 * The launch screen (renderer gate/): shown over the mounted app shell on every start, greeting
 * the person by the identity's name, opened with Enter; switched off in Settings, Appearance; and
 * never in the other specs, which run with QUADRION_E2E=1 (only QUADRION_SHOW_GATE=1 brings it
 * back, here).
 *
 * QUADRION_E2E_SHOTS=<folder> saves screenshots at 1440 x 900, at 820 x 900 and right after
 * Enter. Run it on the software GPU too: QUADRION_E2E_SWGL=1.
 */
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, test } from './fixtures';

const SHOTS = process.env.QUADRION_E2E_SHOTS;
const shot = async (win: Page, name: string) => {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const gate = (win: Page) => win.getByTestId('launch-gate');
const projectsHeading = (win: Page) => win.locator('main h1', { hasText: 'Project library' });

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
async function box(win: Page, selector: string): Promise<Box> {
  const b = await win.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return b;
}
const centreY = (b: Box) => b.y + b.height / 2;

/** The mark stands beside the wordmark, never above it. */
async function expectMarkBesideWordmark(win: Page): Promise<void> {
  const mark = await box(win, '.qg-mark');
  const wm = await box(win, '.qg-wm');
  expect(mark.x + mark.width).toBeLessThanOrEqual(wm.x);
  expect(Math.abs(centreY(mark) - centreY(wm))).toBeLessThan(mark.height / 2);
}

/**
 * The page at exactly `width` x `height` CSS pixels, whatever the display allows the off-screen
 * window (Windows keeps a window within the screen size, and below the app's 1100 px minimum
 * only by emulation).
 */
async function setViewport(win: Page, width: number, height: number) {
  await win.setViewportSize({ width, height });
  await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(width);
}

async function reload(win: Page): Promise<void> {
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
}

test.describe('with QUADRION_SHOW_GATE=1', () => {
  test.use({ appEnv: { QUADRION_SHOW_GATE: '1' } });

  test('greets the person over the mounted app, and Enter opens the projects', async ({ win }) => {
    await expect(gate(win)).toBeVisible();
    // the app shell is already there underneath, out of reach until Enter
    await expect(win.locator('#root > .app')).toHaveAttribute('inert', '');
    await expect(projectsHeading(win)).toBeAttached();
    // Enter works from the first frame: how soon after the window began loading (a cold start)
    const coldMs = Number(await gate(win).getAttribute('data-ready-ms'));
    expect(coldMs).toBeGreaterThan(0);

    // the name comes from the identity (the author of issues), the company from report branding
    await win.evaluate(async () => {
      await window.aio.invoke('identity:set', { name: 'Rana Example' });
      await window.aio.invoke('settings:set', {
        reportBranding: { companyName: 'Synapse Solutions' },
      });
    });
    await reload(win);
    await setViewport(win, 1440, 900);
    if (SHOTS) {
      await win.waitForTimeout(250);
      await shot(win, 'launch-intro');
    }
    const panel = win.getByRole('region', { name: 'Open Quadrion AI' });
    await expect(panel).toBeVisible();
    await expect(win.getByTestId('launch-gate-name')).toHaveText('Rana Example');
    await expect(panel).toContainText('Welcome back,');
    await expect(win.getByTestId('launch-gate-org')).toHaveText(
      'Synapse Solutions · this computer',
    );
    // the same words as the title bar chips: the mode, then what it leaves of cloud AI
    await expect(panel).toContainText(/Online\s*·\s*cloud AI off/);
    await expect(win.locator('.qg-clock')).toContainText(/\d\d:\d\d:\d\d/);
    await expect(win.getByRole('img', { name: 'Quadrion AI' }).first()).toBeVisible();

    // ... and after a reload (warm)
    const warmMs = Number(await gate(win).getAttribute('data-ready-ms'));
    test.info().annotations.push({
      type: 'enter-ready-ms',
      description: `cold ${String(coldMs)}, warm ${String(warmMs)}`,
    });
    process.stdout.write(
      `launch screen: Enter works ${String(coldMs)} ms (cold) and ${String(warmMs)} ms (reload) after the window began loading\n`,
    );

    // no focus ring on load; Skip intro goes with the intro, then Tab reaches Enter
    await expect(win.getByRole('button', { name: 'Enter' })).not.toBeFocused();
    await expect(gate(win)).toHaveAttribute('data-phase', 'ready', { timeout: 5000 });
    await expect(win.locator('.qg-skip')).toHaveAttribute('inert', '');

    // Split: the lockup on the left, the welcome on the right
    const brand = await box(win, '.qg-brand');
    const entry = await box(win, '.qg-entry');
    expect(brand.x + brand.width).toBeLessThanOrEqual(entry.x);
    expect(Math.abs(centreY(brand) - centreY(entry))).toBeLessThan(80);
    await expectMarkBesideWordmark(win);

    // the pointer moves the plates (fine pointers only), the top plate furthest
    if (await win.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)) {
      await win.mouse.move(1300, 120, { steps: 8 });
      await win.waitForTimeout(700);
      const shift = await win.evaluate(() =>
        [0, 3].map((i) => {
          const tf = document.querySelector(`.qg-mark path.plate[data-plate="${String(i)}"]`);
          const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(tf?.getAttribute('transform') ?? '');
          return m ? Math.abs(Number(m[1])) : 0;
        }),
      );
      expect(shift[1]).toBeGreaterThan(0.5);
      expect(shift[1]).toBeGreaterThan(shift[0] ?? 0);
    }
    await shot(win, 'launch-1440x900');

    await win.keyboard.press('Tab');
    await expect(win.getByRole('button', { name: 'Enter' })).toBeFocused();

    await win.keyboard.press('Enter');
    await expect(gate(win)).toHaveCount(0, { timeout: 2000 });
    await expect(win.locator('#root > .app')).not.toHaveAttribute('inert', '');
    await expect(projectsHeading(win)).toBeVisible();
    await shot(win, 'launch-after-enter');
    // the gate's focus does not wander into the app; the app's own shortcuts work again
    expect(await win.evaluate(() => document.activeElement === document.body)).toBe(true);
    await win.keyboard.press('Control+k');
    await expect(win.getByRole('dialog').first()).toBeVisible();
    await win.keyboard.press('Escape');
  });

  test('Esc skips the intro; a narrow window stacks the welcome; it passes axe', async ({
    win,
  }) => {
    await expect(gate(win)).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(gate(win)).toHaveAttribute('data-instant', '');
    await expect(gate(win)).toHaveAttribute('data-phase', 'ready');
    await expect(gate(win)).toBeVisible();

    await setViewport(win, 820, 900);
    const brand = await box(win, '.qg-brand');
    const entry = await box(win, '.qg-entry');
    expect(entry.y).toBeGreaterThanOrEqual(brand.y + brand.height);
    const middle = 820 / 2;
    expect(Math.abs(entry.x + entry.width / 2 - middle)).toBeLessThan(4);
    await expectMarkBesideWordmark(win);
    await win.mouse.move(600, 700, { steps: 6 });
    await win.waitForTimeout(600);
    await shot(win, 'launch-820x900');

    await expectAccessible(win, 'launch screen', { include: '[data-testid="launch-gate"]' });

    // a click works as well as the key
    await win.getByRole('button', { name: 'Enter' }).click();
    await expect(gate(win)).toHaveCount(0, { timeout: 2000 });
    await expect(projectsHeading(win)).toBeVisible();
  });

  test('reduced motion shows the screen at once, still', async ({ win }) => {
    await win.emulateMedia({ reducedMotion: 'reduce' });
    await reload(win);
    await expect(gate(win)).toHaveAttribute('data-phase', 'ready', { timeout: 1000 });
    await expect(win.getByRole('button', { name: 'Enter' })).toBeVisible();
    await win.mouse.move(1300, 120, { steps: 6 });
    await win.waitForTimeout(500);
    const moved = await win.evaluate(
      () => document.querySelectorAll('.qg-mark [data-plate][transform]').length,
    );
    expect(moved).toBe(0);
    await win.keyboard.press('Enter');
    await expect(gate(win)).toHaveCount(0, { timeout: 2000 });
  });

  test('Settings, Appearance, Show launch screen off: the next start opens the app', async ({
    win,
  }) => {
    await expect(gate(win)).toBeVisible();
    await win.keyboard.press('Enter');
    await expect(gate(win)).toHaveCount(0, { timeout: 2000 });

    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win.locator('.set-nav button', { hasText: 'Appearance' }).click();
    const toggle = win.getByRole('switch', { name: 'Show launch screen' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect
      .poll(() => win.evaluate(() => window.aio.invoke('launch:get', {})))
      .toMatchObject({ ok: true, settings: { show: false } });
    // its own file: settings.json keeps exactly the keys a 0.9 build reads
    expect(await win.evaluate(() => window.aio.invoke('settings:get', {}))).not.toHaveProperty(
      'launchScreen',
    );

    await reload(win);
    await expect(projectsHeading(win)).toBeVisible();
    await expect(gate(win)).toHaveCount(0);

    // switched back on outside this window: this start already went to the app, the next shows it
    await win.evaluate(() => window.aio.invoke('launch:set', { show: true }));
    await reload(win);
    await expect(projectsHeading(win)).toBeVisible();
    await expect(gate(win)).toHaveCount(0);
    await expect
      .poll(() => win.evaluate(() => localStorage.getItem('quadrion.launchScreen')))
      .toBe('1');
    await reload(win);
    await expect(gate(win)).toBeVisible();
    // switched off outside this window: gone as soon as main answers
    await win.evaluate(() => window.aio.invoke('launch:set', { show: false }));
    await reload(win);
    await expect(gate(win)).toHaveCount(0, { timeout: 2000 });
    await expect(projectsHeading(win)).toBeVisible();
  });
});

test('an automated run goes straight to the app', async ({ win }) => {
  await expect(projectsHeading(win)).toBeVisible();
  await expect(gate(win)).toHaveCount(0);
  await expect(win.locator('#root > .app')).not.toHaveAttribute('inert', '');
});
