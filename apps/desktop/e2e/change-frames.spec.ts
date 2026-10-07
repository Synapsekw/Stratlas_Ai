/**
 * Same view on the other date (M8 C4) on the change demo (C8, synthetic): the Frames pane in the
 * split pairs the frame of the playing clip, or a photo, with the closest view of the other survey
 * date by camera pose (the pairs of `truth.json`, one frame either way at the clips' 2 fps),
 * follows the clock, and compares side by side, by swipe and by blend. "Find changes in matched
 * frames" runs `change.frames` on the photo pairs (needs the development pipeline Python).
 */
import type { Page } from '@playwright/test';
import { expectAccessible } from './a11y';
import {
  expect,
  hasPipelinePython,
  PIPELINE_ENV,
  test,
  VENV_PYTHON,
  type ChangeDemoTruth,
} from './fixtures';

test.use({ appEnv: PIPELINE_ENV });

interface Hook {
  aio: { invoke(channel: string, req: unknown): Promise<unknown> };
  __stratlas: {
    workspace: {
      getState(): {
        project: {
          id: string;
          manifest: {
            layers: { id: string; offsetMs?: number; flight?: { startUtcMs: number } }[];
          };
        } | null;
        setActiveClip(id: string | null): void;
        setTime(t: number): void;
        pause(): void;
      };
    };
  };
}

interface Pair {
  a: { layer: string; t?: number; photo?: string };
  b: { layer: string; t?: number; photo?: string };
  poseM: number;
  angleDeg: number;
}

const pairs = (truth: ChangeDemoTruth, kind: 'video' | 'photos') =>
  (truth.changes.frame as unknown as Record<string, { pairs: Pair[] }>)[kind]?.pairs ?? [];

/** Pause and put the clock at `t` seconds of `clip`. */
async function clock(win: Page, clip: string, t: number) {
  await win.evaluate(
    ({ clip, t }) => {
      const ws = (window as unknown as Hook).__stratlas.workspace.getState();
      const layer = ws.project?.manifest.layers.find((l) => l.id === clip);
      const start = (layer?.flight?.startUtcMs ?? 0) + (layer?.offsetMs ?? 0);
      ws.pause();
      ws.setActiveClip(clip);
      ws.setTime(start + t * 1000);
    },
    { clip, t },
  );
}

/** "1.1 m, 1 degrees apart" to its numbers. */
async function apart(score: ReturnType<Page['getByTestId']>) {
  const m = /^([\d.]+) m, (\d+) degrees? apart$/.exec((await score.textContent()) ?? '');
  return m ? { m: Number(m[1]), deg: Number(m[2]) } : null;
}

/** Draft detections of the frames runs (pass files `change-frames-<run>.json`). */
async function frameDrafts(win: Page) {
  return win.evaluate(async () => {
    const w = window as unknown as Hook;
    // the session's id of the open working copy (not the demo's manifest id)
    const projectId = w.__stratlas.workspace.getState().project?.id;
    const r = (await w.aio.invoke('detections:read', { projectId })) as {
      files?: {
        name: string;
        file: { detections: { class: string; status?: string; photo?: string }[] };
      }[];
    };
    return (r.files ?? [])
      .filter((f) => f.name.startsWith('change-frames-'))
      .flatMap((f) => f.file.detections);
  });
}

test('the Frames pane shows the same view of the other date and follows the clock', async ({
  demoProject,
}) => {
  test.setTimeout(120_000);
  const { win, truth } = demoProject;
  const video = pairs(truth, 'video');
  const at = (t: number) => video.find((p) => p.a.t === t);
  const first = at(4.5);
  const later = at(12);
  if (!first || !later) throw new Error('truth.json has no video pairs at 4.5 s and 12 s');
  await clock(win, first.a.layer, 4.5);

  await win.keyboard.press('3');
  const right = win.getByTestId('pane-chooser-right').locator('select').first();
  await expect(right.locator('option[value="frames"]')).toHaveCount(1);
  await right.selectOption('frames');
  const pane = win.getByTestId('frames-pane');
  await expect(pane).toBeVisible();

  // the matching frame of the later date, one frame either way, with the distance and angle
  const score = win.getByTestId('frames-score');
  await expect(score).toHaveAttribute('data-layer', first.b.layer);
  await expect
    .poll(async () => Math.abs(Number(await score.getAttribute('data-t')) - (first.b.t ?? 0)))
    .toBeLessThanOrEqual(0.5 + 1e-6);
  const shown = await apart(score);
  expect(shown?.m).toBeCloseTo(first.poseM, 0);
  expect(Math.abs((shown?.deg ?? 99) - first.angleDeg)).toBeLessThanOrEqual(1);
  await expect(pane.getByTestId('frames-compare')).toHaveAttribute('data-mode', 'side');
  await expect(pane.getByText('2 Mar 2026').first()).toBeVisible();
  await expect(pane.getByText('13 Apr 2026').first()).toBeVisible();

  // scrub the earlier date: the later one follows
  await clock(win, later.a.layer, 12);
  await expect
    .poll(async () => Math.abs(Number(await score.getAttribute('data-t')) - (later.b.t ?? 0)))
    .toBeLessThanOrEqual(0.5 + 1e-6);

  // swipe: a handle the keyboard and the pointer move
  await pane.getByTestId('frames-mode-swipe').click();
  const handle = pane.getByTestId('frames-swipe');
  await expect(handle).toHaveAttribute('aria-valuenow', '50');
  await handle.focus();
  await win.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '55');
  const box = await pane.getByTestId('frames-stack').boundingBox();
  if (!box) throw new Error('no frame stack');
  await win.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
  await expect
    .poll(async () => Number(await handle.getAttribute('aria-valuenow')))
    .toBeLessThanOrEqual(27);
  await expect
    .poll(async () => Number(await handle.getAttribute('aria-valuenow')))
    .toBeGreaterThanOrEqual(23);
  // lined up by the ground: the later frame is drawn through the homography
  await pane.getByTestId('frames-warp').click();
  await expect(pane.getByTestId('frames-stack')).toHaveAttribute('data-warped', '');
});

test('a photo opens the same view of the other date, and blends', async ({ demoProject }) => {
  test.setTimeout(120_000);
  const { win, truth } = demoProject;
  const photos = pairs(truth, 'photos');
  const [p1, p2] = photos;
  if (!p1 || !p2) throw new Error('truth.json has fewer than two photo pairs');
  // projects open on their latest survey date (timeline T1): step back to the earlier one first
  const dateBar = win.getByTestId('date-bar-open');
  const latest = (await dateBar.textContent()) ?? '';
  await win.keyboard.press('Alt+ArrowLeft');
  await expect(dateBar).not.toHaveText(latest);
  // the photo pane on the left, then "Same view on the other date"
  await win.keyboard.press('3');
  await win.getByTestId('pane-chooser-left').locator('select').first().selectOption('photo');
  await win.getByTestId('pane-photo').getByTestId('same-view').click();
  const pane = win.getByTestId('frames-pane');
  await expect(pane).toBeVisible();
  const score = pane.getByTestId('frames-score');
  // the photo pane shows the earlier date's first photo: its pair of the later date
  await expect(score).toHaveAttribute('data-photo', p1.b.photo ?? '');
  await expect(score).toHaveAttribute('data-layer', p1.b.layer);
  const shown = await apart(score);
  expect(shown?.m).toBeCloseTo(p1.poseM, 0);
  expect(Math.abs((shown?.deg ?? 99) - p1.angleDeg)).toBeLessThanOrEqual(1);
  await expect(pane.locator('img[data-state="ready"]')).toHaveCount(2);
  await expectAccessible(win, 'Frames pane', { include: '[data-testid="frames-pane"]' });

  // stepping through the earlier photos keeps the pairing
  await pane.getByRole('button', { name: 'Next photo' }).click();
  await expect(score).toHaveAttribute('data-photo', p2.b.photo ?? '');

  // blend halfway: the later photo over the earlier one
  await pane.getByTestId('frames-mode-blend').click();
  await pane.getByTestId('frames-blend').fill('50');
  await expect(pane.getByTestId('frames-b')).toHaveCSS('opacity', '0.5');
});

test('Find changes in matched frames: one frame change per photo pair, drafts on the later photos', async ({
  demoProject,
}) => {
  test.skip(!hasPipelinePython(), `no pipeline Python at ${VENV_PYTHON} (uv sync in python/)`);
  test.setTimeout(240_000);
  const { win, truth } = demoProject;
  const photos = pairs(truth, 'photos');
  await win.getByTestId('tab-changes').click();
  const panel = win.getByTestId('change-panel');
  await expect(panel).toBeVisible();
  const run = panel.getByTestId('change-producer-frames');
  await expect(run).toBeEnabled();
  await run.click();
  // the job runs in the pipeline pack; its change set joins the register when it finishes
  await expect(panel.locator('[data-testid="change-row"][data-kind="frame"]')).toHaveCount(
    photos.length,
    { timeout: 180_000 },
  );
  const verdicts = await panel
    .locator('[data-testid="change-row"][data-kind="frame"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-verdict')));
  // the shelter, the container and the skid changed between the dates: some pairs changed
  const changed = verdicts.filter((v) => v === 'changed').length;
  expect(changed).toBeGreaterThan(0);
  expect(verdicts.every((v) => v === 'changed' || v === 'unchanged')).toBe(true);

  // the changed regions are draft detections of class "change" on the later date's photos
  const later = new Set(photos.map((p) => p.b.photo));
  await expect.poll(async () => (await frameDrafts(win)).length).toBeGreaterThanOrEqual(changed);
  for (const d of await frameDrafts(win)) {
    expect(d).toMatchObject({ class: 'change', status: 'draft' });
    expect(later.has(d.photo)).toBe(true);
  }
});
