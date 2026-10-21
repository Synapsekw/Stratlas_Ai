/** Synthetic website updater: real IPC/controller, isolated account and no installer or network. */
import type { Page } from '@playwright/test';
import { expect, launchApp, NetworkGuard, test } from './fixtures';

interface UpdateHarness {
  ready: () => void;
  busy: (value: boolean) => void;
  requests: string[];
  restarts: number;
}
async function openAbout(win: Page) {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: 'About and updates' }).click();
  await expect(win.getByTestId('website-updates')).toBeVisible();
}

test('website account downloads app and kit in background, then requires an explicit safe restart', async ({
  dataRoot,
}, testInfo) => {
  const app = await launchApp(dataRoot, { QUADRION_WEBSITE_UPDATE_TEST: '1' });
  const network = new NetworkGuard();
  try {
    await network.attach(app);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await openAbout(win);
    await win.getByLabel('Website account email').fill('engineer@example.test');
    await win.getByLabel('Website account password').fill('synthetic-password');
    await win.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(win.getByText('Signed in as engineer@example.test')).toBeVisible();
    await expect(win.getByRole('progressbar', { name: 'App download' })).toHaveAttribute(
      'value',
      /[1-9]/,
    );
    await expect(win.getByRole('progressbar', { name: 'Processing kit download' })).toBeVisible();
    await expect(win.getByRole('button', { name: 'Restart and update' })).toHaveCount(0);

    await win.locator('.nav-item', { hasText: 'Projects' }).click();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { __aioWebsiteUpdates: UpdateHarness }
      ).__aioWebsiteUpdates.ready();
    });
    const notice = win.getByTestId('website-update-ready');
    await expect(notice).toBeVisible();
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { __aioWebsiteUpdates: UpdateHarness })
            .__aioWebsiteUpdates.restarts,
      ),
    ).toBe(0);
    await notice.click();
    const restart = win.getByRole('button', { name: 'Restart and update', exact: true });
    await expect(restart).toBeEnabled();
    await win.getByTestId('website-updates').scrollIntoViewIfNeeded();
    await win.screenshot({ path: testInfo.outputPath('website-updates-ready.png') });
    await testInfo.attach('website-updates-ready', {
      path: testInfo.outputPath('website-updates-ready.png'),
      contentType: 'image/png',
    });

    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { __aioWebsiteUpdates: UpdateHarness }
      ).__aioWebsiteUpdates.busy(true);
    });
    await restart.click();
    await expect(win.getByTestId('website-update-error')).toContainText(/processing|work|finish/i);
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { __aioWebsiteUpdates: UpdateHarness })
            .__aioWebsiteUpdates.restarts,
      ),
    ).toBe(0);
    await expect(restart).toBeEnabled();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { __aioWebsiteUpdates: UpdateHarness }
      ).__aioWebsiteUpdates.busy(false);
    });
    await restart.click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { __aioWebsiteUpdates: UpdateHarness })
              .__aioWebsiteUpdates.restarts,
        ),
      )
      .toBe(1);
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});

test('offline-only blocks website account and update requests at the main boundary', async ({
  dataRoot,
}) => {
  const app = await launchApp(dataRoot, { QUADRION_WEBSITE_UPDATE_TEST: '1' });
  const network = new NetworkGuard();
  try {
    await network.attach(app);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win.locator('.set-nav button', { hasText: 'Privacy and cloud' }).click();
    await win.getByRole('switch', { name: 'Offline-only workstation' }).click();
    await expect(win.getByRole('switch', { name: 'Offline-only workstation' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await openAbout(win);
    await expect(win.getByLabel('Website account password')).toBeDisabled();
    await expect(win.getByRole('switch', { name: 'Automatic website updates' })).toBeDisabled();
    const results = await win.evaluate(async () => ({
      signIn: await window.aio.invoke('websiteUpdate:signIn', {
        email: 'engineer@example.test',
        password: 'synthetic-password',
      }),
      check: await window.aio.invoke('websiteUpdate:check', {}),
    }));
    expect(results.signIn.ok).toBe(false);
    expect(results.check.ok).toBe(false);
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { __aioWebsiteUpdates: UpdateHarness })
            .__aioWebsiteUpdates.requests,
      ),
    ).toEqual([]);
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});
