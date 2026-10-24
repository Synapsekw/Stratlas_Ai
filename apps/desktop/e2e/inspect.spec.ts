/**
 * Inspect: one screen for the photos, the findings drawn on them and the AI's suggestions. A
 * project built here (four photos, two classes, a severity model, one finding on p4 and an AI
 * pass with three suggestions on p2 and p3) is drawn on, reviewed with the keyboard, worked
 * through in the review queue and asked about with the scripted cloud AI. The last test runs in a
 * small window, with and without the agent column.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { expect, test as base, tinyManifest, type DataRoot } from './fixtures';
import {
  askAi,
  findingRows,
  openFindings,
  openInspect,
  openPhotoInInspect,
  photoTiles,
} from './inspect';

const NOW = '2026-10-24T08:00:00Z';
const W = 400;
const H = 300;
const COLORS = { p1: '#557799', p2: '#996655', p3: '#669955', p4: '#888888' } as const;

const test = base.extend<{ dataRoot: DataRoot }>({
  dataRoot: async ({ dataRoot }, use) => {
    const dir = dataRoot.projectDir;
    await mkdir(join(dir, 'photos'), { recursive: true });
    await mkdir(join(dir, 'detections'), { recursive: true });
    for (const [id, color] of Object.entries(COLORS))
      await sharp({ create: { width: W, height: H, channels: 3, background: color } })
        .jpeg()
        .toFile(join(dir, 'photos', `${id}.jpg`));
    const manifest = tinyManifest();
    manifest.layers.push({
      kind: 'photos',
      id: 'photos',
      name: 'Photos',
      visible: true,
      items: Object.keys(COLORS).map((id) => ({ id, src: { path: `photos/${id}.jpg` } })),
    });
    manifest.severityModels = [
      {
        id: 'sev',
        name: 'Severity',
        levels: [
          { value: 1, label: 'Minor', color: '#78b3d6', criteria: 'Monitor' },
          { value: 2, label: 'Moderate', color: '#ebc751', criteria: 'Plan' },
          { value: 3, label: 'Severe', color: '#f05653', criteria: 'Act' },
        ],
      },
    ];
    manifest.classCatalogues = [
      {
        id: 'cat',
        name: 'Classes',
        assetType: 'asset',
        classes: [
          { id: 'corrosion', label: 'Corrosion', color: '#f08a3e', severityModel: 'sev' },
          { id: 'crack', label: 'Crack', color: '#e5484d', severityModel: 'sev' },
        ],
      },
    ];
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await writeFile(
      join(dir, 'issues.json'),
      JSON.stringify({
        schema: 'aio.issues/1',
        issues: [
          {
            id: 'i-p4',
            code: 'F01',
            classId: 'corrosion',
            severityModelId: 'sev',
            severity: 2,
            status: 'draft',
            title: 'Corrosion F01',
            note: '',
            author: 'E2E',
            createdAt: NOW,
            updatedAt: NOW,
            source: 'human',
            sightings: [
              {
                on: 'image',
                layer: 'photos',
                photo: 'p4',
                geom: { type: 'box', x: 20, y: 20, w: 60, h: 60 },
              },
            ],
          },
        ],
      }),
    );
    // three suggestions: a crack on p2 with no severity, a corrosion on p3, and on p3 a word the
    // project has no class for, under the queue's 50 % bar
    const det = (id: string, photo: string, cls: string, confidence: number, bbox: number[]) => ({
      id,
      photo,
      class: cls,
      confidence,
      status: 'draft',
      space: 'source',
      width: W,
      height: H,
      bbox,
    });
    await writeFile(
      join(dir, 'detections', 'ai-e2e.json'),
      JSON.stringify({
        schema: 'aio.detections/1',
        source: 'model',
        producer: 'e2e-ai',
        createdAt: NOW,
        detections: [
          det('d1', 'p2', 'crack', 0.9, [40, 40, 160, 120]),
          { ...det('d2', 'p3', 'corrosion', 0.85, [200, 100, 300, 200]), severity: 2 },
          { ...det('d3', 'p3', 'rust', 0.3, [20, 150, 100, 250]), severity: 1 },
        ],
      }),
    );
    await use(dataRoot);
  },
});

test.use({ appEnv: { QUADRION_AI_TEST_PROVIDER: '1' } });

interface DiskIssue {
  id: string;
  classId: string;
  severity: number | string;
  sightings: { on: string; photo?: string }[];
}
const issuesOnDisk = async (d: DataRoot) =>
  (JSON.parse(await readFile(join(d.projectDir, 'issues.json'), 'utf8')) as { issues: DiskIssue[] })
    .issues;

async function openProject(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('.proj-switch')).toContainText('E2E tiny project');
}

const tile = (win: Page, id: string) =>
  win.getByTestId('inspect-photos').locator(`[data-photo="${id}"]`);
const reviewCount = (win: Page) => win.getByTestId('inspect-chip-review-count');

test('the sidebar has Inspect and no Media or Detections', async ({ win }) => {
  await openProject(win);
  const nav = win.locator('.sb-nav .nav-item');
  await expect(nav.filter({ hasText: 'Inspect' })).toHaveCount(1);
  await expect(nav.filter({ hasText: /^Media$/ })).toHaveCount(0);
  await expect(nav.filter({ hasText: 'Detections' })).toHaveCount(0);
  await openInspect(win);
  await expect(photoTiles(win)).toHaveCount(4);
  // the command search goes to Inspect once, and to neither old screen
  await win.keyboard.press('Control+K');
  const palette = win.getByRole('dialog', { name: 'Command search' });
  await expect(palette).toBeVisible();
  await win.keyboard.type('Go to');
  await expect(palette.getByRole('option', { name: /^Go to Inspect/ })).toHaveCount(1);
  await expect(palette.getByRole('option', { name: /^Go to (Media|Detections)/ })).toHaveCount(0);
  await win.keyboard.press('Escape');
});

test('draw a finding in four actions', async ({ win, dataRoot }) => {
  await openProject(win);
  // 1: Inspect, 2: the photo
  await openInspect(win);
  await openPhotoInInspect(win, 'p1');
  await expect(win.getByTestId('inspect-position')).toHaveText('1 of 4');
  // J and K step through the photo column
  await win.keyboard.press('j');
  await expect(win.getByTestId('photo-viewer')).toHaveAttribute('aria-label', 'Photo p2');
  await expect(win.getByTestId('inspect-position')).toHaveText('2 of 4');
  await win.keyboard.press('k');
  await expect(win.getByTestId('photo-viewer')).toHaveAttribute('aria-label', 'Photo p1');
  // 3: B, then a box dragged on the photo
  await win.keyboard.press('b');
  const viewer = win.getByTestId('photo-viewer');
  await expect(viewer.getByRole('button', { name: 'Box', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(viewer.locator('img.ann-img').first()).toBeVisible();
  const box = await viewer.boundingBox();
  if (!box) throw new Error('no viewer');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await win.mouse.move(cx - 40, cy - 30);
  await win.mouse.down();
  await win.mouse.move(cx + 10, cy, { steps: 4 });
  await win.mouse.move(cx + 40, cy + 30, { steps: 4 });
  await win.mouse.up();
  // 4: class, severity, Create issue
  const pop = win.getByRole('dialog', { name: 'New issue' });
  await expect(pop).toBeVisible();
  await pop
    .getByRole('listbox', { name: 'Class' })
    .getByRole('button', { name: /Corrosion/ })
    .click();
  await pop.getByRole('group', { name: 'Severity' }).getByRole('button').nth(1).click();
  await pop.getByRole('button', { name: 'Create issue' }).click();

  await expect
    .poll(
      async () =>
        (await issuesOnDisk(dataRoot)).filter((i) => i.sightings.some((s) => s.photo === 'p1'))
          .length,
      {
        timeout: 15_000,
      },
    )
    .toBe(1);
  await expect(tile(win, 'p1')).toHaveAttribute('data-confirmed', '1');
  await openFindings(win);
  await expect(findingRows(win).and(win.locator('[data-kind="you"]'))).toHaveCount(1);
});

test('an AI suggestion is dashed, accepted with A using the last choice', async ({
  win,
  dataRoot,
}) => {
  // the last class and severity chosen in this project, as a drawing before would leave them
  await win.evaluate((id) => {
    localStorage.setItem(
      `quadrion.inspect.last.${id}`,
      JSON.stringify({ classId: 'crack', severity: 3 }),
    );
  }, dataRoot.projectId);
  await openProject(win);
  await openInspect(win);
  await expect(tile(win, 'p2')).toHaveAttribute('data-ai', '1');
  await expect(tile(win, 'p2').locator('.insp-b.ai')).toBeVisible();
  await openPhotoInInspect(win, 'p2');
  const viewer = win.getByTestId('photo-viewer');
  await expect(viewer.locator('svg .shape.ai')).toHaveCount(1);
  await expect(viewer.getByTestId('inspect-inline')).toContainText('90%');

  await openFindings(win);
  const ai = findingRows(win).and(win.locator('[data-kind="ai"]'));
  await expect(ai).toHaveCount(1);
  await ai.locator('.inspect-row-head').click();
  await expect(ai).toHaveAttribute('data-selected', 'true');
  await win.keyboard.press('a');

  const you = findingRows(win).and(win.locator('[data-kind="you"]'));
  await expect(you).toHaveCount(1);
  await expect(ai).toHaveCount(0);
  await expect(viewer.locator('svg .shape.ai')).toHaveCount(0);
  await expect.poll(async () => (await issuesOnDisk(dataRoot)).length, { timeout: 15_000 }).toBe(2);
  const made = (await issuesOnDisk(dataRoot)).find((i) => i.id !== 'i-p4');
  // the crack the AI named, with the severity last chosen
  expect(made).toMatchObject({ classId: 'crack', severity: 3 });
  await expect(tile(win, 'p2')).toHaveAttribute('data-confirmed', '1');
});

test('dismiss with D and the To review chip counts down', async ({ win, dataRoot }) => {
  await openProject(win);
  await openInspect(win);
  await expect(reviewCount(win)).toHaveText('2');
  await openPhotoInInspect(win, 'p2');
  await openFindings(win);
  const ai = findingRows(win).and(win.locator('[data-kind="ai"]'));
  await ai.locator('.inspect-row-head').click();
  await win.keyboard.press('d');
  await expect(ai).toHaveCount(0);
  await expect(reviewCount(win)).toHaveText('1');
  await expect(tile(win, 'p2')).not.toHaveAttribute('data-ai', /.+/);
  // a dismissal makes no finding
  expect(await issuesOnDisk(dataRoot)).toHaveLength(1);
});

test('the review queue: progress, slider, Accept all above, Esc', async ({ win, dataRoot }) => {
  await openProject(win);
  await openInspect(win);
  await win.getByTestId('inspect-chip-review').click();
  await expect(photoTiles(win)).toHaveCount(2);
  await win.getByTestId('inspect-review').click();
  const queue = win.getByTestId('inspect-queue');
  await expect(queue).toBeVisible();

  // the 0.3 suggestion goes under a 50 % bar
  await win.getByTestId('queue-threshold').fill('0.5');
  await expect(win.getByTestId('queue-progress')).toHaveText('1 of 2');
  // the viewer follows the queue: the current suggestion's photo is open
  await expect(win.getByTestId('photo-viewer')).toHaveAttribute('aria-label', 'Photo p2');
  // J steps to the corrosion on p3
  await win.keyboard.press('j');
  await expect(win.getByTestId('queue-progress')).toHaveText('2 of 2');
  await expect(win.getByTestId('photo-viewer')).toHaveAttribute('aria-label', 'Photo p3');
  await expect(win.getByTestId('det-class')).toHaveValue('corrosion');

  await win.getByTestId('queue-threshold').fill('0.8');
  const all = win.getByTestId('det-accept-all');
  await expect(all).toHaveText('Accept all Corrosion above 80% (1)');
  await all.click();
  await win.getByTestId('det-batch-ok').click();
  await expect.poll(async () => (await issuesOnDisk(dataRoot)).length, { timeout: 15_000 }).toBe(2);
  await expect(win.getByTestId('queue-progress')).toHaveText('1 of 1');

  await win.getByTestId('queue-progress').click();
  await win.keyboard.press('Escape');
  await expect(queue).toHaveCount(0);
  await expect(
    win.getByTestId('inspect-findings').locator('.inspect-findings-panel'),
  ).toBeVisible();
});

test('Ask AI on this photo asks before sending to the cloud', async ({ win }) => {
  await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
  await openProject(win);
  await openInspect(win);
  await openPhotoInInspect(win, 'p1');
  await expect(win.getByTestId('ask-ai')).toBeEnabled();
  await askAi(win, 'photo');
  const line = win.getByTestId('cloud-confirm-line');
  await expect(line).toContainText('Send 1 photo to');
  await expect(line).toContainText('about');
  // nothing has gone yet
  await expect(win.getByTestId('ask-ai-run')).toHaveCount(0);
  await win.getByTestId('cloud-confirm-send').click();
  const run = win.getByTestId('ask-ai-run');
  await expect(run).toBeVisible();
  await expect(run).toContainText('AI checked 1 photo', { timeout: 30_000 });
  await expect(tile(win, 'p1')).toHaveAttribute('data-ai', '1');
  await expect(win.getByTestId('photo-viewer').locator('svg .shape.ai')).toHaveCount(1);
});

test.describe('small window', () => {
  test.use({ appEnv: { QUADRION_AI_TEST_PROVIDER: '1', QUADRION_WINDOW_SIZE: '1100x700' } });

  /** The findings reach (as a column, or through the drawer), and the viewer's centre is the photo's. */
  async function check(win: Page) {
    const toggle = win.getByTestId('inspect-panel-toggle');
    if (await toggle.isVisible()) {
      await expect(win.getByTestId('inspect-findings')).toHaveCount(0);
      await toggle.click();
      await expect(
        win.getByTestId('inspect-findings').locator('.inspect-findings-panel'),
      ).toBeVisible();
      await toggle.click();
      await expect(win.getByTestId('inspect-findings')).toHaveCount(0);
    } else {
      await expect(
        win.getByTestId('inspect-findings').locator('.inspect-findings-panel'),
      ).toBeVisible();
    }
    const hit = await win.getByTestId('photo-viewer').evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return at !== null && el.contains(at);
    });
    expect(hit).toBe(true);
  }

  test('small window', async ({ win }) => {
    await openProject(win);
    await openInspect(win);
    await openPhotoInInspect(win, 'p2');
    await check(win);
    // the agent column takes the right edge: the findings become a drawer
    await win.getByTestId('agent-toggle').click();
    await expect(win.locator('#agent-dock')).toBeVisible();
    await expect(win.getByTestId('inspect-panel-toggle')).toBeVisible();
    await check(win);
    // the photo column still brings the open tile into view
    await openPhotoInInspect(win, 'p4');
    await expect(tile(win, 'p4')).toBeInViewport();
  });
});
