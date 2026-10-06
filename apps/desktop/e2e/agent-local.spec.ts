/**
 * The agent on the person's own local model server (M8 C7, AI-9), against the fake server in
 * fake-llm.ts on 127.0.0.1, on the change demo (C8, synthetic, no client data). Cloud AI stays
 * off, and the zero-network guard lets through only the fake's origin: any other request (a cloud
 * provider above all) fails the test. The demo opens as a working copy, so the bundled demo is
 * never written.
 *
 * - Settings: Find models lists the fake's two models with badges; Test reports tools yes, vision
 *   no; the Offline agent preset routes every task to the local model.
 * - Agent: "Fly to tank T-201" makes a malformed find_places call that the app repairs, then
 *   fly_to with the id it returned; the camera looks at the tank of truth.json; no send preview;
 *   the meter shows no cost; the status line says the agent is local.
 * - A model without tool calling answers in text, with the panel's answer-only notice and the
 *   notice in the reply, and no tool steps.
 * - Cancel during a slow reply stops at once.
 * - Local vision detection on two demo photos (one per date) gives draft proposals at no cost.
 */
import { MESSAGES } from '@aio/ai/main';
import type { ElectronApplication, Page } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DETECT_REPLY, FLOWN, GREETING, startFakeLlm, type FakeLlm } from './fake-llm';
import {
  changeDemoTruth,
  createDataRoot,
  DEMO_FOLDER,
  expect,
  hasChangeDemo,
  launchApp,
  NetworkGuard,
  openChangeDemo,
  openProject,
  test,
  type DataRoot,
} from './fixtures';

test.setTimeout(120_000);
test.skip(!hasChangeDemo(), `no change demo in ${DEMO_FOLDER}: run pnpm demo:change --quick`);

/** The tank the founder asks for (truth.json `changes.component`, a drawing part). */
const TANK = 'T-201';

interface Run {
  data: DataRoot;
  fake: FakeLlm;
  app: ElectronApplication;
  win: Page;
  network: NetworkGuard;
}

/** The app with the bundled demos, the fake's origin the only one the guard lets through. */
async function start(models: Parameters<typeof startFakeLlm>[0]['models']): Promise<Run> {
  const fake = await startFakeLlm({ kind: 'ollama', models });
  const data = await createDataRoot();
  const app = await launchApp(data, {
    AIO_NETWORK_GUARD_ALLOW: fake.origin,
    STRATLAS_DEMO: DEMO_FOLDER,
  });
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

async function offlineAgent(win: Page) {
  await card(win).getByRole('switch', { name: 'Offline agent' }).click();
  await expect(card(win).getByRole('switch', { name: 'Offline agent' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
}

async function ask(win: Page, text: string) {
  const box = agent(win).getByRole('textbox', { name: 'Message the agent' });
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press('Enter');
}

const cameraView = () =>
  (
    window as unknown as {
      __stratlas: { stage(): { saveView(): { position: number[]; target: number[] } } | null };
    }
  ).__stratlas
    .stage()
    ?.saveView() ?? null;

/** Where the tank stands in the local frame (X east, Y up, Z south): its drawing part. */
function tankCentre(): [number, number, number] {
  const parts = changeDemoTruth().modelling.drawing?.parts as {
    tag: string;
    base: [number, number, number];
    height: number;
  }[];
  const tank = parts.find((p) => p.tag === TANK);
  if (!tank) throw new Error(`truth.json has no drawing part ${TANK}`);
  return [tank.base[0], tank.base[1] + tank.height / 2, tank.base[2]];
}

/** Width and height of a baseline or progressive JPEG (its SOF segment). */
function jpegSize(buf: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < buf.length) {
    const marker = buf[i + 1] ?? 0;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2)
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error('not a JPEG with a SOF segment');
}

const MODELS = [
  { id: 'fake-tools', tools: true, vision: false, contextTokens: 8192 },
  { id: 'fake-text', tools: false, vision: false, contextTokens: 4096 },
];

test('local agent: find, test, offline preset, fly to a tank of the demo at no cost', async () => {
  const run = await start(MODELS);
  try {
    const { win, fake } = run;
    const list = await setUp(run, 'fake-tools');
    await expect(list.getByRole('button', { name: 'Use fake-tools' })).toContainText('Tools');
    await expect(list.getByRole('button', { name: 'Use fake-tools' })).toContainText('8k context');
    await expect(list.getByRole('button', { name: 'Use fake-text' })).not.toContainText('Tools');
    await expect(card(win).getByTestId('local-probe')).toContainText('Tools yes, vision no.');

    await offlineAgent(win);
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

    await openChangeDemo(win);
    await expect(agent(win)).toContainText('Agent: local (offline) · fake-tools on this machine');
    await expect.poll(() => win.evaluate(cameraView)).not.toBeNull();
    const before = await win.evaluate(cameraView);
    const sentBefore = fake.requests.length;
    await ask(win, `Fly to tank ${TANK}`);
    // No send preview: nothing leaves the machine.
    await expect(win.getByRole('dialog')).toHaveCount(0);
    await expect(agent(win)).toContainText(FLOWN);
    // The camera looks at the tank (its centre, within a metre on the ground) from elsewhere.
    const [tx, , tz] = tankCentre();
    await expect
      .poll(async () => {
        const v = await win.evaluate(cameraView);
        const [x = NaN, , z = NaN] = v?.target ?? [];
        return Math.round(Math.hypot(x - tx, z - tz) * 100) / 100;
      })
      .toBeLessThan(1);
    expect((await win.evaluate(cameraView))?.position).not.toEqual(before?.position);
    await expect(agent(win)).toContainText('$0.00');

    // find_places with the founder's words (malformed JSON, repaired), then fly_to with its id
    const chats = fake.requests.slice(sentBefore).filter((r) => r.path === '/v1/chat/completions');
    const calls = chats.flatMap((r) => (r.call ? [r.call] : []));
    expect(calls.map((c) => c.tool)).toEqual(['find_places', 'fly_to']);
    expect(calls[0]?.args).toBe(`{'query': 'tank ${TANK}',}`);
    const target = (JSON.parse(calls[1]?.args ?? '{}') as { target?: { name?: string } }).target;
    expect(target?.name).toContain(TANK);
    expect(chats.every((r) => r.tools?.includes('find_places') && r.tools.includes('fly_to'))).toBe(
      true,
    );
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
    await offlineAgent(win);

    await openChangeDemo(win);
    await expect(agent(win)).toContainText('Agent: local (offline) · fake-text on this machine');
    // the panel says why the agent cannot act, before anything is asked
    await expect(agent(win).getByTestId('agent-answer-only')).toHaveText(MESSAGES.answerOnly);
    const sentBefore = fake.requests.length;
    await ask(win, `Fly to tank ${TANK}`);
    // and the reply starts with the same in short
    await expect(agent(win)).toContainText(MESSAGES.answerOnlyNotice);
    await expect(agent(win)).toContainText(GREETING);
    const chats = fake.requests.slice(sentBefore).filter((r) => r.path === '/v1/chat/completions');
    expect(chats.length).toBeGreaterThan(0);
    expect(chats.every((r) => !r.tools && !r.call)).toBe(true);
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

test('local agent: vision detection on two demo photos gives drafts at no cost', async () => {
  const run = await start([
    { id: 'fake-vision', tools: true, vision: true, contextTokens: 8192 },
    { id: 'fake-text', tools: false, vision: false, contextTokens: 4096 },
  ]);
  try {
    const { win, fake } = run;
    await setUp(run, 'fake-vision');
    await expect(card(win).getByTestId('local-probe')).toContainText('Tools yes, vision yes.');
    await offlineAgent(win);
    const { root } = await openChangeDemo(win);
    // the working copy's id, not truth.json's: the bundled demo holds that one
    const projectId = (await openProject(win)).id ?? '';
    // the first photo of each date, as the Detect dialog sends them
    const truth = changeDemoTruth();
    const photos = await Promise.all(
      (['d1', 'd2'] as const).map(async (d) => {
        const layer = String(truth.layers[d]?.photos);
        const key = `photos/${d}/p01.jpg`;
        const buf = await readFile(join(root, key));
        return {
          key: `${layer}/p01`,
          dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
          ...jpegSize(buf),
        };
      }),
    );
    const r = await win.evaluate(
      ({ projectId, images }) =>
        window.aio.invoke('ai:detect', {
          runId: 'detect-local',
          projectId,
          classes: [{ id: 'marker', label: 'Survey marker' }],
          images,
        }),
      { projectId, images: photos },
    );
    expect(r).toMatchObject({ ok: true, provider: 'local', model: 'fake-vision', costUsd: 0 });
    if (!r.ok) throw new Error(r.error);
    expect(r.results.map((x) => x.key)).toEqual(photos.map((p) => p.key));
    expect(r.results.map((x) => x.detections.length)).toEqual(
      DETECT_REPLY.images.map((i) => i.detections.length),
    );
    expect(r.results[0]?.detections[0]).toMatchObject({ classId: 'marker' });
    expect(fake.requests.some((x) => x.path === '/v1/chat/completions' && x.image)).toBe(true);
  } finally {
    await stop(run);
  }
});
