/**
 * Updates (ADR 0003): bundled release notes, the online feed against a local server (the only
 * origin the zero-network guard lets through), and the first-start watch after an update.
 */
import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, test } from './fixtures';

/** The product version, as the release notes carry it. */
const version = (
  JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
    version: string;
  }
).version;

async function openAbout(win: Page): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: 'About and updates' }).click();
  await expect(win.locator('.set-page h1')).toHaveText('About and updates');
}

test('shows the release notes of this version and why rollback is unavailable', async ({ win }) => {
  await openAbout(win);
  await expect(win.getByRole('heading', { name: `What's new in ${version}` })).toBeVisible();
  await expect(win.getByTestId('release-notes')).not.toBeEmpty();
  // A development build has no installed folder to keep.
  await expect(win.getByTestId('update-previous')).toContainText('development build');
});

test('checks the update feed on a local server only when asked, and verifies the download', async ({
  dataRoot,
}) => {
  const installer = Buffer.from('MZ not a signed installer '.repeat(200));
  const sha256 = createHash('sha256').update(installer).digest('hex');
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/stratlas/stratlas-update.json') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          schema: 'aio.update-feed/1',
          version: '999.0.0',
          notes: '# Stratlas 999.0.0\n\n## New\n\n- A feature from the feed\n',
          files: {
            'win-x64': {
              url: 'Stratlas-999.0.0-win-x64-setup.exe',
              sha256,
              size: installer.length,
            },
          },
        }),
      );
    } else if (req.url === '/stratlas/Stratlas-999.0.0-win-x64-setup.exe') {
      res.end(installer);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const network = new NetworkGuard([origin]);
  const app = await launchApp(dataRoot, { AIO_NETWORK_GUARD_ALLOW: origin });
  try {
    await network.attach(app);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await openAbout(win);
    await win.waitForTimeout(500);
    expect(requests, 'nothing is checked before the person asks').toEqual([]);

    await win.getByRole('switch', { name: 'Check for updates online' }).click();
    const address = win.getByLabel('Update address');
    await address.fill(`${origin}/stratlas/`);
    await address.blur();
    await win.getByRole('button', { name: 'Check now' }).click();

    if (process.platform === 'win32' && process.arch === 'x64') {
      await expect(win.getByText('Version 999.0.0 is available.')).toBeVisible();
      await win.getByText('What is new in 999.0.0').click();
      await expect(win.getByText('A feature from the feed')).toBeVisible();
      await win.getByRole('button', { name: /^Download and install/ }).click();
      // Downloaded and SHA-256 checked, then refused: the test file carries no signature.
      await expect(win.getByTestId('update-error')).toContainText(/not signed|not valid/, {
        timeout: 30_000,
      });
      expect(requests).toEqual([
        '/stratlas/stratlas-update.json',
        '/stratlas/Stratlas-999.0.0-win-x64-setup.exe',
      ]);
      const kept = join(dataRoot.userData, 'updates', 'downloads');
      expect(await readFile(join(kept, 'Stratlas-999.0.0-win-x64-setup.exe'))).toEqual(installer);
    } else {
      await expect(win.getByTestId('update-error')).toContainText('no installer for this computer');
      expect(requests).toEqual(['/stratlas/stratlas-update.json']);
    }
    expect(await network.outbound()).toEqual([]);
    expect((await network.allowed()).every((u) => u.startsWith(origin))).toBe(true);
  } finally {
    await app.close();
    await new Promise<void>((ok) => {
      server.close(() => {
        ok();
      });
    });
  }
});

test('a first start after an update ends its watch once the window is ready', async ({
  dataRoot,
}) => {
  // The version the app reports (a development run may report Electron's own).
  const probe = await launchApp(dataRoot);
  const running = await probe.evaluate(({ app }) => app.getVersion());
  await probe.close();

  const dir = join(dataRoot.userData, 'updates');
  await mkdir(dir, { recursive: true });
  const journal = join(dir, 'journal.json');
  await writeFile(
    journal,
    JSON.stringify({
      schema: 'aio.update-journal/1',
      pending: {
        from: '0.6.0',
        to: running,
        startedAt: '2026-10-05T10:00:00.000Z',
        appRoot: join(dataRoot.base, 'Programs', 'Stratlas'),
        launches: 0,
        failures: 0,
        cleanExit: true,
        declined: false,
      },
      previous: { version: '0.6.0', dir: join(dir, 'previous', '0.6.0'), exe: 'Stratlas.exe' },
    }),
  );
  const network = new NetworkGuard();
  const app = await launchApp(dataRoot);
  try {
    await network.attach(app);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const read = async () =>
      JSON.parse(await readFile(journal, 'utf8')) as {
        pending?: unknown;
        previous?: { version: string };
      };
    await expect.poll(async () => (await read()).pending).toBeUndefined();
    expect((await read()).previous?.version).toBe('0.6.0');
    const log = await readFile(join(dataRoot.userData, 'logs', 'main.log'), 'utf8');
    expect(log).toContain(`Version ${running} started well after the update.`);
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});
