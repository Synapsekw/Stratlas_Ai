/**
 * Survey QA in the real app (M11 G8, PRD SRV-10): on the synthetic earthworks demo, **Check against
 * points** with the demo's checkpoints shows the RMSE (Moderate passes the third survey, which is
 * planted 3 cm high with one checkpoint 15 cm off); at Strict the same survey goes on hold with a
 * banner; a person releases it with a note, which is journaled. Runs the survey pipelines on the
 * development Python (skipped without it), off-screen, with no network.
 */
import type { Page } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import {
  expect,
  hasPipelinePython,
  openProject,
  PIPELINE_ENV,
  test,
  VENV_PYTHON,
} from './fixtures';
import type { SurveyDemoProject } from './surveyFixtures';

test.use({ appEnv: PIPELINE_ENV });

interface QaFile {
  status: string;
  level: string;
  checkpoints?: { rmseM: number; count: number; points: { name: string; dz: number | null }[] };
  hold?: { reason: string };
  release?: { note: string };
}

const readQa = async (root: string, capture: string): Promise<QaFile> =>
  JSON.parse(await readFile(join(root, 'survey', 'qa', `${capture}.json`), 'utf8')) as QaFile;

async function journalText(root: string): Promise<string> {
  const dir = join(root, 'journal');
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else out.push(await readFile(join(d, e.name), 'utf8').catch(() => ''));
    }
  };
  await walk(dir);
  return out.join('\n');
}

async function open(win: Page, p: SurveyDemoProject): Promise<void> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: p.name }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 60_000 }).toBe(p.id);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

async function check(win: Page, level: 'moderate' | 'strict', status: string): Promise<void> {
  const panel = win.getByTestId('qa-panel');
  await panel.getByTestId('qa-level').selectOption(level);
  await expect(panel.getByTestId('qa-level')).toHaveValue(level);
  await panel.getByTestId('qa-run').click();
  await expect(panel.getByTestId('qa-status')).toHaveText(status, { timeout: 240_000 });
  await expect(panel.getByTestId('qa-run')).toBeEnabled({ timeout: 30_000 });
}

test('check against points shows the RMSE, Strict holds the planted survey, release with a note', async ({
  earthworksProject,
  win,
}) => {
  test.skip(!hasPipelinePython(), `no pipeline Python at ${VENV_PYTHON} (uv sync in python/)`);
  test.setTimeout(480_000);
  const root = earthworksProject.dir;
  const truth = earthworksProject.truth as {
    checkpoints: { points: { name: string; dz: Record<string, number> }[] };
  };
  await open(win, earthworksProject);

  await win.getByRole('button', { name: 'Survey QA and cleanup' }).click();
  await win.getByTestId('survey-qa-open-qa').click();
  const panel = win.getByTestId('qa-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('qa-capture').selectOption('d3');
  await panel.getByTestId('qa-csv-path').fill(join(root, 'survey', 'checkpoints.csv'));

  // Moderate (the demo's site level): RMSE shown, the survey passes
  await check(win, 'moderate', 'Passed');
  const dz = truth.checkpoints.points.map((p) => p.dz.d3 ?? 0);
  const rmse = Math.sqrt(dz.reduce((s, v) => s + v * v, 0) / dz.length);
  await expect(panel.getByTestId('qa-rmse')).toHaveText(`${(rmse * 100).toFixed(1)} cm`);
  await expect(panel.getByTestId('qa-points')).toContainText('CHK6');
  await expect(panel.getByTestId('qa-previous')).toBeVisible();
  const moderate = await readQa(root, 'd3');
  expect(moderate).toMatchObject({ status: 'pass', level: 'moderate' });
  expect(moderate.checkpoints?.count).toBe(8);
  expect(moderate.checkpoints?.rmseM).toBeCloseTo(rmse, 3);
  const chk6 = moderate.checkpoints?.points.find((p) => p.name === 'CHK6')?.dz ?? 0;
  expect(chk6).toBeCloseTo(-0.12, 2);
  await expect(win.getByTestId('qa-hold-banner')).toHaveCount(0);
  await expectAccessible(win, 'Survey QA panel', { include: '[data-testid="survey-qa-side"]' });

  // Strict: RMSE above 5 cm puts the survey on hold, with a banner
  await check(win, 'strict', 'On hold');
  const held = await readQa(root, 'd3');
  expect(held.status).toBe('hold');
  expect(held.hold?.reason).toContain('above the Strict limit of 5.0 cm');
  await expect(win.getByTestId('qa-hold-banner')).toBeVisible();
  await expect(win.getByTestId('qa-hold-banner')).toContainText('on hold');
  await expect
    .poll(async () => /"survey\.hold"[\s\S]*"action":\s*"hold"/.test(await journalText(root)), {
      timeout: 30_000,
    })
    .toBe(true);

  // a person releases it with a note
  await panel
    .getByTestId('qa-release-note')
    .fill('Checked against the GNSS log: the shift is real.');
  await panel.getByTestId('qa-release').click();
  await expect(panel.getByTestId('qa-status')).toHaveText('Released');
  await expect(panel.getByTestId('qa-released')).toContainText('the shift is real');
  await expect(win.getByTestId('qa-hold-banner')).toHaveCount(0);
  const released = await readQa(root, 'd3');
  expect(released).toMatchObject({
    status: 'released',
    release: { note: 'Checked against the GNSS log: the shift is real.' },
  });
  expect(released.hold?.reason).toBe(held.hold?.reason);
  expect(await journalText(root)).toMatch(/"action":\s*"release"/);
});

test('a cleanup around the parked excavator makes a cleaned surface; the original stays', async ({
  earthworksProject,
  win,
}) => {
  test.skip(!hasPipelinePython(), `no pipeline Python at ${VENV_PYTHON} (uv sync in python/)`);
  test.setTimeout(300_000);
  const root = earthworksProject.dir;
  await open(win, earthworksProject);

  // the survey picker: by year and month; the excavator is on the survey of 6 April 2026
  await win.getByRole('button', { name: 'Survey QA and cleanup' }).click();
  await win.getByTestId('survey-qa-open-surveys').click();
  const picker = win.getByTestId('survey-picker');
  await expect(picker).toContainText('2026');
  await expect(picker).toContainText('April');
  await picker.getByTestId('survey-pick-d2').click();
  await expect(picker.getByTestId('survey-pick-d2')).toHaveAttribute('aria-pressed', 'true');

  await win.getByRole('button', { name: 'Survey QA and cleanup' }).click();
  await win.getByTestId('survey-qa-open-cleanup').click();
  const panel = win.getByTestId('cleanup-panel');
  await panel.getByTestId('cleanup-prepare').click();
  await expect(panel.getByTestId('cleanup-surface')).toBeVisible({ timeout: 120_000 });
  const before = await readFile(join(root, 'survey', 'surfaces', 'dsm-d2', 'tiles.json'), 'utf8');
  await panel.getByTestId('cleanup-method').selectOption('thin-plate');
  await panel.getByTestId('cleanup-copy-m-excavator').click();
  await expect(panel.getByTestId('cleanup-list').locator('li')).toHaveCount(1);
  await expect(panel.getByTestId('cleanup-list')).toContainText('Parked excavator');
  await panel.getByTestId('cleanup-run').click();
  await expect(panel.getByRole('status')).toContainText('"d2-clean" is ready', {
    timeout: 120_000,
  });

  const edits = JSON.parse(await readFile(join(root, 'survey', 'cleanups.json'), 'utf8')) as {
    edits: { kind: string; surface: string; method?: string; enabled: boolean }[];
  };
  expect(edits.edits).toHaveLength(1);
  expect(edits.edits[0]).toMatchObject({
    kind: 'cleanup',
    surface: 'dsm-d2',
    method: 'thin-plate',
    enabled: true,
  });
  const clean = JSON.parse(
    await readFile(join(root, 'survey', 'surfaces', 'd2-clean', 'tiles.json'), 'utf8'),
  ) as { source: { kind: string; of: string }; capture?: string };
  expect(clean.source).toMatchObject({ kind: 'derived', of: 'dsm-d2' });
  expect(clean.capture).toBeUndefined();
  // the delivered survey's prepared surface is untouched
  expect(await readFile(join(root, 'survey', 'surfaces', 'dsm-d2', 'tiles.json'), 'utf8')).toBe(
    before,
  );
  // the cleaned surface is a helper: shown behind Show hidden
  await win.getByRole('button', { name: 'Survey QA and cleanup' }).click();
  await win.getByTestId('survey-qa-open-surveys').click();
  await picker.getByTestId('survey-show-hidden').check();
  await expect(picker.getByTestId('survey-helpers')).toContainText('(cleaned)');
});
