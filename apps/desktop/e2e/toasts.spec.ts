/**
 * The one toast host (@aio/ui ToastHost, mounted by exports/Toasts.tsx): every notice shows
 * through it, one at a time. The newest shows; an older one waits and comes back when the newer
 * goes. Both are read out politely (role status), and each keeps its close button.
 *
 * Two real notices: the graphics step-down after memory pressure (the graphics store, as the
 * memory watch raises it) and an issue code renumbered by a sync (the `sync:notice` event, as
 * main sends it). An error (the volumetric layer's message) is never covered by a newer notice,
 * and a count says how many wait. QUADRION_E2E_SHOTS=<folder> saves the states.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { join } from 'node:path';
import { expect, test } from './fixtures';

const SHOTS = process.env.QUADRION_E2E_SHOTS;

interface W {
  __stratlas: {
    workspace: { getState(): { project: { id: string } | null } };
    graphics(): { getState(): { relieve(reason: 'memory'): boolean } };
    volumetric: { getState(): { setMessage(message: string | null): void } };
  };
}

async function recode(app: ElectronApplication, projectId: string, to: string) {
  await app.evaluate(
    ({ BrowserWindow }, [id, code]) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('sync:notice', {
        projectId: id,
        notices: [{ kind: 'recode', issue: 'missing', from: 'F01', to: code }],
      });
    },
    [projectId, to] as const,
  );
}

async function shot(win: Page, name: string) {
  if (!SHOTS) return;
  await win.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' });
}

test('two notices show one at a time with role status', async ({ app, win }) => {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.nav-item[aria-current="page"] .lbl')).toHaveText('Scene');
  const projectId = await win.evaluate(
    () => (window as unknown as W).__stratlas.workspace.getState().project?.id ?? '',
  );
  expect(projectId).not.toBe('');

  const host = win.getByTestId('toast-host-window');
  const cards = host.locator('.q-toast');
  const graphicsNotice = win.getByTestId('graphics-notice');
  const syncNotice = win.getByTestId('sync-notice');

  // the first notice: the graphics stepped down
  await win.evaluate(() => {
    (window as unknown as W).__stratlas.graphics().getState().relieve('memory');
  });
  await expect(graphicsNotice).toBeVisible();
  await expect(graphicsNotice).toContainText('Lighter graphics for now');
  await expect(win.locator('[role="status"]').getByTestId('graphics-notice')).toHaveCount(1);
  await expect(cards).toHaveCount(1);

  // the second: a sync renumbered an issue code. It shows; the first waits
  await recode(app, projectId, 'F07');
  await expect(syncNotice).toBeVisible();
  await expect(syncNotice).toContainText('Issue code changed');
  await expect(win.locator('[role="status"]').getByTestId('sync-notice')).toHaveCount(1);
  await expect(graphicsNotice).toHaveCount(0);
  await expect(cards).toHaveCount(1);
  await expect(win.getByTestId('toast-waiting-window')).toHaveText('1 more');
  await shot(win, 'toasts-one-at-a-time');

  // closing the newer one brings the waiting one back
  await syncNotice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(syncNotice).toHaveCount(0);
  await expect(graphicsNotice).toBeVisible();
  await expect(cards).toHaveCount(1);
  await shot(win, 'toasts-waiting-one-back');

  // and Escape on a focused notice closes it too
  await graphicsNotice.getByRole('button', { name: 'Dismiss' }).focus();
  await win.keyboard.press('Escape');
  await expect(graphicsNotice).toHaveCount(0);
  await expect(cards).toHaveCount(0);

  // an error stays on top: a newer notice waits behind it, counted, and shows once it goes
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible({ timeout: 30_000 });
  await win.evaluate(() => {
    (window as unknown as W).__stratlas.volumetric
      .getState()
      .setMessage('Volumes could not be computed.');
  });
  const error = win.getByTestId('vol-message');
  await expect(win.locator('[role="alert"]').getByTestId('vol-message')).toBeVisible();
  await recode(app, projectId, 'F08');
  await expect(error).toBeVisible();
  await expect(syncNotice).toHaveCount(0);
  await expect(win.getByTestId('toast-waiting-window')).toHaveText('1 more');
  await shot(win, 'toasts-error-stays');
  await error.getByRole('button', { name: 'Close' }).click();
  await expect(error).toHaveCount(0);
  await expect(syncNotice).toContainText('F08');
  await expect(win.getByTestId('toast-waiting-window')).toHaveCount(0);
});
