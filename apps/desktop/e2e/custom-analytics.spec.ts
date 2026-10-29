/**
 * Custom analytics end to end, on the change demo (synthetic, no client data): Inspect, Ask AI's
 * "Custom request...", the Ask panel, the drafts it makes and what an accepted draft becomes.
 *
 * What it proves:
 * - a find request with a value to read ("Reading", a number in bar) runs on a cloud model after
 *   the cloud confirm; its two drafts are dashed and show their reading; one is fixed in Change
 *   (the reading set to 40, a class picked) and accepted, and the issue keeps the fixed value on
 *   disk and on its card;
 * - the same request runs on this PC without a confirm; the box lands where the model put it (in
 *   the 0 to 1000 frame of the local model family), thinking is off and the key is sent;
 * - Compare dates sends both photos in one request and the drafts land on the newer date's photo;
 * - Ask is a thread: an answer, a follow-up without a second confirm, and a finding made from an
 *   answer whose note is that answer;
 * - a project kept on this PC offers no cloud model, and main refuses a cloud ask for it;
 * - a saved request runs again after the project is opened again, with the same suggestions.
 *
 * Stand-ins: the cloud is the scripted test model (`QUADRION_AI_TEST_PROVIDER=1` with the
 * isolated profile, keys in the test vault): no key, no network. The model on this PC is the fake
 * server of fake-llm.ts (`QUADRION_VLM_SERVER_URL`): no Analytics pack, no graphics card. Two images
 * reaching the model are read from the `ai:ask` request main hands to it, by wrapping main's
 * handler. Never `@realdata`.
 */
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ASK_BOX_REL, startFakeLlm } from './fake-llm';
import {
  createDataRoot,
  DEMO_FOLDER,
  expect,
  hasChangeDemo,
  launchApp,
  NetworkGuard,
  openChangeDemo,
  openProject,
  reportWindow,
  test,
} from './fixtures';
import { openFindings, openInspect, findingRows } from './inspect';

test.setTimeout(180_000);
test.use({ appEnv: { QUADRION_AI_TEST_PROVIDER: '1' } });

/** The demo's two photo layers, by the heading of their section in the photo column. */
const D1 = 'Photos 2026-03-02';
const D2 = 'Photos 2026-04-13';
/** The demo's photos are 1024 x 768. */
const PHOTO = { width: 1024, height: 768 };
const PROMPT = 'find all patches';
const HAIKU = 'anthropic:claude-haiku-5-5';
const SONNET = 'anthropic:claude-sonnet-5-5';

const section = (win: Page, heading: string) =>
  win.getByTestId('inspect-photos').locator('section.m-sec').filter({ hasText: heading });
const tile = (win: Page, heading: string, photo: string) =>
  section(win, heading).locator(`[data-photo="${photo}"]`);

/** A photo of one date opened in Inspect. */
async function openPhoto(win: Page, heading: string, photo: string): Promise<void> {
  const t = tile(win, heading, photo);
  await t.scrollIntoViewIfNeeded();
  await t.click();
  await expect(
    win.locator(`[data-testid="photo-viewer"][aria-label="Photo ${photo}"]`),
  ).toBeVisible();
}

/** Settings, Privacy and cloud. */
async function openPrivacy(win: Page): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: 'Privacy and cloud' }).click();
}

/** Cloud AI on, set in Settings as a person does (a new install starts on; this says so). */
async function cloudOn(win: Page): Promise<void> {
  await openPrivacy(win);
  const cloud = win.getByRole('switch', { name: 'Allow cloud AI' });
  if ((await cloud.getAttribute('aria-checked')) !== 'true') await cloud.click();
  await expect(cloud).toHaveAttribute('aria-checked', 'true');
}

/** Ask AI's menu, "Custom request...": the Ask panel. */
async function openAskPanel(win: Page): Promise<Locator> {
  await win.getByTestId('ask-ai-checks').click();
  await win.getByTestId('ask-ai-custom').click();
  const panel = win.getByTestId('ask-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** The find request with one value to read, "Reading" in bar. */
async function writeFindRequest(panel: Locator): Promise<void> {
  await panel.getByTestId('ask-kind-find').click();
  await panel.getByTestId('ask-prompt').fill(PROMPT);
  await panel.getByTestId('field-add').click();
  await panel.getByTestId('field-label-0').fill('Reading');
  await panel.getByTestId('field-type-0').selectOption('number');
  await panel.getByTestId('field-unit-0').fill('bar');
}

/** Run, and Send in the cloud confirm. */
async function runOnCloud(win: Page, panel: Locator): Promise<void> {
  await panel.getByTestId('ask-run').click();
  const confirm = win.getByTestId('cloud-confirm');
  await expect(confirm).toBeVisible();
  await confirm.getByTestId('cloud-confirm-send').click();
  await expect(confirm).toHaveCount(0);
}

/** Close the Ask panel and show the findings of the photo in view. */
async function backToFindings(win: Page): Promise<void> {
  await win.getByTestId('ask-panel-close').click();
  await expect(win.getByTestId('ask-panel')).toHaveCount(0);
  await openFindings(win);
}

const aiRows = (win: Page) => findingRows(win).and(win.locator('[data-kind="ai"]'));

interface PassEntry {
  id: string;
  photo?: string;
  class: string;
  label?: string;
  note?: string;
  status: string;
  width?: number;
  height?: number;
  bbox: number[];
  fields?: { key: string; label: string; type: string; value: unknown; unit?: string }[];
}

/** The custom request passes on disk (`detections/ai-<run>.json`), oldest first by name. */
async function aiPasses(root: string): Promise<{ name: string; detections: PassEntry[] }[]> {
  const names = (await readdir(join(root, 'detections')))
    .filter((n) => /^ai-.*\.json$/.test(n))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      detections: (
        JSON.parse(await readFile(join(root, 'detections', name), 'utf8')) as {
          detections: PassEntry[];
        }
      ).detections,
    })),
  );
}

interface DiskIssue {
  id: string;
  classId: string;
  fields?: { key: string; value: unknown; unit?: string }[];
  sightings: { on: string; layer?: string; photo?: string }[];
}
const issuesOnDisk = async (root: string) =>
  (JSON.parse(await readFile(join(root, 'issues.json'), 'utf8')) as { issues: DiskIssue[] }).issues;

interface AskSeen {
  kind: string;
  images: number;
  backend: { kind: string; provider?: string; model?: string };
}

/**
 * Wrap main's `ai:ask` handler so the test can see what each request hands the model: its kind,
 * how many images and the backend. The original handler still answers.
 */
async function watchAsks(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    type Handler = (e: unknown, ...args: unknown[]) => unknown;
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })
      ._invokeHandlers;
    const original = handlers?.get('ai:ask');
    if (!handlers || !original) throw new Error('main has no ai:ask handler to watch');
    const seen: unknown[] = [];
    (globalThis as { __e2eAsks?: unknown[] }).__e2eAsks = seen;
    handlers.set('ai:ask', (e, ...args) => {
      const req = args[0] as { kind?: string; images?: unknown[]; backend?: unknown };
      seen.push({ kind: req.kind, images: req.images?.length ?? 0, backend: req.backend });
      return original(e, ...args);
    });
  });
}

const asksSeen = (app: ElectronApplication): Promise<AskSeen[]> =>
  app.evaluate(() => ((globalThis as { __e2eAsks?: unknown[] }).__e2eAsks ?? []) as never);

test('a find request with a reading runs in the cloud, one suggestion is fixed and accepted, and the issue keeps its values', async ({
  demoProject,
}) => {
  const { win, root } = demoProject;
  await reportWindow(win);
  await cloudOn(win);
  await openInspect(win);
  await openPhoto(win, D1, 'p01');

  const panel = await openAskPanel(win);
  await writeFindRequest(panel);
  await panel.getByTestId('ask-model-pick').selectOption(HAIKU);
  await expect(panel.getByTestId('ask-model')).toContainText('Claude Haiku 5.5');
  await runOnCloud(win, panel);

  // two dashed suggestions on the photo, each with its reading
  await expect(tile(win, D1, 'p01')).toHaveAttribute('data-ai', '2', { timeout: 60_000 });
  await expect(win.getByTestId('photo-viewer').locator('svg .shape.ai')).toHaveCount(2);
  await backToFindings(win);
  const rows = aiRows(win);
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    const list = row.getByTestId('fields-list');
    await expect(list.locator('dt')).toHaveText(['Reading']);
    await expect(list.locator('dd')).toHaveText(['42.5 bar']);
  }

  // Change on one: the reading fixed to 40, a class and a severity picked, accepted
  await rows.first().getByTestId('inspect-change').click();
  const picker = win.getByTestId('inspect-change-picker');
  await expect(picker).toBeVisible();
  await picker.getByTestId('field-reading').fill('40');
  await picker
    .getByRole('listbox', { name: 'Class' })
    .getByRole('button', { name: /Corrosion/ })
    .click();
  await picker.getByRole('group', { name: 'Severity' }).getByRole('button').first().click();
  await picker.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(aiRows(win)).toHaveCount(1);

  // the issue on disk keeps the fixed value
  let made: DiskIssue | undefined;
  await expect
    .poll(
      async () => {
        made = (await issuesOnDisk(root)).find((i) =>
          i.sightings.some((s) => s.on === 'image' && s.photo === 'p01' && s.layer === 'photos-d1'),
        );
        return made?.fields?.[0]?.value;
      },
      { timeout: 15_000 },
    )
    .toBe(40);
  expect(made?.classId).toBe('corrosion');
  expect(made?.fields?.[0]).toMatchObject({ key: 'reading', unit: 'bar' });

  // and its card shows it
  const id = made?.id ?? '';
  await win.locator('.nav-item', { hasText: 'Issues' }).first().click();
  await win.evaluate((issueId) => {
    (
      window as unknown as {
        __stratlas: {
          workspace: { getState(): { select(s: { kind: string; id: string }): void } };
        };
      }
    ).__stratlas.workspace
      .getState()
      .select({ kind: 'issue', id: issueId });
  }, id);
  const card = win.getByTestId('issue-card');
  await expect(card.getByTestId('fields-list').locator('dd')).toHaveText(['40 bar']);
});

test('the same request runs on this PC', async () => {
  test.skip(!hasChangeDemo(), `no change demo in ${DEMO_FOLDER}: run pnpm demo:change --quick`);
  const fake = await startFakeLlm({ kind: 'openai-compatible', models: [] });
  const data = await createDataRoot();
  const app = await launchApp(data, {
    QUADRION_AI_TEST_PROVIDER: '1',
    AIO_NETWORK_GUARD_ALLOW: fake.origin,
    QUADRION_VLM_SERVER_URL: fake.origin,
    QUADRION_DEMO: DEMO_FOLDER,
  });
  const network = new NetworkGuard([fake.origin]);
  try {
    await network.attach(app);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await reportWindow(win);
    const { root } = await openChangeDemo(win);
    await cloudOn(win);
    await openInspect(win);
    await openPhoto(win, D1, 'p01');

    const panel = await openAskPanel(win);
    await writeFindRequest(panel);
    await panel.getByTestId('ask-model-pick').selectOption('local');
    await expect(panel.getByTestId('ask-model')).toContainText('this PC');
    await panel.getByTestId('ask-run').click();
    // on this PC: no confirm
    await expect(win.getByTestId('cloud-confirm')).toHaveCount(0);
    await expect(tile(win, D1, 'p01')).toHaveAttribute('data-ai', '1', { timeout: 60_000 });

    // one suggestion, where the model put it in its 0 to 1000 frame, with its reading
    // the review writes its passes a moment after the drafts show
    await expect.poll(async () => (await aiPasses(root)).length, { timeout: 15_000 }).toBe(1);
    const passes = await aiPasses(root);
    const [only] = passes[0]?.detections ?? [];
    expect(passes[0]?.detections).toHaveLength(1);
    expect(only).toMatchObject({ photo: 'p01', status: 'draft', note: 'Fake item.' });
    const want = [
      ASK_BOX_REL[0] * PHOTO.width,
      ASK_BOX_REL[1] * PHOTO.height,
      ASK_BOX_REL[2] * PHOTO.width,
      ASK_BOX_REL[3] * PHOTO.height,
    ];
    want.forEach((v, i) => {
      expect(Math.abs((only?.bbox[i] ?? Number.NaN) - v)).toBeLessThanOrEqual(1);
    });
    expect(only?.fields).toEqual([
      { key: 'reading', label: 'Reading', type: 'number', value: 42.5, unit: 'bar' },
    ]);

    // the fake saw thinking off and the key, and nothing else left the PC
    const chats = fake.requests.filter((r) => r.path === '/v1/chat/completions');
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ image: true, enableThinking: false });
    expect(chats[0]?.authorization ?? '').toMatch(/^Bearer [a-f0-9]{32}$/);
    for (const url of await network.allowed()) expect(url.startsWith(fake.origin)).toBe(true);
    expect((await openProject(win)).id).not.toBeNull();
  } finally {
    const outbound = await network.outbound().catch(() => []);
    await app.close();
    await fake.close();
    await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    expect(outbound, 'the app made requests other than to the fake server').toEqual([]);
  }
});

test('comparing two dates sends both photos in one request', async ({ demoProject }) => {
  const { app, win } = demoProject;
  await reportWindow(win);
  await watchAsks(app);
  await cloudOn(win);
  await openInspect(win);
  await openPhoto(win, D1, 'p01');

  const panel = await openAskPanel(win);
  await panel.getByTestId('ask-kind-change').click();
  await panel.getByTestId('ask-prompt').fill('what changed on the tank');
  // the other survey date, from spot history
  const other = panel.getByTestId('ask-date-d2');
  await expect(other).toBeVisible({ timeout: 30_000 });
  await other.click();
  await expect(other).toHaveAttribute('aria-checked', 'true');
  await panel.getByTestId('ask-model-pick').selectOption(SONNET);
  await expect(panel.getByTestId('ask-model')).toContainText('Claude Sonnet 5.5');
  await runOnCloud(win, panel);

  // the drafts land on the newer date's photo, none on the older date's
  const newer = section(win, D2).locator('[data-ai]');
  await expect(newer).toHaveCount(1, { timeout: 60_000 });
  await expect(newer).toHaveAttribute('data-ai', '2');
  await expect(section(win, D1).locator('[data-ai]')).toHaveCount(0);

  // one request, carrying both photos, to the model picked
  const asks = await asksSeen(app);
  expect(asks).toEqual([
    {
      kind: 'change',
      images: 2,
      backend: { kind: 'cloud', provider: 'anthropic', model: 'claude-sonnet-5-5' },
    },
  ]);
});

test('ask, follow up, and make a finding from the answer', async ({ demoProject }) => {
  const { app, win } = demoProject;
  await reportWindow(win);
  await watchAsks(app);
  await cloudOn(win);
  await openInspect(win);
  await openPhoto(win, D1, 'p01');

  const panel = await openAskPanel(win);
  await panel.getByTestId('ask-kind-ask').click();
  await panel.getByTestId('thread-input').fill('Describe the condition');
  await panel.getByTestId('thread-send').click();
  // the first question confirms
  const confirm = win.getByTestId('cloud-confirm');
  await expect(confirm).toBeVisible();
  await confirm.getByTestId('cloud-confirm-send').click();

  const answers = panel.getByTestId('thread-turn-ai');
  await expect(answers).toHaveCount(1, { timeout: 60_000 });
  await expect(answers.first()).toContainText('Scripted answer:');
  await expect(answers.first()).toContainText('Draft');
  await expect(panel.getByTestId('thread-turn-user')).toHaveCount(1);
  await expect(panel.getByTestId('thread-turn-user')).toContainText('Describe the condition');

  // a follow-up: no second confirm, the second answer shows
  const follow = 'Is it worse at the base?';
  await panel.getByTestId('thread-input').fill(follow);
  await panel.getByTestId('thread-send').click();
  await expect(answers).toHaveCount(2, { timeout: 60_000 });
  await expect(confirm).toHaveCount(0);
  await expect(answers.nth(1)).toContainText(`Scripted answer: ${follow}`);
  const asks = await asksSeen(app);
  expect(asks.map((a) => [a.kind, a.images])).toEqual([
    ['ask', 1],
    ['ask', 1],
  ]);

  // Make a finding from the first answer: a suggestion whose note is the answer
  const answer = (await answers.first().locator('p').textContent()) ?? '';
  expect(answer).not.toBe('');
  await answers.first().getByTestId('thread-make-finding').click();
  await expect(answers.first().getByRole('status')).toBeVisible();
  await expect(tile(win, D1, 'p01')).toHaveAttribute('data-ai', '1');
  await backToFindings(win);
  const rows = aiRows(win);
  await expect(rows).toHaveCount(1);
  expect(await rows.getByTestId('inspect-row-note').textContent()).toBe(answer);
});

test('a project kept on this PC offers no cloud model', async ({ demoProject }) => {
  const { win, root } = demoProject;
  await reportWindow(win);
  await cloudOn(win);
  // Settings, Privacy and cloud, This project: keep its images on this PC
  const keep = win.locator('[data-testid="keep-local"] button');
  await expect(keep).toHaveAttribute('aria-checked', 'false');
  await keep.click();
  await expect(keep).toHaveAttribute('aria-checked', 'true');
  await expect
    .poll(
      async () =>
        (JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as { aiPolicy?: string })
          .aiPolicy,
    )
    .toBe('forbid');

  // back in Inspect, the cloud entries are off and the panel says why
  await openInspect(win);
  await openPhoto(win, D1, 'p01');
  const panel = await openAskPanel(win);
  await expect(panel.getByTestId('ask-note-local')).toBeVisible();
  const pick = panel.getByTestId('ask-model-pick');
  for (const value of [
    HAIKU,
    SONNET,
    'anthropic:claude-opus-5-5',
    'openai:gpt-6.1-sol',
    'openai:gpt-6-luna',
  ])
    await expect(pick.locator(`option[value="${value}"]`)).toBeDisabled();

  // main refuses a cloud ask for the project too
  // the id main knows the open project by (the working copy's, not the manifest's)
  const id = await win.evaluate(
    () =>
      (
        window as unknown as {
          __stratlas: { workspace: { getState(): { project: { id: string } | null } } };
        }
      ).__stratlas.workspace.getState().project?.id,
  );
  expect(id).toBeTruthy();
  const res = await win.evaluate(
    (projectId) =>
      window.aio.invoke('ai:ask', {
        runId: 'e2e-keep-local',
        projectId,
        backend: { kind: 'cloud', provider: 'anthropic', model: 'claude-haiku-5-5' },
        kind: 'find',
        prompt: 'find all patches',
        fields: [],
        images: [{ key: 'a', dataUrl: 'data:image/png;base64,AAAA', width: 8, height: 8 }],
      }),
    id ?? '',
  );
  expect(res).toMatchObject({ ok: false, code: 'forbidden' });
});

test('a saved request runs again with one click', async ({ demoProject }) => {
  const { win, root } = demoProject;
  await reportWindow(win);
  await watchAsks(demoProject.app);
  await cloudOn(win);
  await openInspect(win);
  await openPhoto(win, D1, 'p01');

  let panel = await openAskPanel(win);
  await writeFindRequest(panel);
  await panel.getByTestId('ask-model-pick').selectOption(HAIKU);
  await runOnCloud(win, panel);
  await expect(tile(win, D1, 'p01')).toHaveAttribute('data-ai', '2', { timeout: 60_000 });

  // Save as "Patch readings": it goes with the project
  await panel.getByTestId('ask-usecase-save').click();
  await panel.getByTestId('ask-usecase-name').fill('Patch readings');
  await panel.getByTestId('ask-usecase-name-ok').click();
  await expect(panel.getByTestId('ask-usecase-message')).toContainText('Patch readings');
  await expect
    .poll(async () => (await readdir(join(root, 'requests')).catch(() => [])).length)
    .toBe(1);

  // the first run's drafts are on disk (the review writes a moment later), so they come back
  await expect.poll(async () => (await aiPasses(root)).length, { timeout: 15_000 }).toBe(1);

  // the project opened again: pick it, Run
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await openChangeDemo(win);
  await openInspect(win);
  await openPhoto(win, D1, 'p01');
  panel = await openAskPanel(win);
  await panel.getByTestId('ask-usecase').selectOption({ label: 'Patch readings' });
  await expect(panel.getByTestId('ask-prompt')).toHaveValue(PROMPT);
  await expect(panel.getByTestId('field-label-0')).toHaveValue('Reading');
  await expect(panel.getByTestId('ask-model')).toContainText('Claude Haiku 5.5');
  await runOnCloud(win, panel);
  await expect(tile(win, D1, 'p01')).toHaveAttribute('data-ai', '4', { timeout: 60_000 });

  // the same suggestions as the first run
  await expect.poll(async () => (await aiPasses(root)).length, { timeout: 15_000 }).toBe(2);
  const passes = await aiPasses(root);
  const shape = (p: { detections: PassEntry[] }) =>
    p.detections
      .map((d) => ({ photo: d.photo, bbox: d.bbox, label: d.label, fields: d.fields }))
      .sort((a, b) => (a.bbox[0] ?? 0) - (b.bbox[0] ?? 0));
  const [first, second] = passes;
  expect(first && shape(first)).toHaveLength(2);
  expect(second && shape(second)).toEqual(first && shape(first));
  // the second run sent the saved request as it was
  expect((await asksSeen(demoProject.app)).map((a) => [a.kind, a.images, a.backend.model])).toEqual(
    [
      ['find', 1, 'claude-haiku-5-5'],
      ['find', 1, 'claude-haiku-5-5'],
    ],
  );
});
