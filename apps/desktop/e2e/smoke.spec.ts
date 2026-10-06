import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleManifest, writeProject } from '../src/main/testing';
import { GPU_ARGS } from './fixtures';

const ALLOWED = ['file:', 'aio:', 'devtools:', 'data:', 'blob:', 'chrome-extension:'];

test('the app starts, exposes the bridge and makes no network requests', async () => {
  // an isolated profile: the person's settings stay untouched and the window opens off-screen
  const base = await mkdtemp(join(tmpdir(), 'stratlas-e2e-'));
  const app = await electron.launch({
    args: [...GPU_ARGS, join(import.meta.dirname, '../out/main/index.js')],
    env: { ...process.env, STRATLAS_USER_DATA: join(base, 'user') },
  });
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
  await rm(base, { recursive: true, force: true });
});

test('library, settings and aio:// work offline and the protocol refuses traversal', async () => {
  const base = await mkdtemp(join(tmpdir(), 'stratlas-e2e-'));
  const dataRoot = join(base, 'data');
  await writeProject(join(dataRoot, 'projects', 'alzour'), sampleManifest(), {
    'thumbnail.jpg': '0123456789',
  });

  const app = await electron.launch({
    args: [...GPU_ARGS, join(import.meta.dirname, '../out/main/index.js')],
    env: { ...process.env, STRATLAS_USER_DATA: join(base, 'user'), STRATLAS_DATA: dataRoot },
  });
  const outbound: string[] = [];
  app.context().on('request', (req) => {
    const proto = new URL(req.url()).protocol;
    if (!ALLOWED.includes(proto)) outbound.push(req.url());
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const settings = await win.evaluate(() => window.aio.invoke('settings:get', {}));
    expect(settings.cloudAi).toBe(false);
    expect(settings.dataRoot).toBe(dataRoot);

    const library = await win.evaluate(() => window.aio.invoke('library:list', {}));
    expect(library).toHaveLength(1);
    expect(library[0]).toMatchObject({
      id: 'alzour',
      kind: 'native',
      thumbnail: 'aio://project/alzour/thumbnail.jpg',
    });

    const slice = await win.evaluate(async () => {
      const r = await fetch('aio://project/alzour/thumbnail.jpg', {
        headers: { Range: 'bytes=2-5' },
      });
      return { status: r.status, range: r.headers.get('content-range'), body: await r.text() };
    });
    expect(slice).toEqual({ status: 206, range: 'bytes 2-5/10', body: '2345' });

    const traversal = await win.evaluate(() =>
      Promise.all(
        ['aio://project/../x', 'aio://project/alzour/..%2F..%2Fsecret.txt'].map((u) =>
          fetch(u).then(
            (r) => r.status,
            () => 'blocked',
          ),
        ),
      ),
    );
    for (const result of traversal) expect([403, 404, 'blocked']).toContain(result);

    expect(outbound).toEqual([]);
  } finally {
    await app.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('isolated test profiles open windows off-screen without a taskbar button', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const base = await mkdtemp(join(tmpdir(), 'stratlas-offscreen-'));
  const app = await electron.launch({
    args: [...GPU_ARGS, join(import.meta.dirname, '../out/main/index.js')],
    env: {
      ...process.env,
      STRATLAS_USER_DATA: join(base, 'user'),
      STRATLAS_DATA: join(base, 'data'),
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const placed = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const b = w?.getBounds();
    const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
    return { right: b ? b.x + b.width : 0, left, focused: w?.isFocused() ?? true };
  });
  // macOS (AppKit constrainFrameRect:toScreen:) moves a titled window back onto a display when it
  // is shown, so there it only opens without focus; Windows keeps it left of every display.
  if (process.platform !== 'darwin') expect(placed.right).toBeLessThan(placed.left);
  expect(placed.focused).toBe(false);
  // It still renders: the shell is on the page.
  await expect(win.locator('.titlebar')).toBeVisible();
  await app.close();
});
