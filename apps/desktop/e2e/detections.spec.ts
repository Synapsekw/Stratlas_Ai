/**
 * Detection review (BLD-5) and AI-assisted detection (BLD-6) end to end, on a temporary copy of
 * twelve EBSM flare photos with the project's own severity model and classes. The scripted test
 * model (STRATLAS_AI_TEST_PROVIDER, isolated profile) answers the detection requests: no network.
 * The real project is only read. Skipped where the EBSM project is not on this machine.
 *
 * Covers: the AI-6 preview and estimate before sending, results landing as waiting detections with
 * model, prompt version and confidence, reject and accept with the keyboard, the accepted one
 * becoming a draft issue on disk, the exact error when the model answers in another format, and
 * the cloud switch blocking the send.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, test } from './fixtures';

const DATA = process.env.STRATLAS_EBSM_DATA ?? 'E:/Stratlas Data';
const EBSM = join(DATA, 'projects', 'ebsm');
const SHOTS = process.env.STRATLAS_E2E_SHOTS;
const PHOTOS = 12;

test.skip(!existsSync(join(EBSM, 'manifest.json')), `EBSM project not found at ${EBSM}`);

interface Copy {
  base: string;
  root: string;
  userData: string;
  projectDir: string;
}

/** `<tmp>/data/projects/ebsm-review/`: the first photos, the severity model and classes, no issues. */
async function copyEbsm(): Promise<Copy> {
  const base = await mkdtemp(join(tmpdir(), 'aio-det-'));
  const root = join(base, 'data');
  const userData = join(base, 'user');
  const projectDir = join(root, 'projects', 'ebsm-review');
  await mkdir(join(projectDir, 'photos'), { recursive: true });
  await mkdir(join(root, 'packs'), { recursive: true });
  await mkdir(userData, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(EBSM, 'manifest.json'), 'utf8')) as {
    id: string;
    name: string;
    layers: { kind: string; items?: { src: { path: string } }[] }[];
  };
  const photos = manifest.layers.find((l) => l.kind === 'photos');
  const items = (photos?.items ?? []).slice(0, PHOTOS);
  for (const p of items) {
    await copyFile(join(EBSM, p.src.path), join(projectDir, p.src.path));
  }
  const copy = {
    ...manifest,
    id: 'ebsm-review',
    name: 'EBSM review copy',
    layers: photos ? [{ ...photos, items }] : [],
  };
  await writeFile(join(projectDir, 'manifest.json'), JSON.stringify(copy, null, 2));
  await writeFile(
    join(projectDir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }),
  );
  return { base, root, userData, projectDir };
}

async function start(c: Copy) {
  const app = await launchApp(
    {
      base: c.base,
      root: c.root,
      userData: c.userData,
      projectId: 'ebsm-review',
      projectDir: c.projectDir,
    },
    { STRATLAS_AI_TEST_PROVIDER: '1' },
  );
  const network = new NetworkGuard();
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 960);
  });
  return { app, win, network };
}

async function shot(win: Page, name: string) {
  const dir =
    SHOTS ??
    'C:/Users/D/AppData/Local/Temp/claude/E--Dev-AIO-Software/1c3c72a7-fa9f-4226-ad0e-d8d48b6324d9/scratchpad';
  if (existsSync(dir)) await win.screenshot({ path: join(dir, `review-${name}.png`) });
}

async function finish(app: ElectronApplication, network: NetworkGuard) {
  const outbound = await network.outbound();
  await app.close();
  expect(outbound, 'the app made network requests').toEqual([]);
}

const issueCount = () =>
  (
    window as unknown as {
      __stratlas: { workspace: { getState(): { issues: unknown[] } } };
    }
  ).__stratlas.workspace.getState().issues.length;

test('detection review: AI drafts, reject and accept with the keyboard', async () => {
  test.setTimeout(180_000);
  const c = await copyEbsm();
  let opened: ElectronApplication | null = null;
  try {
    const { app, win, network } = await start(c);
    opened = app;
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
    await win.getByTestId('project-card').filter({ hasText: 'EBSM review copy' }).click();
    await expect(win.locator('.crumbs')).toContainText('EBSM review copy');
    await win.locator('.nav-item', { hasText: 'Detections' }).click();

    // Nothing to review yet: the sheet shows every photo.
    const sheet = win.getByTestId('det-sheet');
    await expect(sheet.locator('.det-tile')).toHaveCount(PHOTOS);
    await expect(win.getByTestId('det-counts')).toContainText('0 waiting');

    // Pick four photos and ask the model.
    const tiles = sheet.locator('.det-tile');
    for (let i = 0; i < 4; i++) await tiles.nth(i).click({ modifiers: ['Control'] });
    await win.getByTestId('det-ai-open').click();
    const dialog = win.getByTestId('det-ai-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('The 4 selected photos');
    // AI-6: route, estimate and exactly what is sent, before anything is sent.
    await expect(dialog).toContainText('Anthropic · Claude Opus 5.5');
    await expect(win.getByTestId('det-ai-estimate')).toContainText('4 images in one request');
    await expect(win.getByTestId('det-ai-estimate')).toContainText('about $');
    const preview = win.getByTestId('det-ai-preview');
    await expect(preview.locator('figure')).toHaveCount(4);
    await expect(preview).toContainText('These images go to Anthropic');
    await preview.getByText('Instructions and request text').click();
    await expect(preview).toContainText('"id":"light"');
    await shot(win, 'ai-preview');

    await win.getByTestId('det-ai-send').click();
    const progress = win.getByTestId('det-ai-progress');
    await expect(progress).toContainText('Done');
    await expect(progress).toContainText('4 of 4 images sent, 4 proposals');
    await win.getByTestId('det-ai-close').click();

    // The proposals wait for review, with model, prompt version and confidence.
    await expect(win.getByTestId('det-counts')).toContainText('4 waiting');
    await expect(sheet.locator('.det-tile')).toHaveCount(4);
    const inspector = win.getByTestId('det-inspector');
    await expect(inspector).toContainText('Proposed by claude-opus-5-5, prompt detect-v1.');
    await expect(inspector).toContainText('Confidence 90%');
    await expect(win.getByTestId('det-class')).toHaveValue('light');
    await expect(win.getByTestId('det-editor').locator('svg .shape')).toHaveCount(1);
    expect(await win.evaluate(issueCount)).toBe(0);
    await shot(win, 'sheet-drafts');

    // Keyboard: X rejects the first, A accepts the next as a draft issue.
    await sheet.locator('.det-tile').first().click();
    await win.keyboard.press('x');
    await expect(win.getByTestId('det-counts')).toContainText(
      '3 waiting · 0 accepted · 1 rejected',
    );
    // the rejected one left the waiting queue: the next is first of three
    await expect(inspector).toContainText('1 of 3');
    await win.keyboard.press('3');
    await win.keyboard.press('a');
    await expect(win.getByTestId('det-counts')).toContainText(
      '2 waiting · 1 accepted · 1 rejected',
    );
    await expect.poll(() => win.evaluate(issueCount)).toBe(1);
    await shot(win, 'accepted');

    // Both files on disk: the issue (agent source, photo sighting) and the review.
    await expect
      .poll(async () => {
        const text = await readFile(join(c.projectDir, 'issues.json'), 'utf8');
        return (JSON.parse(text) as { issues: unknown[] }).issues.length;
      })
      .toBe(1);
    const issues = JSON.parse(await readFile(join(c.projectDir, 'issues.json'), 'utf8')) as {
      issues: {
        id: string;
        classId: string;
        severity: number;
        status: string;
        source: string;
        note: string;
        sightings: { on: string; photo?: string }[];
      }[];
    };
    const issue = issues.issues[0];
    expect(issue).toMatchObject({
      classId: 'light',
      severity: 3,
      status: 'draft',
      source: 'agent',
    });
    expect(issue?.sightings[0]).toMatchObject({ on: 'image', photo: 'p002' });
    expect(issue?.note).toContain(
      'Detected by claude-opus-5-5 (prompt detect-v1, confidence 80 %)',
    );
    // The AI run is one pass file, aio.detections/1, beside any other passes.
    const passFile = async () => {
      const names = (
        await readdir(join(c.projectDir, 'detections')).catch(() => [] as string[])
      ).filter((n) => /^ai-.+\.json$/.test(n));
      if (names.length !== 1 || !names[0]) return null;
      return JSON.parse(await readFile(join(c.projectDir, 'detections', names[0]), 'utf8')) as {
        schema: string;
        source: string;
        assessed?: string[];
        run?: { model?: string; promptVersion?: string; images?: number };
        detections: {
          status: string;
          issueId?: string;
          space?: string;
          geom?: unknown;
          bbox: number[];
        }[];
      };
    };
    await expect
      .poll(async () => (await passFile())?.detections.map((d) => d.status).join(','))
      .toBe('rejected,accepted,draft,draft');
    const pass = await passFile();
    expect(pass).toMatchObject({
      schema: 'aio.detections/1',
      source: 'ai',
      assessed: ['p001', 'p002', 'p003', 'p004'],
      run: { model: 'claude-opus-5-5', promptVersion: 'detect-v1', images: 4 },
    });
    expect(pass?.detections[1]?.issueId).toBe(issue?.id);
    expect(pass?.detections[2]).toMatchObject({
      status: 'draft',
      space: 'source',
      geom: { type: 'box' },
    });
    expect(existsSync(join(c.projectDir, 'detections.json'))).toBe(false);

    // A model answer that is not the detection format: the exact reason, nothing added.
    await win.getByTestId('det-ai-open').click();
    await dialog.getByLabel('The photo or frame in the editor').check();
    await dialog.getByPlaceholder(/What to look for/).fill('garbage please');
    await win.getByTestId('det-ai-send').click();
    await expect(win.getByTestId('det-ai-error')).toContainText(
      'Scripted test model, claude-opus-5-5: The model did not answer in the detection format: "I could not do that."',
    );
    await shot(win, 'ai-error');
    await win.getByTestId('det-ai-close').click();
    await expect(win.getByTestId('det-counts')).toContainText(
      '2 waiting · 1 accepted · 1 rejected',
    );

    // Cloud AI off: the dialog says so and nothing can be sent.
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: false }));
    await win.getByTestId('det-ai-open').click();
    await expect(win.getByTestId('det-ai-blocked')).toContainText('Cloud AI is off.');
    await expect(win.getByTestId('det-ai-send')).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    await finish(app, network);
    opened = null;
  } finally {
    await opened?.close().catch(() => undefined);
    await rm(c.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
