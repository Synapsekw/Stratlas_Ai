import { brand } from '@aio/brand';
import { GcpFile, PhotoRun, ProjectManifest } from '@aio/schema';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  expect,
  hasPdal,
  hasPipelinePython,
  launchApp,
  PIPELINE_ENV,
  test,
  VENV_PYTHON,
} from './fixtures';

/**
 * OPF interchange (M10 stream G5) from the Jobs panel against the development pipeline runtime:
 * a synthetic OPF project (python/tests/opf_synth.py: six photos, calibrated cameras, control
 * points, a dense point cloud, an orthomosaic and a DSM; no client data) is imported into the tiny
 * project, then the imported run is exported back to OPF. The point cloud layer needs PDAL.
 */
const SYNTH = join(import.meta.dirname, '..', '..', '..', 'python', 'tests', 'opf_synth.py');

async function runJob(win: Page, pipeline: string, project: string, fields: [RegExp, string][]) {
  await win.getByRole('button', { name: 'New job' }).click();
  await win.getByLabel('Pipeline', { exact: true }).selectOption(pipeline);
  await win.getByLabel(/^Project folder/).fill(project);
  for (const [label, value] of fields) await win.getByLabel(label).fill(value);
  const rows = await win.locator('.job-row').count();
  await win.getByTestId('job-start').click();
  // the new job is listed and shown, and runs to the end
  await expect(win.locator('.job-row')).toHaveCount(rows + 1, { timeout: 30_000 });
  const detail = win.locator('.job-detail');
  await expect(detail.locator('.jd-h .job-state')).toHaveText('Done', { timeout: 90_000 });
}

test.describe('OPF import and export', () => {
  test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

  test('an OPF project comes in as a photos layer with calibrated cameras, a run and outputs, and goes back out', async ({
    dataRoot,
    network,
  }) => {
    test.setTimeout(180_000);
    const opf = execFileSync(VENV_PYTHON, [SYNTH, join(dataRoot.base, 'opf')], {
      encoding: 'utf8',
    }).trim();
    expect(existsSync(opf)).toBe(true);
    const app = await launchApp(dataRoot, PIPELINE_ENV);
    await network.attach(app);
    try {
      const win = await app.firstWindow();
      await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
      await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
      await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();
      await runJob(win, 'opf.import', dataRoot.projectDir, [[/^OPF project/, opf]]);

      const manifest = ProjectManifest.parse(
        JSON.parse(await readFile(join(dataRoot.projectDir, 'manifest.json'), 'utf8')),
      );
      const photos = manifest.layers.find((l) => l.kind === 'photos');
      expect(photos?.kind === 'photos' && photos.items.length).toBe(6);
      if (photos?.kind === 'photos') {
        for (const item of photos.items) {
          expect(item.pos).toHaveLength(3);
          expect(item.q).toHaveLength(4);
          expect(item.lens).toMatchObject({ model: 'pinhole' });
          expect(existsSync(join(dataRoot.projectDir, (item.src as { path: string }).path))).toBe(
            true,
          );
        }
      }
      const roles = manifest.layers.flatMap((l) => (l.kind === 'raster' ? [l.role] : []));
      expect(roles.sort()).toEqual(['dsm', 'ortho']);
      const cloud = manifest.layers.find((l) => l.kind === 'pointcloud');
      if (hasPdal()) expect(cloud).toMatchObject({ format: 'copc', pointCount: 200 });

      // the run and its control points are valid contract files
      const runId = /^photos-(.+)$/.exec(photos?.id ?? '')?.[1] ?? '';
      const runDir = join(dataRoot.projectDir, 'photogrammetry', runId);
      const run = PhotoRun.parse(JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')));
      expect(run).toMatchObject({ status: 'aligned', photos: { count: 6, registered: 6 } });
      expect(run.outputs.layers).toContain(photos?.id);
      const gcp = GcpFile.parse(JSON.parse(await readFile(join(runDir, 'gcp.json'), 'utf8')));
      expect(gcp.points.map((p) => [p.id, p.role])).toEqual([
        ['GCP1', 'control'],
        ['GCP2', 'control'],
        ['CHK1', 'check'],
      ]);

      // the open project reloads its manifest: the photos layer is in the workspace
      await expect
        .poll(() =>
          win.evaluate(
            (id) =>
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
                .project?.manifest.layers.some((l) => l.id === id),
            photos?.id ?? '',
          ),
        )
        .toBe(true);

      // the imported run goes back out as OPF
      const out = join(dataRoot.base, 'opf-export');
      await runJob(win, 'opf.export', dataRoot.projectDir, [
        [/^Run id/, runId],
        [/^Export to folder/, out],
      ]);
      const project = JSON.parse(await readFile(join(out, 'project.opf'), 'utf8')) as {
        generator: { name: string };
        items: { type: string }[];
      };
      expect(project.generator.name).toBe(brand.productName);
      expect(project.items.map((i) => i.type)).toEqual(
        expect.arrayContaining([
          'scene_reference_frame',
          'camera_list',
          'input_cameras',
          'input_control_points',
          'calibration',
          'ext_stratlas_ortho',
          'ext_stratlas_dsm',
        ]),
      );
      expect(await network.outbound()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
