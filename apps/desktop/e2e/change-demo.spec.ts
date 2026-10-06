/**
 * The M8 harness: the change and modelling demo opens from the library as a working copy with
 * both dates and the layers truth.json lists, and the small two-date project opens with its two
 * captures. Other streams' specs start from `demoProject` / `openChangeDemo()` and assert against
 * `truth`. Off-screen, zero network; the demo tests skip when the change demo is not built.
 */
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { CHANGE_DEMO, expect, openProject, test } from './fixtures';

interface Probe {
  __stratlas: {
    workspace: {
      getState(): {
        project: {
          manifest: {
            captures: { id: string }[];
            layers: { id: string; kind: string; capture?: string }[];
          };
        } | null;
        issues: { code: string; capture?: string }[];
      };
    };
  };
}

const opened = (win: Page) =>
  win.evaluate(() => {
    const w = (window as unknown as Probe).__stratlas.workspace.getState();
    const layers = w.project?.manifest.layers ?? [];
    return {
      captures: w.project?.manifest.captures.map((c) => c.id) ?? [],
      perCapture: Object.fromEntries(
        ['d1', 'd2', 'c1', 'c2'].map((c) => [c, layers.filter((l) => l.capture === c).length]),
      ),
      layers: layers.length,
      issues: w.issues.map((i) => i.capture ?? ''),
    };
  });

test('the change demo opens as a working copy with both dates and every layer', async ({
  demoProject,
  dataRoot,
}) => {
  test.setTimeout(120_000);
  const { win, root, truth } = demoProject;
  expect(root).toBe(join(dataRoot.userData, 'demo', CHANGE_DEMO.id));
  const o = await opened(win);
  expect(o.captures).toEqual(['d1', 'd2']);
  expect(o.layers).toBe(truth.counts.layers);
  expect(o.perCapture.d1).toBe(7);
  expect(o.perCapture.d2).toBe(7);
  await expect
    .poll(async () => (await opened(win)).issues.length, { timeout: 30_000 })
    .toBe(truth.counts.issues.d1 + truth.counts.issues.d2);
  expect((await opened(win)).issues.filter((c) => c === 'd2')).toHaveLength(truth.counts.issues.d2);
  // the truth the other streams assert against is there
  expect(truth.changes.component?.verdicts).toEqual({
    added: 1,
    changed: 1,
    moved: 1,
    removed: 1,
    unchanged: 6,
  });
  expect(truth.changes.issue?.verdicts).toEqual({ grown: 1, new: 1, resolved: 1, unchanged: 3 });
});

test('the change demo videos (I_PCM H.264) decode in the app', async ({ demoProject }) => {
  const { win, truth } = demoProject;
  for (const d of ['d1', 'd2']) {
    const r = await win.evaluate(async (src) => {
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'auto';
      v.src = src;
      const ok = await new Promise<boolean>((res) => {
        v.addEventListener(
          'loadeddata',
          () => {
            res(true);
          },
          { once: true },
        );
        v.addEventListener(
          'error',
          () => {
            res(false);
          },
          { once: true },
        );
        setTimeout(() => {
          res(false);
        }, 15_000);
      });
      v.currentTime = 3;
      await new Promise((res) => {
        v.addEventListener('seeked', res, { once: true });
        setTimeout(res, 5_000);
      });
      return {
        ok,
        error: v.error?.message ?? null,
        width: v.videoWidth,
        height: v.videoHeight,
        duration: v.duration,
        at: v.currentTime,
      };
    }, `aio://project/${CHANGE_DEMO.id}/video/flight-${d}.mp4`);
    expect(r, d).toMatchObject({ ok: true, error: null, at: 3 });
    expect(r.width / r.height).toBeCloseTo(16 / 9, 1);
    expect(r.duration).toBeCloseTo(truth.counts.videoFrames / 2, 0);
  }
});

test('a two-date project opens with both captures', async ({ twoDateProject, win }) => {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E two dates' }).first().click();
  await expect
    .poll(async () => (await openProject(win)).id, { timeout: 30_000 })
    .toBe(twoDateProject.id);
  const o = await opened(win);
  expect(o.captures).toEqual(['c1', 'c2']);
  expect(o.perCapture.c1).toBe(2);
  expect(o.perCapture.c2).toBe(2);
  await expect
    .poll(async () => (await opened(win)).issues.sort(), { timeout: 30_000 })
    .toEqual(['c1', 'c2']);
});
