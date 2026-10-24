/**
 * Detection review (BLD-5) and AI-assisted detection (BLD-6) end to end, on a temporary copy of
 * twelve EBSM flare photos with the project's own severity model and classes. The scripted test
 * model (QUADRION_AI_TEST_PROVIDER, isolated profile) answers the detection requests: no network.
 * The real project is only read, through realData.ts (@realdata). Skipped where the EBSM project
 * is not on this machine.
 *
 * Covers, on the Inspect screen: the AI-6 one-line confirm and preview before sending, results
 * landing as waiting suggestions with their confidence, dismiss and accept with the keyboard in
 * the review queue, the accepted one becoming a draft issue on disk (model, prompt version and
 * confidence in its note and the pass file), the exact error when the model answers in another
 * format, and the cloud switch blocking Ask AI.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, test } from './fixtures';
import { askAi, openInspect, openPhotoInInspect, photoTiles } from './inspect';
import {
  copyRealProjects,
  hasRealProject,
  missingRealProject,
  onlyPaths,
  realProjectDir,
  type RealDataCopy,
} from './realData';

const EBSM = realProjectDir('ebsm');
const SHOTS = process.env.QUADRION_E2E_SHOTS;
const PHOTOS = 12;

test.skip(!hasRealProject('ebsm'), missingRealProject('ebsm'));

type Copy = RealDataCopy;

type Catalogues = {
  classes: { id: string; label: string; color: string; severityModel: string }[];
}[];

function withGarbageClass(catalogues: unknown): Catalogues {
  const list = (catalogues ?? []) as Catalogues;
  const first = list[0];
  const model = first?.classes[0]?.severityModel;
  if (!first || !model) throw new Error('the EBSM copy has no class to base a test class on');
  return [
    {
      ...first,
      classes: [
        ...first.classes,
        { id: 'garbage', label: 'Garbage please', color: '#888888', severityModel: model },
      ],
    },
    ...list.slice(1),
  ];
}

/** `<tmp>/data/projects/ebsm-review/`: the first photos, the severity model and classes, no issues. */
async function copyEbsm(): Promise<Copy> {
  const manifest = JSON.parse(readFileSync(join(EBSM, 'manifest.json'), 'utf8')) as {
    id: string;
    name: string;
    layers: { kind: string; items?: { src: { path: string } }[] }[];
  };
  const photos = manifest.layers.find((l) => l.kind === 'photos');
  const items = (photos?.items ?? []).slice(0, PHOTOS);
  const copy = await copyRealProjects(['ebsm'], {
    prefix: 'aio-det-',
    rename: { ebsm: 'ebsm-review' },
    include: onlyPaths(['manifest.json', ...items.map((p) => p.src.path)]),
    manifest: (m) => ({
      ...m,
      id: 'ebsm-review',
      name: 'EBSM review copy',
      layers: photos ? [{ ...photos, items }] : [],
      // a last class whose name makes the scripted model answer in another format (a class check
      // sends the class label as its hint); the first class stays "light"
      classCatalogues: withGarbageClass(m.classCatalogues),
    }),
  });
  await writeFile(
    join(copy.projectDir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }),
  );
  return copy;
}

async function start(c: Copy) {
  const app = await launchApp(c, { QUADRION_AI_TEST_PROVIDER: '1' });
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

test('@realdata detection review: AI drafts, reject and accept with the keyboard', async () => {
  test.setTimeout(180_000);
  const c = await copyEbsm();
  let opened: ElectronApplication | null = null;
  try {
    const { app, win, network } = await start(c);
    opened = app;
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
    await win.getByTestId('project-card').filter({ hasText: 'EBSM review copy' }).click();
    await expect(win.locator('.proj-switch')).toContainText('EBSM review copy');
    await openInspect(win);

    // Nothing to review yet: the photo column shows every photo.
    await expect(photoTiles(win)).toHaveCount(PHOTOS);
    const waiting = win.getByTestId('inspect-chip-review-count');
    await expect(waiting).toHaveText('0');

    // Pick four photos and ask the model.
    for (let i = 0; i < 4; i++)
      await photoTiles(win)
        .nth(i)
        .click({ modifiers: ['ControlOrMeta'] });
    await askAi(win, 'selected');
    // AI-6: provider, cost and exactly what is sent, before anything is sent.
    await expect(win.getByTestId('cloud-confirm')).toBeVisible();
    const line = win.getByTestId('cloud-confirm-line');
    await expect(line).toContainText('Send 4 photos to Anthropic');
    await expect(line).toContainText('about $');
    await win.getByTestId('cloud-confirm-preview-open').click();
    const preview = win.getByTestId('cloud-confirm-preview');
    await expect(preview.locator('figure')).toHaveCount(4);
    await expect(preview).toContainText('These images go to Anthropic');
    await expect(preview).toContainText('Claude Opus 5.5');
    await expect(preview).toContainText('"id":"light"');
    await shot(win, 'ai-preview');

    await win.getByTestId('cloud-confirm-send').click();
    await expect(win.getByTestId('ask-ai-run')).toContainText('AI checked 4 photos and found 4.');
    await win.getByTestId('ask-ai-run-close').click();

    // The suggestions wait for review, with their confidence, in the review queue.
    await expect(waiting).toHaveText('4');
    await win.getByTestId('inspect-chip-review').click();
    await expect(photoTiles(win)).toHaveCount(4);
    await win.getByTestId('inspect-review').click();
    const queue = win.getByTestId('inspect-queue');
    await expect(queue).toBeVisible();
    await expect(win.getByTestId('det-counts')).toContainText('4 waiting');
    await expect(win.getByTestId('queue-progress')).toHaveText('1 of 4');
    await expect(queue).toContainText('90%');
    await expect(win.getByTestId('det-class')).toHaveValue('light');
    await expect(win.getByTestId('photo-viewer').locator('svg .shape.ai')).toHaveCount(1);
    expect(await win.evaluate(issueCount)).toBe(0);
    await shot(win, 'sheet-drafts');

    // Keyboard: X (D does the same) dismisses the first, A accepts the next as a draft issue.
    await win.keyboard.press('x');
    await expect(win.getByTestId('det-counts')).toContainText(
      '3 waiting · 0 accepted · 1 rejected',
    );
    // the dismissed one left the waiting queue: the next is first of three
    await expect(win.getByTestId('queue-progress')).toHaveText('1 of 3');
    await expect(queue).toContainText('80%');
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
      'Detected by claude-opus-5-5 (prompt detect-v2, confidence 80 %)',
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
      run: { model: 'claude-opus-5-5', promptVersion: 'detect-v2', images: 4 },
    });
    expect(pass?.detections[1]?.issueId).toBe(issue?.id);
    expect(pass?.detections[2]).toMatchObject({
      status: 'draft',
      space: 'source',
      geom: { type: 'box' },
    });
    expect(existsSync(join(c.projectDir, 'detections.json'))).toBe(false);

    // A model answer that is not the detection format: the exact reason, nothing added.
    await win.getByTestId('queue-leave').click();
    await win.getByTestId('inspect-chip-all').click();
    await openPhotoInInspect(win, 'p001');
    await win.getByTestId('ask-ai-checks').click();
    await win.locator('[data-testid^="ask-ai-check-"]', { hasText: 'Garbage please' }).click();
    await askAi(win, 'photo');
    await win.getByTestId('cloud-confirm-send').click();
    await expect(
      win.locator('[data-testid="ask-ai-run"], [data-testid="ask-ai-error"]').first(),
    ).toContainText(
      'Scripted test model, claude-opus-5-5: The model did not answer in the detection format: "I could not do that."',
    );
    await shot(win, 'ai-error');
    if ((await win.getByTestId('ask-ai-run-close').count()) > 0)
      await win.getByTestId('ask-ai-run-close').click();
    await expect(waiting).toHaveText('2');

    // Cloud AI off: Ask AI says so and nothing can be sent.
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: false }));
    // the bar asks what can look when Inspect opens: leave and come back
    await win.locator('.sb-nav .nav-item', { hasText: 'Issues' }).click();
    await openInspect(win);
    await expect(win.getByTestId('ask-ai-blocked')).toContainText('Cloud AI is off.');
    await expect(win.getByTestId('ask-ai')).toBeDisabled();
    await expect(win.getByTestId('cloud-confirm')).toHaveCount(0);

    await finish(app, network);
    opened = null;
  } finally {
    await opened?.close().catch(() => undefined);
    await c.dispose();
  }
});
