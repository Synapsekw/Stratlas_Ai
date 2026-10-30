/**
 * The checks after a new survey date (intelligence review I1) in the real app, on the synthetic
 * quarry demo: three monthly surveys whose surfaces are prepared quietly on open
 * (`autoPrepareSurfaces`). When that prepare job ends, each date with a date before it gets its
 * survey QA (a quiet `survey.qa` job against the previous survey) and the in-app change compute
 * for the pair, one at a time and without a click; the earliest date gets neither. The switch
 * sits under "Prepare survey surfaces" in Settings, Processing tools, on by default.
 *
 * An e2e run starts with the checks off (`--quadrion-newdatechecks=0`) so specs on multi-date
 * demos keep their state; this spec turns them on with QUADRION_E2E_NEWDATECHECKS=1. The quarry
 * is used rather than the change demo: it is the demo the surface specs already prepare on open
 * (`dates-strip.spec.ts`), with three dates in one line, so the chain runs twice. Off-screen, zero
 * network, pipeline Python needed.
 */
import type { Page } from '@playwright/test';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { openDemo } from './surveyJobs';

test.use({ appEnv: { ...PIPELINE_ENV, QUADRION_E2E_NEWDATECHECKS: '1' } });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

interface QaFile {
  capture: string;
  status: string;
  previous?: { capture: string };
}

const qaFiles = (win: Page, projectId: string) =>
  win.evaluate(async (id) => {
    const r = (await window.aio.invoke('survey:readQa', { projectId: id })) as {
      ok: boolean;
      files?: QaFile[];
    };
    return r.ok ? (r.files ?? []) : [];
  }, projectId);

const changePairs = (win: Page, projectId: string) =>
  win.evaluate(async (id) => {
    const r = (await window.aio.invoke('change:list', { projectId: id })) as {
      ok: boolean;
      sets?: { from: string; to: string }[];
    };
    return r.ok ? [...new Set((r.sets ?? []).map((s) => `${s.from}>${s.to}`))].sort() : [];
  }, projectId);

test('a new date gets its QA verdict and a change set without a click', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);

  // the switch is on by default, under the automatic surface preparation
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: 'Processing tools' }).click();
  await expect(win.getByTestId('auto-prepare')).toHaveAttribute('aria-checked', 'true');
  await expect(win.getByTestId('auto-check')).toHaveAttribute('aria-checked', 'true');
  await expect(
    win.getByRole('switch', { name: 'Check a new survey date when its surface is ready' }),
  ).toBeVisible();

  await openDemo(win, quarryProject.name, quarryProject.id);

  // the second and third surveys are checked against the one before; the first is not
  await expect
    .poll(async () => (await qaFiles(win, quarryProject.id)).map((f) => f.capture).sort(), {
      timeout: 480_000,
      intervals: [2000],
    })
    .toEqual(['m2', 'm3']);
  const files = await qaFiles(win, quarryProject.id);
  for (const f of files) expect(['pass', 'hold', 'fail', 'unchecked']).toContain(f.status);
  expect(Object.fromEntries(files.map((f) => [f.capture, f.previous?.capture]))).toEqual({
    m2: 'm1',
    m3: 'm2',
  });

  // and each new date has its "what changed" set against the date before
  await expect
    .poll(() => changePairs(win, quarryProject.id), { timeout: 120_000, intervals: [2000] })
    .toEqual(['m1>m2', 'm2>m3']);
});
