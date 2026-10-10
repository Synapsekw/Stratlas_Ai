/**
 * Offline-only blocks cloud AI, with the real providers (no scripted model) behind the
 * zero-network guard, which records every request the main process tries to make.
 *
 * - With cloud AI on and a key set, Test connection tries api.anthropic.com (the guard cuts it):
 *   the control that a cloud request would be seen here.
 * - Offline-only turned on: the very next call is refused with the reason, as is every other AI
 *   path, and the guard sees no request at all. The agent panel, the title bar and Settings say
 *   that cloud AI is off because of offline-only.
 * - A local model on this machine (the fake server on 127.0.0.1) keeps answering under
 *   offline-only; the same "local" model pointed at another machine is refused.
 */
import { MESSAGES } from '@aio/ai/main';
import { offlineRoutes } from '@aio/ai/routes';
import type { Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GREETING, startFakeLlm } from './fake-llm';
import { createDataRoot, expect, launchApp, NetworkGuard, test, TINY_PROJECT_ID } from './fixtures';

test.setTimeout(120_000);

const SHOTS = process.env.QUADRION_E2E_SHOTS;

async function shot(win: Page, name: string) {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Shaped like a key, and not one: it only has to be present in the test vault. */
const KEY = 'sk-ant-e2e-NOT-A-REAL-KEY-0123456789';
const REMOTE = 'http://192.168.1.20:11434/v1';

const agent = (win: Page) => win.getByRole('region', { name: 'Agent' });
const box = (win: Page) => agent(win).getByRole('textbox', { name: 'Message the agent' });

async function openTiny(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.crumbs')).toContainText('E2E tiny project');
}

async function openSettings(win: Page, page: string) {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: page }).click();
}

/** Every AI call the renderer can make that would reach a cloud provider. */
const cloudCalls = (win: Page, projectId: string) =>
  win.evaluate(async (id) => {
    const send = await window.aio.invoke('ai:send', {
      runId: 'offline-send',
      projectId: id,
      window: 'scene3d',
      context: {},
      messages: [{ role: 'user', content: 'hi' }],
    });
    const detect = await window.aio.invoke('ai:detect', {
      runId: 'offline-detect',
      projectId: id,
      classes: [{ id: 'rust', label: 'Rust' }],
      images: [{ key: 'a', dataUrl: 'data:image/png;base64,AAAA', width: 8, height: 8 }],
    });
    const draft = await window.aio.invoke('ai:draftText', {
      runId: 'offline-draft',
      projectId: id,
      task: 'report',
      system: 'Write.',
      prompt: 'Summarise.',
    });
    const test = await window.aio.invoke('ai:testConnection', { provider: 'anthropic' });
    const status = await window.aio.invoke('ai:status', { projectId: id });
    return {
      send: send.error,
      detect: detect.ok ? 'ok' : detect.error,
      draft: draft.ok ? 'ok' : draft.error,
      test: test.message,
      status: status.reason,
    };
  }, projectId);

test('offline-only: no cloud AI request leaves, and the app says why', async () => {
  const data = await createDataRoot();
  const app = await launchApp(data);
  const network = new NetworkGuard();
  try {
    await network.attach(app);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.evaluate(
      (key) => window.aio.invoke('ai:setKey', { provider: 'anthropic', key }),
      KEY,
    );
    // Settings, Privacy and cloud: cloud AI on, as the person turns it on.
    await openSettings(win, 'Privacy and cloud');
    const cloudSwitch = win.getByRole('switch', { name: 'Allow cloud AI' });
    const offlineSwitch = win.getByRole('switch', { name: 'Offline-only workstation' });
    await cloudSwitch.click();
    await expect(cloudSwitch).toHaveAttribute('aria-checked', 'true');
    const chip = win.getByTestId('cloud-chip');
    await expect(chip).toHaveText('Cloud AI');
    const testConnection = () =>
      win.evaluate(() => window.aio.invoke('ai:testConnection', { provider: 'anthropic' }));

    // The control: with offline-only off, the request is made (and cut by the guard).
    expect((await testConnection()).ok).toBe(false);
    const tried = await network.drain();
    expect(tried.some((url) => url.startsWith('https://api.anthropic.com/'))).toBe(true);

    // Offline-only on, and the connection test straight after: refused, nothing tried.
    await offlineSwitch.click();
    const tested = await testConnection();
    expect(tested).toEqual({ ok: false, message: MESSAGES.offlineOnly });
    expect(await cloudCalls(win, TINY_PROJECT_ID)).toEqual({
      send: MESSAGES.offlineOnly,
      detect: MESSAGES.offlineOnly,
      draft: MESSAGES.offlineOnly,
      test: MESSAGES.offlineOnly,
      status: 'offline-only',
    });
    // a "local" model on another machine is cloud too
    const remote = await win.evaluate(
      (baseUrl) => window.aio.invoke('ai:localModels', { baseUrl }),
      REMOTE,
    );
    expect(remote.ok).toBe(false);
    expect(remote.ok ? '' : remote.error).toContain('this workstation is offline-only');

    // Privacy and cloud: the cloud switch shows off and cannot be turned on.
    await expect(offlineSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(cloudSwitch).toBeDisabled();
    await expect(cloudSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(win.getByTestId('cloud-ai-state')).toContainText(
      'Off: this workstation is offline-only',
    );
    await expect(chip).toHaveText('Cloud AI blocked');
    await expect(chip).toHaveAttribute('title', /offline-only/);
    await shot(win, 'offline-only-privacy');

    // AI providers: the notice, and Test connection answers with the reason.
    await win.locator('.set-nav button', { hasText: 'AI providers' }).click();
    await expect(win.getByTestId('cloud-ai-offline')).toContainText(
      'This workstation is offline-only, so cloud AI is off',
    );
    await win.getByRole('button', { name: 'Test connection' }).first().click();
    await expect(win.getByTestId('test-result-anthropic')).toHaveText(MESSAGES.offlineOnly);
    await shot(win, 'offline-only-providers');

    // The assistant says why it is off, and cannot be asked.
    await win.locator('.nav-item', { hasText: 'Projects' }).click();
    await openTiny(win);
    await expect(agent(win)).toContainText(MESSAGES.offlineOnly);
    await expect(box(win)).toBeDisabled();
    await shot(win, 'offline-only-agent');
    expect(await network.outbound(), 'a request was tried under offline-only').toEqual([]);

    // Offline-only off again: cloud AI is back as it was set, and the assistant can be asked.
    await openSettings(win, 'Privacy and cloud');
    await offlineSwitch.click();
    await expect(cloudSwitch).toBeEnabled();
    await expect(cloudSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(chip).toHaveText('Cloud AI');
    await win.locator('.nav-item', { hasText: 'Scene' }).click();
    await expect(box(win)).toBeEnabled();
    await expect(agent(win)).not.toContainText('offline-only');
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
    await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('offline-only: a local model on this machine still answers, one elsewhere does not', async () => {
  const fake = await startFakeLlm({
    kind: 'ollama',
    models: [{ id: 'fake-tools', tools: true, vision: false, contextTokens: 8192 }],
  });
  const data = await createDataRoot();
  const app = await launchApp(data, { AIO_NETWORK_GUARD_ALLOW: fake.origin });
  const network = new NetworkGuard([fake.origin]);
  try {
    await network.attach(app);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const useLocal = (baseUrl: string) =>
      win.evaluate(
        ({ baseUrl: url, routes }) =>
          window.aio.invoke('settings:set', {
            offlineOnly: true,
            localModel: { enabled: true, baseUrl: url, model: 'fake-tools' },
            routes,
          }),
        { baseUrl, routes: offlineRoutes('fake-tools') },
      );
    await useLocal(`${fake.origin}/v1`);

    const status = await win.evaluate(() => window.aio.invoke('ai:status', {}));
    expect(status).toMatchObject({ ready: true, cloud: false, route: { provider: 'local' } });
    const tested = await win.evaluate(() =>
      window.aio.invoke('ai:testConnection', { provider: 'local' }),
    );
    expect(tested).toMatchObject({ ok: true, model: 'fake-tools' });
    expect(tested.message).toContain(GREETING);

    await openTiny(win);
    await expect(box(win)).toBeEnabled();
    await box(win).fill('Hello');
    await box(win).press('Enter');
    // no send preview: nothing leaves the machine
    await expect(win.getByRole('dialog')).toHaveCount(0);
    await expect(agent(win)).toContainText(GREETING);
    const allowed = await network.allowed();
    expect(allowed.length).toBeGreaterThan(0);
    for (const url of allowed) expect(url.startsWith(fake.origin)).toBe(true);

    // The same "local" model on another machine: cloud, so refused under offline-only.
    const before = fake.requests.length;
    await useLocal(REMOTE);
    const remote = await win.evaluate(() => window.aio.invoke('ai:status', {}));
    expect(remote).toMatchObject({ ready: false, reason: 'offline-only', cloud: true });
    // the panel checks its route when it opens (the setting was changed past the Settings screen)
    await win.locator('.nav-item', { hasText: 'Issues' }).click();
    await win.locator('.nav-item', { hasText: 'Scene' }).click();
    await expect(agent(win)).toContainText(MESSAGES.offlineOnly);
    await expect(box(win)).toBeDisabled();
    expect(fake.requests.length).toBe(before);
    expect(await network.outbound(), 'a request left for another machine').toEqual([]);
  } finally {
    await app.close();
    await fake.close();
    await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
