/**
 * Shared steps of the M11 G5 specs (sections and overlays) on the synthetic survey demos: run a
 * pipeline job to the end, prepare two surveys' DSMs as height tiles, open a demo project.
 */
import type { Page } from '@playwright/test';
import { expect, openProject } from './fixtures';

interface JobLike {
  id: string;
  status: string;
  error?: string;
}

/** Start a job and wait for it to finish. */
export async function runJob(
  win: Page,
  pipeline: string,
  project: string,
  params: unknown,
): Promise<void> {
  const started = await win.evaluate(
    ([pl, root, p]) =>
      (
        window as unknown as {
          aio: {
            invoke(c: string, r: unknown): Promise<{ ok: boolean; job?: JobLike; error?: string }>;
          };
        }
      ).aio.invoke('jobs:start', { pipeline: pl, project: root, params: p }),
    [pipeline, project, params] as const,
  );
  expect(started.error ?? '').toBe('');
  const id = started.job?.id ?? '';
  await expect
    .poll(
      async () => {
        const list = (await win.evaluate(() =>
          (
            window as unknown as { aio: { invoke(c: string, r: unknown): Promise<unknown> } }
          ).aio.invoke('jobs:list', {}),
        )) as { jobs: JobLike[] };
        const job = list.jobs.find((j) => j.id === id);
        if (job?.status === 'failed') throw new Error(`${pipeline} failed: ${job.error ?? ''}`);
        return job?.status;
      },
      { timeout: 240_000, intervals: [500] },
    )
    .toBe('done');
}

/** Prepare the demo's first two surveys' DSMs as height tiles. */
export async function prepareSurveys(win: Page, root: string): Promise<void> {
  await runJob(win, 'survey.prepare', root, {
    surfaces: [
      {
        id: 'dsm-d1',
        name: 'Survey 1 DSM',
        source: { kind: 'dsm', layer: 'dsm-d1' },
        capture: 'd1',
      },
      {
        id: 'dsm-d2',
        name: 'Survey 2 DSM',
        source: { kind: 'dsm', layer: 'dsm-d2' },
        capture: 'd2',
      },
    ],
    geodesy: false,
  });
}

export async function openDemo(win: Page, name: string, id: string): Promise<void> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: name }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 60_000 }).toBe(id);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}
