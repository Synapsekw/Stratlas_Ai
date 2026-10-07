import { PIPELINES } from '@aio/schema';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmdirSync, symlinkSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
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
/** PDAL for the point cloud conversion: AIO_PDAL, or the development install. */
const pdal =
  process.env.AIO_PDAL ??
  (process.platform === 'win32' ? 'E:/Dev/tools/pdal/Library/bin/pdal.exe' : '/usr/bin/pdal');
const hasPdal = existsSync(pdal);

/** A synthetic 400-point LAZ near the tiny project's origin (UTM 39N), written by PDAL. */
async function smallLaz(dir: string): Promise<string> {
  const rows = ['X,Y,Z,Intensity'];
  for (let i = 0; i < 400; i++)
    rows.push(
      `${String(500000 + (i % 20))},${String(3200000 + Math.floor(i / 20))},${String(i % 9)},${String(i % 200)}`,
    );
  const txt = join(dir, 'scan.txt');
  const laz = join(dir, 'Site Scan.laz');
  await writeFile(txt, `${rows.join('\n')}\n`);
  const pipe = join(dir, 'make-laz.json');
  await writeFile(
    pipe,
    JSON.stringify({
      pipeline: [
        { type: 'readers.text', filename: txt },
        { type: 'writers.las', filename: laz, compression: 'laszip', a_srs: 'EPSG:32639' },
      ],
    }),
  );
  execFileSync(pdal, ['pipeline', pipe]);
  return laz;
}

test('without a pipeline pack the Jobs panel says where it looked', async ({ win, dataRoot }) => {
  await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();
  await expect(win.locator('.jobs-rt.missing')).toContainText(join(dataRoot.root, 'runtime'));
  await win.getByRole('button', { name: 'New job' }).click();
  await expect(win.getByTestId('job-start')).toBeDisabled();
});

/**
 * An installed runtime folder (`<data folder>/runtime`, e.g. the real data root's), only read:
 * the app must pick its newest pack, list every pipeline of the schema in it and pass the selftest.
 */
const RUNTIME = process.env.STRATLAS_E2E_RUNTIME ?? '';

test.describe('with an installed runtime folder', () => {
  test.skip(
    !RUNTIME,
    'set STRATLAS_E2E_RUNTIME to a data folder runtime, e.g. <real data root>/runtime',
  );

  test('the app picks the newest pipeline pack, which lists every pipeline and passes its selftest', async ({
    dataRoot,
    network,
  }) => {
    test.setTimeout(120_000);
    const versions = readdirSync(RUNTIME)
      .map((n) => /^pipeline-pack-(\d+(?:\.\d+)*)$/.exec(n)?.[1])
      .filter((v): v is string => v !== undefined)
      .sort((a, b) => {
        const x = a.split('.').map(Number);
        const y = b.split('.').map(Number);
        for (let i = 0; i < Math.max(x.length, y.length); i++)
          if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
        return 0;
      });
    const newest = versions[0] ?? '';
    expect(newest, `no pipeline-pack-<version> in ${RUNTIME}`).not.toBe('');
    const packManifest = JSON.parse(
      await readFile(join(RUNTIME, `pipeline-pack-${newest}`, 'manifest.json'), 'utf8'),
    ) as { pipelines: { name: string }[] };
    expect(packManifest.pipelines.map((p) => p.name).sort()).toEqual(
      PIPELINES.map((p) => p.name).sort(),
    );

    // The real runtime is linked in read only; the link (not the packs) is removed afterwards.
    const link = join(dataRoot.root, 'runtime');
    symlinkSync(RUNTIME, link, 'junction');
    const app = await launchApp(dataRoot, {
      STRATLAS_PIPELINE_PYTHON: '',
      STRATLAS_PIPELINE_PACK: '',
    });
    await network.attach(app);
    try {
      const win = await app.firstWindow();
      await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();
      await expect(win.locator('.jobs-rt')).toContainText(`Pipeline pack ${newest}`);
      await win.getByRole('button', { name: 'New job' }).click();
      await win.getByLabel('Pipeline', { exact: true }).selectOption('system.selftest');
      await win.getByLabel(/^Project folder/).fill(dataRoot.projectDir);
      await win.getByLabel('Wait (s)').fill('0');
      await win.getByTestId('job-start').click();
      const detail = win.locator('.job-detail');
      await expect(detail.locator('.jd-h .job-state')).toHaveText('Done', { timeout: 60_000 });
      const id = (await detail.locator('.jd-t .mono').textContent()) ?? '';
      const log = await readFile(join(dataRoot.projectDir, 'jobs', id, 'job.log'), 'utf8');
      for (const lib of ['numpy', 'rasterio', 'shapely', 'shapefile']) expect(log).toContain(lib);
      expect(await network.outbound()).toEqual([]);
    } finally {
      await app.close();
      rmdirSync(link);
    }
  });
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

  test('a LAZ dropped into a project converts to COPC in the pipeline pack and appears as a layer', async ({
    dataRoot,
    network,
  }) => {
    test.skip(!hasPdal, `no PDAL at ${pdal} (set AIO_PDAL)`);
    test.setTimeout(120_000);
    const laz = await smallLaz(dataRoot.base);
    const app = await launchApp(dataRoot, {
      STRATLAS_PIPELINE_PYTHON: venvPython,
      AIO_PDAL: pdal,
    });
    await network.attach(app);
    try {
      const win = await app.firstWindow();
      await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
      await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
      const projectId = await win.evaluate(
        () =>
          (
            window as unknown as {
              __stratlas: { workspace: { getState(): { project: { id: string } | null } } };
            }
          ).__stratlas.workspace.getState().project?.id ?? '',
      );
      // the same IPC the drop zone and the import command use
      const r = await win.evaluate(
        ({ projectId, laz }) => window.aio.invoke('builder:import', { projectId, paths: [laz] }),
        { projectId, laz },
      );
      expect(r.ok).toBe(true);
      const item = r.ok ? r.items[0] : undefined;
      expect(item).toMatchObject({ kind: 'pointcloud', status: 'queued' });
      const jobId = item?.jobId ?? '';

      // The job runs in the Jobs panel to the end.
      await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();
      await expect
        .poll(
          async () => {
            const list = await win.evaluate(() => window.aio.invoke('jobs:list', {}));
            return list.jobs.find((j) => j.id === jobId)?.status;
          },
          { timeout: 90_000 },
        )
        .toBe('done');
      const out = join(dataRoot.projectDir, 'clouds', 'site-scan.copc.laz');
      expect(existsSync(out)).toBe(true);
      const manifest = JSON.parse(
        await readFile(join(dataRoot.projectDir, 'manifest.json'), 'utf8'),
      ) as { layers: { kind: string; id: string; format?: string; src?: { path: string } }[] };
      expect(manifest.layers.find((l) => l.kind === 'pointcloud')).toMatchObject({
        id: 'cloud-site-scan',
        format: 'copc',
        src: { path: 'clouds/site-scan.copc.laz' },
      });
      // the open project reloads its manifest: the layer is in the workspace too
      await expect
        .poll(() =>
          win.evaluate(() =>
            (
              window as unknown as {
                __stratlas: {
                  workspace: {
                    getState(): { project: { manifest: { layers: { id: string }[] } } | null };
                  };
                };
              }
            ).__stratlas.workspace
              .getState()
              .project?.manifest.layers.some((l) => l.id === 'cloud-site-scan'),
          ),
        )
        .toBe(true);
      expect(await network.outbound()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
