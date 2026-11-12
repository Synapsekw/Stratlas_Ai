/**
 * The offline agent on the Analytics pack's own model (A3), on the change demo (synthetic, no
 * client data). A stub Analytics pack (a few bytes per file, `QUADRION_ANALYTICS_PACK`) makes the
 * pack installed; the fake OpenAI-compatible server of fake-llm.ts stands in for its llama-server
 * (`QUADRION_VLM_SERVER_URL`), so no graphics card is needed. Cloud AI stays off, and the
 * zero-network guard lets through only the fake's origin.
 *
 * - Settings, Local model: "The bundled Analytics model" shows the pack's model and version; the
 *   offline agent switch stays disabled until the tool-calling check passed.
 * - Check tool calling against a fake that makes the right call for each request: it passes, the
 *   switch turns on, and a message in the agent dock runs find_places and fly_to through the
 *   bundled route.
 * - Against a fake that answers in text only: the check fails, the failure message says why and
 *   what to use instead, and the switch stays disabled.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAnalyticsPackFiles } from '../src/main/jobs/packArchive.fakes';
import { FLOWN, startFakeLlm, type FakeLlm, type FakeLlmOptions } from './fake-llm';
import {
  createDataRoot,
  DEMO_FOLDER,
  expect,
  hasChangeDemo,
  launchApp,
  NetworkGuard,
  openChangeDemo,
  test,
  type DataRoot,
} from './fixtures';

test.setTimeout(180_000);
test.skip(!hasChangeDemo(), `no change demo in ${DEMO_FOLDER}: run pnpm demo:change --quick`);

/** The stub pack's model id (`fakeAnalyticsPackFiles`), also the model the fake serves. */
const MODEL = 'fake-vl';
const TANK = 'T-201';

interface Run {
  data: DataRoot;
  fake: FakeLlm;
  app: ElectronApplication;
  win: Page;
  network: NetworkGuard;
  packBase: string;
}

/** A stub Analytics pack 0.1.0 that fits any app version and this computer. */
async function stubPack(base: string): Promise<string> {
  const dir = join(base, 'analytics-pack-0.1.0');
  const files = fakeAnalyticsPackFiles('0.1.0', {
    platform: `${process.platform}-${process.arch}`,
    appRange: '>=0.0.1',
  });
  for (const [name, body] of Object.entries(files)) {
    const parts = name.split('/');
    await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...parts), body);
  }
  return dir;
}

async function start(toolCheck: NonNullable<FakeLlmOptions['toolCheck']>): Promise<Run> {
  const fake = await startFakeLlm({
    kind: 'openai-compatible',
    models: [{ id: MODEL, tools: true, vision: true, contextTokens: 16_384 }],
    toolCheck,
  });
  const packBase = await mkdtemp(join(tmpdir(), 'aio-bundled-pack-'));
  const data = await createDataRoot();
  const app = await launchApp(data, {
    AIO_NETWORK_GUARD_ALLOW: fake.origin,
    QUADRION_DEMO: DEMO_FOLDER,
    QUADRION_ANALYTICS_PACK: await stubPack(packBase),
    QUADRION_VLM_SERVER_URL: fake.origin,
    QUADRION_VLM_MODEL: MODEL,
  });
  const network = new NetworkGuard([fake.origin]);
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // a new install starts with cloud AI on; this spec proves the offline path
  await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: false }));
  return { data, fake, app, win, network, packBase };
}

async function stop(run: Run) {
  const outbound = await run.network.outbound();
  await run.app.close();
  await run.fake.close();
  await rm(run.data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await rm(run.packBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  expect(outbound, 'the app made requests other than to the fake server').toEqual([]);
}

const card = (win: Page) => win.getByTestId('local-model');
const agent = (win: Page) => win.getByRole('region', { name: 'Ask AI chat' });
const offlineSwitch = (win: Page) =>
  card(win).getByRole('switch', { name: 'Use Offline AI for everything' });

/** Settings, AI providers, Local model: choose the bundled Analytics model. */
async function chooseBundled(win: Page) {
  await win.getByRole('button', { name: 'Settings' }).first().click();
  await win.locator('.set-nav button', { hasText: 'Local model' }).click();
  await card(win)
    .getByRole('combobox', { name: 'Model to use' })
    .selectOption({ label: 'The bundled Analytics model' });
  await expect(card(win).getByTestId('bundled-model-id')).toHaveText(
    `${MODEL}, Analytics pack 0.1.0, on this computer.`,
  );
  // not checked yet: the switch waits for a pass
  await expect(card(win).getByTestId('bundled-check')).toContainText(
    "Check the bundled model's tool calling first",
  );
  await expect(offlineSwitch(win)).toBeDisabled();
}

async function checkTools(win: Page) {
  await card(win).getByRole('button', { name: 'Check tool calling' }).click();
}

test('offline agent on the bundled model: the check passes, the agent flies to a tank', async () => {
  const run = await start('pass');
  try {
    const { win, fake } = run;
    await chooseBundled(win);
    await checkTools(win);
    await expect(card(win).getByTestId('bundled-check')).toContainText('Passed: 12 of 12 right', {
      timeout: 60_000,
    });
    const check = fake.requests.filter((r) => r.path === '/v1/chat/completions');
    expect(check).toHaveLength(12);
    expect(check.every((r) => r.model === MODEL)).toBe(true);

    await expect(offlineSwitch(win)).toBeEnabled();
    await offlineSwitch(win).click();
    await expect(offlineSwitch(win)).toHaveAttribute('aria-checked', 'true');
    const settings = await win.evaluate(() => window.aio.invoke('settings:get', {}));
    expect(settings.localModel).toMatchObject({
      enabled: true,
      source: 'bundled',
      model: MODEL,
      toolProfile: 'compact',
      contextTokens: 16_384,
      capabilities: { tools: true, vision: true },
    });
    expect(settings.bundledAgentCheck).toMatchObject({ passed: true, correct: 12, total: 12 });
    expect(settings.routes.every((r) => r.provider === 'local' && r.model === MODEL)).toBe(true);

    await openChangeDemo(win);
    await expect(agent(win)).toContainText(`Ask AI: local (offline) · ${MODEL} on this machine`);
    const sentBefore = fake.requests.length;
    const box = agent(win).getByRole('textbox', { name: 'Message the agent' });
    await expect(box).toBeEnabled();
    await box.fill(`Fly to tank ${TANK}`);
    await box.press('Enter');
    await expect(agent(win)).toContainText(FLOWN);
    // the run went to the pack's server with the compact tool list, and ran two tool steps
    const chats = fake.requests.slice(sentBefore).filter((r) => r.path === '/v1/chat/completions');
    expect(chats.map((r) => r.call?.tool).filter(Boolean)).toEqual(['find_places', 'fly_to']);
    expect(chats.every((r) => r.model === MODEL && r.tools?.includes('fly_to'))).toBe(true);
    expect(chats.every((r) => r.authorization?.startsWith('Bearer '))).toBe(true);
  } finally {
    await stop(run);
  }
});

test('offline agent on the bundled model: a model that answers in text fails the check', async () => {
  const run = await start('text-only');
  try {
    const { win } = run;
    await chooseBundled(win);
    await checkTools(win);
    const line = card(win).getByTestId('bundled-check');
    await expect(line).toContainText(
      'The bundled model made the right tool call in 1 of 12 checks (10 needed)',
      { timeout: 60_000 },
    );
    await expect(line).toContainText('Use your own local model server with tool calling');
    await expect(offlineSwitch(win)).toBeDisabled();
    await expect(offlineSwitch(win)).toHaveAttribute('aria-checked', 'false');
    // main keeps the failed check for this model and blocks the agent on it
    const status = await win.evaluate(() => window.aio.invoke('ai:bundledAgent', {}));
    expect(status.check).toMatchObject({ passed: false, correct: 1, total: 12 });
    expect(status.blocked).toContain('1 of 12 checks');
  } finally {
    await stop(run);
  }
});
