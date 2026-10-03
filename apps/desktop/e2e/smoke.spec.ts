import { _electron as electron, expect, test } from '@playwright/test';
import { join } from 'node:path';

const ALLOWED = ['file:', 'aio:', 'devtools:', 'data:', 'blob:', 'chrome-extension:'];

test('the app starts, exposes the bridge and makes no network requests', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')] });
  const outbound: string[] = [];
  app.context().on('request', (req) => {
    const proto = new URL(req.url()).protocol;
    if (!ALLOWED.includes(proto)) outbound.push(req.url());
  });

  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect(win.locator('.wordmark')).toHaveText(/STRATLAS/);

  const info = await win.evaluate(() => window.aio.invoke('app:getInfo', {}));
  expect(info.name).toBe('Stratlas');

  const rejected = await win.evaluate(() =>
    window.aio.invoke('app:getInfo', { extra: 1 } as never).then(
      () => 'accepted',
      (e: unknown) => String(e),
    ),
  );
  expect(rejected).toContain('Invalid request on app:getInfo');

  expect(outbound).toEqual([]);
  await app.close();
});
