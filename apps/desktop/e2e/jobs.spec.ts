import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, launchApp, test } from './fixtures';

/**
 * The Jobs panel against the real pipeline runtime. It needs a Python with aio_pipelines: the
 * development venv (`uv sync` in python/) or STRATLAS_E2E_PYTHON. Without one, only the
 * "no pack" case runs.
 */
const repo = join(import.meta.dirname, '..', '..', '..');
const venvPython =
  process.env.STRATLAS_E2E_PYTHON ??
  (process.platform === 'win32'
    ? join(repo, 'python', '.venv', 'Scripts', 'python.exe')
    : join(repo, 'python', '.venv', 'bin', 'python'));
const hasPython = existsSync(venvPython);

test('without a pipeline pack the Jobs panel says where it looked', async ({ win, dataRoot }) => {
  await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();
  await expect(win.locator('.jobs-rt.missing')).toContainText(join(dataRoot.root, 'runtime'));
  await win.getByRole('button', { name: 'New job' }).click();
  await expect(win.getByTestId('job-start')).toBeDisabled();
});

test.describe('with the runtime', () => {
  test.skip(!hasPython, `no Python with aio_pipelines at ${venvPython}`);

  test('start, cancel, resume and finish a job from the Jobs panel', async ({
    dataRoot,
    network,
  }) => {
    test.setTimeout(120_000);
    const app = await launchApp(dataRoot, { STRATLAS_PIPELINE_PYTHON: venvPython });
    await network.attach(app);
    try {
      const win = await app.firstWindow();
      await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();
      await expect(win.locator('.jobs-rt')).toContainText('Pipeline pack dev');

      const startSelftest = async (seconds: string) => {
        await win.getByRole('button', { name: 'New job' }).click();
        await win.getByLabel('Pipeline', { exact: true }).selectOption('system.selftest');
        await win.getByLabel(/^Project folder/).fill(dataRoot.projectDir);
        await win.getByLabel('Wait (s)').fill(seconds);
        await win.getByTestId('job-start').click();
      };

      // A long job: wait for its Wait step, cancel it, resume it.
      await startSelftest('60');
      const detail = win.locator('.job-detail');
      const waitStep = detail.locator('.jd-steps li', { hasText: 'Wait' });
      await expect(waitStep).toHaveAttribute('data-state', 'running', { timeout: 60_000 });
      await expect(
        win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).locator('.count'),
      ).toHaveText('1');
      await detail.getByRole('button', { name: 'Cancel' }).click();
      await expect(detail.locator('.jd-h .job-state')).toHaveText('Cancelled', { timeout: 15_000 });
      await expect(waitStep).toHaveAttribute('data-state', 'cancelled');

      await detail.getByRole('button', { name: 'Resume' }).click();
      const libs = detail.locator('.jd-steps li', { hasText: 'Load libraries' });
      await expect(libs).toHaveAttribute('data-state', 'skipped', { timeout: 30_000 });
      await expect(libs).toContainText('kept from last run');
      await expect(waitStep).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
      await expect(detail.locator('.job-log')).toContainText('Cancelled');
      await detail.getByRole('button', { name: 'Cancel' }).click();
      await expect(detail.locator('.jd-h .job-state')).toHaveText('Cancelled', { timeout: 15_000 });

      // A short job runs to the end and leaves its log in the job folder.
      await startSelftest('0');
      await expect(detail.locator('.jd-h .job-state')).toHaveText('Done', { timeout: 60_000 });
      await expect(detail.locator('.jd-pct')).toHaveText('100%');
      const id = (await detail.locator('.jd-t .mono').textContent()) ?? '';
      const log = await readFile(join(dataRoot.projectDir, 'jobs', id, 'job.log'), 'utf8');
      expect(log).toContain('Libraries: numpy');
      expect(existsSync(join(dataRoot.projectDir, 'jobs', id, 'selftest.json'))).toBe(true);
      await expect(win.locator('.job-row')).toHaveCount(2);
      expect(await network.outbound()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
