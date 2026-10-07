/**
 * Stage environment on the real Al-Zour project (founder: "the water and shadows and the sky; we
 * should be able to pull a slider to choose the time of day"): the project opens under a sky
 * with the sea drawn, and the time-of-day slider moves the sun. Skipped where the project is
 * absent. Runs on a temporary copy of the project (realData.ts, @realdata).
 */
import type { Page } from '@playwright/test';
import { expect, realDataTest } from './fixtures';
import { hasRealProject, missingRealProject } from './realData';

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

const test = realDataTest(['alzour'], { size: [1440, 900] });

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

test.describe('@realdata alzour', () => {
  test.skip(!hasRealProject('alzour'), missingRealProject('alzour'));

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
