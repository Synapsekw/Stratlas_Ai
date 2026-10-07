import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  expect,
  hasPipelinePython,
  openProject,
  PIPELINE_ENV,
  test,
  VENV_PYTHON,
} from './fixtures';

/**
 * Photogrammetry products (M10 G3) on G3's synthetic aligned project (python/tests/products_synth.py:
 * known cameras, a box building, a stockpile, checker targets): photo.products runs as a job in the
 * development pipeline runtime, then the project opens with the new ortho, DSM, DTM and mesh layers,
 * the ortho is drawn on the map and the run file lists what it made. The job is started through the
 * jobs:start channel, as the Builder's Process photos wizard (G4) will; the photos are only read.
 * Needs the development Python (`uv sync` in python/, or STRATLAS_E2E_PYTHON). Synthetic data only.
 */

const FIXTURE = join(import.meta.dirname, 'photo-fixture.py');
const PROJECT = 'synthetic-photo';

interface Fixture {
  run: string;
  origin: [number, number, number];
  targets: [number, number][];
  gsd: number;
}

interface JobLike {
  id: string;
  status: string;
  error?: string;
}
interface Bridge {
  aio: { invoke(channel: string, request: unknown): Promise<unknown> };
}
interface MapLike {
  getStyle(): { layers: { id: string }[] } | undefined;
  loaded(): boolean;
}
interface Win {
  __stratlas: {
    workspace: {
      getState(): { project: { manifest: { layers: { id: string; kind: string }[] } } | null };
    };
  };
}

const photoTest = test.extend<{ photo: Fixture & { root: string } }>({
  photo: async ({ dataRoot }, use) => {
    const root = join(dataRoot.root, 'projects', PROJECT);
    const fx = JSON.parse(
      execFileSync(VENV_PYTHON, [FIXTURE, root], { encoding: 'utf8' }),
    ) as Fixture;
    await use({ ...fx, root });
  },
});

photoTest.use({ appEnv: PIPELINE_ENV });
photoTest.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

/** Map layer ids of the first map on the page that has loaded a style. */
function mapLayers(win: Page): Promise<string[] | null> {
  return win.evaluate(() => {
    const host = [...document.querySelectorAll('div')].find((d) => '__aioMap' in d) as unknown as
      (HTMLElement & { __aioMap: MapLike }) | undefined;
    const style = host?.__aioMap.getStyle();
    return style ? style.layers.map((l) => l.id) : null;
  });
}

photoTest(
  'photo.products adds ortho, DSM, DTM and mesh layers that open in the viewers',
  async ({ photo, win }) => {
    photoTest.setTimeout(420_000);
    const run = photo.run;
    // 1. The job, as the wizard starts it.
    const started = (await win.evaluate(
      ([root, id]) =>
        (window as unknown as Bridge).aio.invoke('jobs:start', {
          pipeline: 'photo.products',
          project: root,
          params: {
            run: id,
            products: ['ortho', 'dsm', 'dtm', 'mesh'],
            preset: 'standard',
            capture: 'c1',
          },
        }),
      [photo.root, run] as const,
    )) as { ok: boolean; job?: JobLike; error?: string };
    expect(started.error ?? '').toBe('');
    const jobId = started.job?.id ?? '';
    let last: JobLike | undefined;
    await expect
      .poll(
        async () => {
          const list = (await win.evaluate(() =>
            (window as unknown as Bridge).aio.invoke('jobs:list', {}),
          )) as { jobs: JobLike[] };
          last = list.jobs.find((j) => j.id === jobId);
          if (last?.status === 'failed')
            throw new Error(`photo.products failed: ${last.error ?? ''}`);
          return last?.status;
        },
        { timeout: 360_000, intervals: [1000] },
      )
      .toBe('done');

    // 2. The run file lists the layers; the photos were only read.
    const runDoc = JSON.parse(
      await readFile(join(photo.root, 'photogrammetry', run, 'run.json'), 'utf8'),
    ) as { status: string; outputs: { layers: string[]; files: string[] } };
    const ids = [`${run}-ortho`, `${run}-dsm`, `${run}-dtm`, `${run}-mesh`];
    expect(runDoc.status).toBe('done');
    expect([...runDoc.outputs.layers].sort()).toEqual([...ids].sort());
    for (const f of runDoc.outputs.files) expect(existsSync(join(photo.root, f)), f).toBe(true);

    // 3. The project opens with the new layers.
    await win
      .getByTestId('project-card')
      .filter({ hasText: 'Synthetic photo site' })
      .first()
      .click();
    await expect.poll(async () => (await openProject(win)).id, { timeout: 60_000 }).toBe(PROJECT);
    const layers = await win.evaluate(
      () =>
        (window as unknown as Win).__stratlas.workspace.getState().project?.manifest.layers ?? [],
    );
    expect(layers.map((l) => l.id).sort()).toEqual([...ids].sort());
    expect(layers.find((l) => l.id === `${run}-mesh`)?.kind).toBe('mesh');

    // 4. The ortho is drawn on the map (its pyramid's coarse tiles as image layers).
    await win.getByRole('button', { name: 'Map', exact: true }).first().click();
    await expect(win.locator('.stage')).toHaveAttribute('data-mode', 'map');
    await expect
      .poll(
        async () =>
          (await mapLayers(win))?.filter((l) => l.startsWith(`aio-raster-${run}-ortho-`)).length ??
          0,
        {
          timeout: 60_000,
        },
      )
      .toBeGreaterThan(0);
  },
);
