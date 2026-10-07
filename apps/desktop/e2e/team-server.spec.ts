/**
 * Team Server (M9 T7, preview): Settings, Data folder, Team server against a real server running
 * in this test process on 127.0.0.1 (memory store, TEST-ONLY certificate). The zero-network
 * guard lets only that origin through (`AIO_NETWORK_GUARD_ALLOW`; the guard keys loopback
 * origins as http, and the app's TLS socket and request both pass under it).
 */
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, launchApp, NetworkGuard, test, type DataRoot } from './fixtures';

/** The slice of `apps/team-server/src/testkit.ts` this spec uses. */
interface TestServer {
  origin: string;
  fingerprint: string;
  invite(
    role: 'owner' | 'reviewer' | 'viewer' | 'client',
    project?: string | null,
  ): Promise<string>;
  store: { devices(): Promise<{ role: string; name: string; device: string }[]> };
  close(): Promise<void>;
}

/** Load the server from its sources (not a dependency of the app, so not a static import). */
async function startServer(): Promise<TestServer> {
  const kit = join(import.meta.dirname, '..', '..', 'team-server', 'src', 'testkit.ts');
  const mod = (await import(pathToFileURL(kit).href)) as {
    startLoopbackServer: () => Promise<TestServer>;
  };
  return mod.startLoopbackServer();
}

const grouped = (fp: string) => (fp.toUpperCase().match(/.{1,4}/g) ?? []).join(' ');

async function openTeamServer(win: Page) {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: 'Data folder' }).click();
  await expect(win.getByTestId('team-server')).toBeVisible();
}

async function start(dataRoot: DataRoot, server: TestServer) {
  // the guard knows loopback origins as http; the app speaks https to the same port
  const guarded = server.origin.replace('https:', 'http:');
  const app = await launchApp(dataRoot, { AIO_NETWORK_GUARD_ALLOW: guarded });
  const network = new NetworkGuard([guarded]);
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, network, guarded };
}

test('connects to a team server after the fingerprint is checked, and keeps working without it', async ({
  dataRoot,
}) => {
  test.setTimeout(90_000);
  const server = await startServer();
  const { app, win, network, guarded } = await start(dataRoot, server);
  const block = win.getByTestId('team-server');
  try {
    await openTeamServer(win);
    await expect(block.getByRole('heading', { name: /Team server/ })).toContainText('Preview');
    await expect(block).toContainText('No team server is connected on this computer.');
    expect(await network.allowed(), 'nothing is sent before the person connects').toEqual([]);

    await block.getByLabel('Team server address').fill(server.origin);
    await block.getByLabel('Invite code').fill(await server.invite('reviewer'));
    await block.getByRole('button', { name: 'Connect' }).click();

    // first contact: the certificate fingerprint to compare, nothing enrolled yet
    const fingerprint = block.getByLabel('Certificate fingerprint');
    await expect(fingerprint).toHaveText(grouped(server.fingerprint));
    expect(await server.store.devices()).toEqual([]);

    await block.getByRole('button', { name: 'They match, connect' }).click();
    await expect(block.getByText('Connected to Test team server.')).toBeVisible();
    const list = block.getByRole('list', { name: 'Team servers on this computer' });
    await expect(list).toContainText('Test team server');
    await expect(list).toContainText('Enrolled as reviewer, server version 0.1.0-test');
    const devices = await server.store.devices();
    expect(devices.map((d) => d.role)).toEqual(['reviewer']);

    // the only traffic went to the team server
    expect(await network.outbound()).toEqual([]);
    const allowed = await network.allowed();
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed.every((u) => u.startsWith(guarded))).toBe(true);

    // the server goes away: the app keeps working and still lists it
    await server.close();
    await win.locator('.set-nav button', { hasText: 'Appearance' }).click();
    await expect(win.locator('.set-page h1')).toHaveText('Appearance');
    await openTeamServer(win);
    await expect(list).toContainText('Test team server');

    await block.getByRole('button', { name: 'Forget Test team server' }).click();
    await expect(block).toContainText('No team server is connected on this computer.');
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
    await server.close().catch(() => undefined);
  }
});

test('shows the server refusing a used invite code, and connects nowhere when offline only is on', async ({
  dataRoot,
}) => {
  test.setTimeout(90_000);
  const server = await startServer();
  const { app, win, network } = await start(dataRoot, server);
  const block = win.getByTestId('team-server');
  try {
    const code = await server.invite('viewer');
    await openTeamServer(win);
    for (let i = 0; i < 2; i++) {
      await block.getByLabel('Team server address').fill(server.origin);
      await block.getByLabel('Invite code').fill(code);
      await block.getByRole('button', { name: 'Connect' }).click();
      await block.getByRole('button', { name: 'They match, connect' }).click();
      if (i === 0) await expect(block.getByText('Connected to Test team server.')).toBeVisible();
    }
    await expect(block.getByRole('alert')).toContainText('This invite code is not valid');

    await win.locator('.set-nav button', { hasText: 'Privacy and cloud' }).click();
    await win.getByRole('switch', { name: 'Offline-only workstation' }).click();
    await openTeamServer(win);
    await expect(block).toContainText('Offline only is on');
    await block.getByLabel('Team server address').fill(server.origin);
    await block.getByLabel('Invite code').fill('ABCD-EFGH-JKMN-PQRS');
    await expect(block.getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
    await server.close();
  }
});
