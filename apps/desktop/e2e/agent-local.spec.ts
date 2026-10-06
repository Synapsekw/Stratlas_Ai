/**
 * The agent on the person's own local model server (M8 C7, AI-9), against the fake server in
 * fake-llm.ts on 127.0.0.1. Cloud AI stays off, and the zero-network guard lets through only the
 * fake's origin: any other request (a cloud provider above all) fails the test.
 *
 * - Settings: Find models lists the fake's two models with badges; Test reports tools yes, vision
 *   no; the Offline agent preset routes every task to the local model.
 * - Agent: "top view" makes a malformed tool call that the app repairs; the camera moves; the
 *   meter shows no cost.
 * - A model without tool calling answers in text, with a notice, and no tool steps.
 * - Cancel during a slow reply stops at once.
 * - Local vision detection on two photos gives draft proposals at no cost.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { DETECT_REPLY, GREETING, startFakeLlm, type FakeLlm } from './fake-llm';
import { createDataRoot, expect, launchApp, NetworkGuard, test, type DataRoot } from './fixtures';

test.setTimeout(120_000);

/** An 8 x 8 px red PNG. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII=';

interface Run {
  data: DataRoot;
  fake: FakeLlm;
  app: ElectronApplication;
  win: Page;
  network: NetworkGuard;
}

async function start(models: Parameters<typeof startFakeLlm>[0]['models']): Promise<Run> {
  const fake = await startFakeLlm({ kind: 'ollama', models });
  const data = await createDataRoot();
  const app = await launchApp(data, { AIO_NETWORK_GUARD_ALLOW: fake.origin });
  const network = new NetworkGuard([fake.origin]);
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { data, fake, app, win, network };
}

async function stop(run: Run) {
  const outbound = await run.network.outbound();
  await run.app.close();
  await run.fake.close();
  await rm(run.data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  expect(outbound, 'the app made requests other than to the local server').toEqual([]);
}

const card = (win: Page) => win.getByTestId('local-model');
const agent = (win: Page) => win.getByRole('region', { name: 'Agent' });

async function openSettings(win: Page) {
  await win.getByRole('button', { name: 'Settings' }).first().click();
  await win.getByRole('button', { name: 'AI providers' }).click();
}

/** Settings, Local model: type the fake's address, Find models, choose `model`, Test. */
async function setUp(run: Run, model: string) {
  const { win } = run;
  await openSettings(win);
  const address = card(win).getByRole('textbox', { name: 'Local model address' });
  await address.fill(`${run.fake.origin}/v1`);
  await address.press('Tab');
  await card(win).getByRole('button', { name: 'Find models' }).click();
  const list = card(win).getByRole('list', { name: 'Models on the server' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await list.getByRole('button', { name: `Use ${model}` }).click();
  await expect(list.getByRole('button', { name: `Use ${model}` })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await card(win).getByRole('button', { name: 'Test' }).click();
  return list;
}

async function openTiny(win: Page) {
  await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.crumbs')).toContainText('E2E tiny project');
}

async function ask(win: Page, text: string) {
  const box = agent(win).getByRole('textbox', { name: 'Message the agent' });
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press('Enter');
}

const cameraPosition = () =>
  (
    window as unknown as {
      __stratlas: { stage(): { saveView(): { position: number[] } } | null };
    }
  ).__stratlas
    .stage()
    ?.saveView()
    .position.map((v) => Math.round(v * 100) / 100) ?? null;

const MODELS = [
  { id: 'fake-tools', tools: true, vision: false, contextTokens: 8192 },
  { id: 'fake-text', tools: false, vision: false, contextTokens: 4096 },
];

test('local agent: find, test, offline preset, a repaired tool call and no cost', async () => {
  const run = await start(MODELS);
  try {
    const { win, fake } = run;
    const list = await setUp(run, 'fake-tools');
    await expect(list.getByRole('button', { name: 'Use fake-tools' })).toContainText('Tools');
    await expect(list.getByRole('button', { name: 'Use fake-tools' })).toContainText('8k context');
    await expect(list.getByRole('button', { name: 'Use fake-text' })).not.toContainText('Tools');
    await expect(card(win).getByTestId('local-probe')).toContainText('Tools yes, vision no.');

    await card(win).getByRole('switch', { name: 'Offline agent' }).click();
    await expect(card(win).getByRole('switch', { name: 'Offline agent' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(card(win)).toContainText('Every task runs on fake-tools. Nothing leaves');
    const settings = await win.evaluate(() => window.aio.invoke('settings:get', {}));
    expect(settings.cloudAi).toBe(false);
    expect(settings.localModel).toMatchObject({
      enabled: true,
      model: 'fake-tools',
      kind: 'ollama',
      capabilities: { tools: true, vision: false },
      contextTokens: 8192,
    });
    expect(settings.routes.map((r) => `${r.task}:${r.provider}:${r.model}`)).toEqual([
      'chat:local:fake-tools',
      'vision:local:fake-tools',
      'report:local:fake-tools',
      'extract:local:fake-tools',
      'build:local:fake-tools',
    ]);

    await openTiny(win);
    await expect(agent(win)).toContainText('on this machine');
    await expect.poll(() => win.evaluate(cameraPosition)).not.toBeNull();
    const before = await win.evaluate(cameraPosition);
    await ask(win, 'Show me the top view');
    // No send preview: nothing leaves the machine.
    await expect(win.getByRole('dialog')).toHaveCount(0);
    await expect(agent(win)).toContainText('The camera is at Unit quad now.');
    await expect.poll(() => win.evaluate(cameraPosition)).not.toEqual(before);
    await expect(agent(win)).toContainText('$0.00');

    const chats = fake.requests.filter((r) => r.path === '/v1/chat/completions');
    expect(chats.some((r) => r.tools?.includes('set_view'))).toBe(true);
    expect(chats.every((r) => r.model === 'fake-tools')).toBe(true);
    expect(await run.network.allowed()).not.toHaveLength(0);
    for (const url of await run.network.allowed()) expect(url.startsWith(fake.origin)).toBe(true);
  } finally {
    await stop(run);
  }
});

test('local agent: a model without tool calling answers in text, and cancel stops at once', async () => {
  const run = await start(MODELS);
  try {
    const { win, fake } = run;
    await setUp(run, 'fake-text');
    await expect(card(win).getByTestId('local-probe')).toContainText('Tools no, vision no.');
    await expect(card(win)).toContainText('the agent will answer in text only');
    await card(win).getByRole('switch', { name: 'Offline agent' }).click();
    await expect(card(win).getByRole('switch', { name: 'Offline agent' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await openTiny(win);
    const sentBefore = fake.requests.length;
    await ask(win, 'Show me the top view');
    await expect(agent(win)).toContainText("This local model cannot use the app's tools");
    await expect(agent(win)).toContainText(GREETING);
    const chats = fake.requests.slice(sentBefore).filter((r) => r.path === '/v1/chat/completions');
    expect(chats.length).toBeGreaterThan(0);
    expect(chats.every((r) => !r.tools)).toBe(true);
    const status = await win.evaluate(() => window.aio.invoke('ai:status', {}));
    expect(status).toMatchObject({ ready: true, reason: 'answer-only', cloud: false });

    // A slow reply (a model still loading): Stop ends it at once.
    await ask(win, 'Something slow please');
    const stopButton = agent(win).getByRole('button', { name: 'Stop' });
    await expect(stopButton).toBeVisible();
    const at = Date.now();
    await stopButton.click();
    await expect(agent(win)).toContainText('Stopped.');
    expect(Date.now() - at).toBeLessThan(3000);
    await expect(agent(win).getByRole('button', { name: 'Send' })).toBeVisible();
  } finally {
    await stop(run);
  }
});

test('local agent: vision detection on two photos gives drafts at no cost', async () => {
  const run = await start([
    { id: 'fake-vision', tools: true, vision: true, contextTokens: 8192 },
    { id: 'fake-text', tools: false, vision: false, contextTokens: 4096 },
  ]);
  try {
    const { win, fake } = run;
    await setUp(run, 'fake-vision');
    await expect(card(win).getByTestId('local-probe')).toContainText('Tools yes, vision yes.');
    await card(win).getByRole('switch', { name: 'Offline agent' }).click();
    await expect(card(win).getByRole('switch', { name: 'Offline agent' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await openTiny(win);
    const r = await win.evaluate(
      (png) =>
        window.aio.invoke('ai:detect', {
          runId: 'detect-local',
          projectId: 'e2e-tiny',
          classes: [{ id: 'rust', label: 'Rust' }],
          images: [
            { key: 'photos/a.jpg', dataUrl: png, width: 8, height: 8 },
            { key: 'photos/b.jpg', dataUrl: png, width: 8, height: 8 },
          ],
        }),
      PNG,
    );
    expect(r).toMatchObject({ ok: true, provider: 'local', model: 'fake-vision', costUsd: 0 });
    if (!r.ok) throw new Error(r.error);
    expect(r.results.map((x) => x.detections.length)).toEqual(
      DETECT_REPLY.images.map((i) => i.detections.length),
    );
    expect(r.results[0]?.detections[0]).toMatchObject({ classId: 'rust' });
    expect(fake.requests.some((x) => x.path === '/v1/chat/completions' && x.image)).toBe(true);
  } finally {
    await stop(run);
  }
});
