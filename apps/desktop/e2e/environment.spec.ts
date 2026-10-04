/**
 * Stage environment on the real Al-Zour project (founder: "the water and shadows and the sky; we
 * should be able to pull a slider to choose the time of day"): the project opens under a sky
 * with the sea drawn, and the time-of-day slider moves the sun. Skipped where the project is
 * absent. Read-only: nothing is written to the project (choices live in the throwaway profile).
 */
import { test as base, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard } from './fixtures';

const DATA = process.env.STRATLAS_HCL_DATA ?? 'E:\\Stratlas Data';
const has = (id: string) => existsSync(join(DATA, 'projects', id, 'manifest.json'));

interface Env {
  mode: string;
  timeMs: number;
  waterShown: boolean;
  dataWaterLevel: number | null;
  sun: { azimuthDeg: number; elevationDeg: number; direction: [number, number, number] };
}
interface Inspect {
  __stratlas: { stage(): { environment: Env } | null };
}

const test = base.extend<{ app: ElectronApplication; win: Page }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  app: async ({}, use) => {
    const tmp = await mkdtemp(join(tmpdir(), 'aio-env-'));
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

const env = (win: Page) =>
  win.evaluate(() => (window as unknown as Inspect).__stratlas.stage()?.environment ?? null);

/** The environment popover, opened from the toolbar or from More when the toolbar is narrow. */
async function openPanel(win: Page) {
  const button = win.getByRole('button', { name: 'Environment and time of day' });
  if (!(await button.isVisible())) await win.getByRole('button', { name: 'More tools' }).click();
  await button.click();
  await expect(win.getByTestId('env-panel')).toBeVisible();
}

test.describe('alzour', () => {
  test.skip(!has('alzour'), `alzour project not found under ${DATA}`);

  test('opens under a sky with the sea, and the time slider moves the sun', async ({ win }) => {
    await win.getByTestId('project-card').filter({ hasText: 'Al-Zour' }).first().click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
    // the plant model brings the sea level
    await expect.poll(async () => (await env(win))?.waterShown, { timeout: 60_000 }).toBe(true);
    const start = await env(win);
    expect(start?.mode).toBe('sky');
    // the capture: the first flight on 21 Feb 2023, 13:22 Kuwait time
    expect(new Date(start?.timeMs ?? 0).toISOString()).toBe('2023-02-21T10:22:38.000Z');

    await openPanel(win);
    const slider = win.getByTestId('env-time');
    await slider.fill('420'); // 07:00
    const morning = await env(win);
    await slider.fill('1020'); // 17:00
    const evening = await env(win);
    if (!morning || !evening) throw new Error('no stage');
    // morning sun in the east (+x), evening sun in the west (-x), both above the horizon
    expect(morning.sun.direction[0]).toBeGreaterThan(0.5);
    expect(evening.sun.direction[0]).toBeLessThan(-0.5);
    expect(morning.sun.elevationDeg).toBeGreaterThan(0);
    expect(evening.sun.elevationDeg).toBeGreaterThan(0);
    await expect(win.getByTestId('env-sun')).toContainText('Sun');

    // night: the moon takes over, the readout says so
    await slider.fill('1380'); // 23:00
    expect((await env(win))?.sun.elevationDeg).toBeLessThan(0);
    await expect(win.getByTestId('env-sun')).toContainText('moonlight');

    // studio and back keeps the chosen time
    await win.getByTestId('env-panel').getByRole('button', { name: 'Studio' }).click();
    expect((await env(win))?.mode).toBe('studio');
    await win.getByTestId('env-panel').getByRole('button', { name: 'Sky' }).click();
    const back = await env(win);
    expect(back?.mode).toBe('sky');
    expect(back?.sun.elevationDeg).toBeLessThan(0);

    // the choice is remembered for the project on this workstation
    await expect
      .poll(() =>
        win.evaluate(() => {
          const raw = localStorage.getItem('stratlas.environment') ?? '{}';
          return (JSON.parse(raw) as Record<string, { mode?: string }>).alzour?.mode ?? null;
        }),
      )
      .toBe('sky');
  });
});
