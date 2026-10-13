/**
 * Delete and start over (13 Oct 2026): **Delete…** on the Video group in Datasets moves both clips
 * and the flight file they share to the project trash; **Delete…** on a photos layer takes its
 * failed run, the map layer the run left and the run's job folder with it, and forgets the job's
 * record; the Datasets footer shows the trash and **Empty** deletes it for good. In Processing,
 * **Start over…** on a failed run opens the photo dialog filled in from the run: cancelled, the run
 * stays and nothing goes to the trash; started, the new run opens and the old one goes to the
 * trash. The confirm's buttons are in view in the smallest window.
 *
 * Parts 4 and 5 (Start over) run on the e2e stand-in pipelines (`photoPack.ts`) and need the
 * development Python (`uv sync` in python/, or QUADRION_E2E_PYTHON); without it they skip.
 * Synthetic data only; zero network.
 */
import type { Page } from '@playwright/test';
import { ProjectManifest, type ProjectManifestInput } from '@aio/schema';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  expect,
  hasPipelinePython,
  openProcessing,
  test as base,
  tinyManifest,
  VENV_PYTHON,
  type DataRoot,
} from './fixtures';
import {
  openOptions,
  openPhotoSite,
  PHOTO_PLATFORM,
  PHOTO_PLATFORM_ONLY,
  photoFixtures,
  type PhotoFixtures,
  type PhotoWorkerFixtures,
} from './photoPack';

const TINY = 'E2E tiny project';
const FAILED_RUN = '20261012-0930';
const ORTHO = `${FAILED_RUN}-ortho`;
const JOB = 'job-0930';
const OLD_RUN = '20261013-0700';

/** A 1 x 1 grey JPEG. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////' +
    '////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

/** A tiny real MP4 (two 32 x 32 frames) from the demo's own H.264 writer. */
async function tinyMp4(): Promise<Buffer> {
  const url = pathToFileURL(join(import.meta.dirname, '../../../tools/demo/h264.mjs')).href;
  const h264 = (await import(url)) as {
    encodeH264Pcm(frames: Uint8Array[], w: number, h: number): unknown;
    muxMp4(enc: unknown, o: { fps: number }): Buffer;
  };
  const frame = () => new Uint8Array(32 * 32 * 3).fill(96);
  return h264.muxMp4(h264.encodeH264Pcm([frame(), frame()], 32, 32), { fps: 2 });
}

async function put(root: string, rel: string, data: string | Buffer): Promise<void> {
  const file = join(root, ...rel.split('/'));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** A failed photo run's `run.json`. */
const failedRun = (id: string, layer: string, settings?: Record<string, unknown>) => ({
  schema: 'aio.photo-run/1',
  id,
  createdAt: '2026-10-12T09:30:00.000Z',
  status: 'failed',
  preset: 'fast',
  photos: { source: { layer }, count: 2 },
  cameras: [],
  crs: { epsg: 32639 },
  ...(settings ? { settings } : {}),
  stages: [],
  outputs: { layers: [], tilesets: [], files: [] },
  versions: {},
});

/**
 * The tiny project, before the app starts: photos layer `photos-a` (two photos, survey date
 * `capture-1`), clips `clip-1` and `clip-2` sharing `flights/f1.json`, the failed run
 * `20261012-0930` from `photos-a` with the map layer it left (hidden) and its job folder, and the
 * job's record in the job index.
 */
async function writeTinyProject(data: DataRoot): Promise<void> {
  const dir = data.projectDir;
  const startUtcMs = Date.UTC(2026, 0, 1, 7, 0, 0);
  const lens = { model: 'pinhole', hfovDeg: 71.59, aspect: 1.7778 } as const;
  const clip = (id: string, name: string) => ({
    kind: 'video' as const,
    id,
    name,
    src: { path: `video/${id}.mp4` },
    flight: { src: { path: 'flights/f1.json' }, startUtcMs },
    lens,
    offsetMs: 0,
  });
  const tiny = tinyManifest();
  const input: ProjectManifestInput = {
    ...tiny,
    layers: [
      ...tiny.layers,
      {
        kind: 'photos',
        id: 'photos-a',
        name: 'Flight A',
        capture: 'capture-1',
        items: [
          { id: 'p1', src: { path: 'photos/p1.jpg' } },
          { id: 'p2', src: { path: 'photos/p2.jpg' } },
        ],
      },
      clip('clip-1', 'Clip 1'),
      clip('clip-2', 'Clip 2'),
      {
        kind: 'raster',
        id: ORTHO,
        name: 'Orthomosaic 0930',
        visible: false,
        src: { path: `rasters/${ORTHO}/tiles.json` },
        role: 'ortho',
        format: 'kit-pyramid',
      },
    ],
  };
  await put(dir, 'manifest.json', json(ProjectManifest.parse(input)));
  await put(dir, 'photos/p1.jpg', JPEG);
  await put(dir, 'photos/p2.jpg', JPEG);
  const mp4 = await tinyMp4();
  await put(dir, 'video/clip-1.mp4', mp4);
  await put(dir, 'video/clip-2.mp4', mp4);
  await put(
    dir,
    'flights/f1.json',
    JSON.stringify({
      schema: 'aio.flight/1',
      startUtcMs,
      lens,
      samples: [
        { t: 0, pos: [0, 40, 0], q: [0, 0, 0, 1] },
        { t: 1000, pos: [5, 40, 0], q: [0, 0, 0, 1] },
      ],
    }),
  );
  await put(dir, `photogrammetry/${FAILED_RUN}/run.json`, json(failedRun(FAILED_RUN, 'photos-a')));
  await put(dir, `rasters/${ORTHO}/tiles.json`, '{}');
  await put(dir, `jobs/${JOB}/job.log`, 'synthetic job log\n');
  await put(
    data.userData,
    'jobs.json',
    json([
      {
        id: JOB,
        pipeline: 'photo.align',
        project: dir,
        params: { run: FAILED_RUN },
        status: 'failed',
        progress: 0.4,
        steps: [],
        error: 'Synthetic failure',
        artifacts: [],
        createdAt: '2026-10-12T09:30:00.000Z',
        updatedAt: '2026-10-12T09:35:00.000Z',
        finishedAt: '2026-10-12T09:35:00.000Z',
      },
    ]),
  );
}

const test = base.extend<{ dataRoot: DataRoot }>({
  dataRoot: async ({ dataRoot }, use) => {
    await writeTinyProject(dataRoot);
    await use(dataRoot);
  },
});

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
const entries = async (dir: string) => ((await exists(dir)) ? (await readdir(dir)).sort() : []);

async function openTiny(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: TINY }).first().click();
  await expect(win.locator('.crumbs')).toContainText(TINY);
}

/**
 * A Datasets row, with its survey date folder and its group opened when they are closed (a
 * folder's groups start closed).
 */
async function row(win: Page, layer: string, at?: { capture: string; group: string }) {
  const r = win.getByTestId(`tree-row-${layer}`);
  if (at && !(await r.isVisible())) {
    const folder = win.getByTestId(`date-folder-${at.capture}`);
    if ((await folder.getAttribute('aria-expanded')) === 'false')
      await folder.getByRole('button').first().click();
    const group = folder.getByTestId(`tree-group-toggle-${at.group}`);
    if ((await group.getAttribute('aria-expanded')) === 'false') await group.click();
  }
  await expect(r).toBeVisible();
  return r;
}
const PHOTOS_A = { capture: 'capture-1', group: 'photos' };

/** Right-click the Video group header and choose **Delete…**; the confirm. */
async function askDeleteVideos(win: Page) {
  const group = win.getByTestId('tree-group-video');
  await expect(group).toBeVisible();
  await group.click({ button: 'right' });
  await win.getByTestId('menu-delete').click();
  const dialog = win.getByTestId('remove-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.setTimeout(120_000);

test('datasets go to the project trash with what was made from them, and Empty deletes it', async ({
  win,
  dataRoot,
}) => {
  const dir = dataRoot.projectDir;
  const trash = join(dir, '.trash');
  await openTiny(win);
  await row(win, 'photos-a', PHOTOS_A);
  await row(win, ORTHO);

  // 1. the Video group: both clips and the flight file they share
  const dialog = await askDeleteVideos(win);
  await expect(dialog.getByTestId('remove-dialog-title')).toHaveText('Delete 2 datasets?');
  await expect(dialog.getByTestId('remove-dialog-asked')).toContainText('Clip 1');
  await expect(dialog.getByTestId('remove-dialog-asked')).toContainText('Clip 2');
  await expect(dialog.getByTestId('remove-dialog-cancel')).toBeFocused();
  await dialog.getByTestId('remove-dialog-confirm').click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await expect(win.getByTestId('tree-row-clip-1')).toHaveCount(0);
  await expect(win.getByTestId('tree-row-clip-2')).toHaveCount(0);
  await expect(win.getByTestId('tree-group-video')).toHaveCount(0);
  await expect.poll(() => entries(trash)).toHaveLength(1);
  const [first = ''] = await entries(trash);
  for (const f of ['video/clip-1.mp4', 'video/clip-2.mp4', 'flights/f1.json'])
    expect(await exists(join(trash, first, f)), f).toBe(true);
  const record = JSON.parse(await readFile(join(trash, first, 'removed.json'), 'utf8')) as {
    schema: string;
  };
  expect(record.schema).toBe('aio.trash/1');
  // the manifest as it was, for a restore by hand
  const before = JSON.parse(await readFile(join(trash, first, 'manifest.before.json'), 'utf8')) as {
    layers: { id: string }[];
  };
  expect(before.layers.map((l) => l.id)).toEqual(expect.arrayContaining(['clip-1', 'clip-2']));
  expect(await exists(join(dir, 'video', 'clip-1.mp4'))).toBe(false);
  expect(await exists(join(dir, 'flights', 'f1.json'))).toBe(false);

  // 2. the photos layer, with its failed run, the map layer it left and its job folder
  await (await row(win, 'photos-a', PHOTOS_A)).click({ button: 'right' });
  await win.getByTestId('menu-delete').click();
  const second = win.getByTestId('remove-dialog');
  await expect(second.getByTestId('remove-dialog-title')).toHaveText('Delete Flight A?');
  const also = second.getByTestId('remove-dialog-also');
  await expect(also).toContainText(`Run ${FAILED_RUN} and its 1 map layer`);
  await expect(also).toContainText('1 job folder');
  await second.getByTestId('remove-dialog-confirm').click();
  await expect(second).toHaveCount(0, { timeout: 30_000 });
  await expect(win.getByTestId('tree-row-photos-a')).toHaveCount(0);
  await expect(win.getByTestId(`tree-row-${ORTHO}`)).toHaveCount(0);
  await expect.poll(() => entries(trash)).toHaveLength(2);
  const entry = (await entries(trash)).find((e) => e !== first) ?? '';
  for (const f of [`photogrammetry/${FAILED_RUN}/run.json`, `jobs/${JOB}/job.log`])
    expect(await exists(join(trash, entry, f)), f).toBe(true);
  expect(await exists(join(dir, 'photogrammetry', FAILED_RUN))).toBe(false);
  // the job's record is forgotten: its run cannot come back from the trash
  await expect
    .poll(
      async () =>
        (
          JSON.parse(await readFile(join(dataRoot.userData, 'jobs.json'), 'utf8')) as {
            id: string;
          }[]
        )
          .map((j) => j.id)
          .includes(JOB),
      { timeout: 5_000 },
    )
    .toBe(false);

  // 3. the footer shows the trash; Empty deletes both removals for good
  const foot = win.getByTestId('tree-trash');
  await expect(foot).toHaveText(/^Trash \S.*·\s*Empty$/);
  await win.getByTestId('tree-trash-empty').click();
  const empty = win.getByTestId('trash-empty');
  await expect(empty).toContainText('2 removals');
  await empty.getByTestId('trash-empty-confirm').click();
  await expect(empty).toHaveCount(0, { timeout: 30_000 });
  await expect(foot).toHaveCount(0);
  await expect.poll(() => entries(trash)).toEqual([]);
});

test.describe('in the smallest window', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } });

  test("the confirm's buttons are in view at 1100 x 700", async ({ win, dataRoot }) => {
    await openTiny(win);
    const dialog = await askDeleteVideos(win);
    const confirm = dialog.getByTestId('remove-dialog-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByTestId('remove-dialog-cancel')).toBeInViewport({ ratio: 1 });
    await dialog.getByTestId('remove-dialog-cancel').click();
    await expect(dialog).toHaveCount(0);
    expect(await exists(join(dataRoot.projectDir, '.trash'))).toBe(false);
  });
});

// ---------------------------------------------------------------- Start over

/** The photo site with a failed run from its photos layer, written before the app starts. */
const photoTest = base
  .extend<PhotoFixtures, PhotoWorkerFixtures>(photoFixtures)
  .extend<{ photoSite: PhotoFixtures['photoSite'] }>({
    photoSite: async ({ photoSite }, use) => {
      await put(
        photoSite.dir,
        `photogrammetry/${OLD_RUN}/run.json`,
        json({
          ...failedRun(OLD_RUN, 'photos', { gnss: 'standard' }),
          photos: { source: { layer: 'photos' }, count: 12 },
        }),
      );
      await use(photoSite);
    },
  });

photoTest.describe('Start over on the stand-in pipelines', () => {
  photoTest.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);
  photoTest.skip(!PHOTO_PLATFORM, PHOTO_PLATFORM_ONLY);

  photoTest(
    'Start over fills the dialog from the failed run; cancelled it keeps the run, started it replaces it',
    async ({ win, photoSite }) => {
      photoTest.setTimeout(180_000);
      const trash = join(photoSite.dir, '.trash');
      await openPhotoSite(win);

      // 4. cancelled: the run stays and nothing goes to the trash
      let drawer = await openProcessing(win);
      const runRow = () => win.getByTestId('photo-runs').locator(`[data-run="${OLD_RUN}"]`);
      await expect(runRow()).toBeVisible();
      await drawer.getByTestId(`run-start-over-${OLD_RUN}`).click();
      const wizard = win.getByRole('dialog', { name: `Start run ${OLD_RUN} over` });
      await expect(wizard).toBeVisible();
      await expect(wizard.getByRole('heading', { level: 2 })).toHaveText(
        `Start run ${OLD_RUN} over`,
      );
      await expect(wizard.getByTestId('photo-summary')).toContainText('12 photos, 1 camera', {
        timeout: 60_000,
      });
      const options = await openOptions(wizard);
      await expect(options.getByRole('button', { name: /^Quick/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await win.keyboard.press('Escape');
      await expect(wizard).toHaveCount(0);
      drawer = await openProcessing(win);
      await expect(runRow()).toBeVisible();
      expect(await exists(trash)).toBe(false);

      // 5. started: the new run opens and the old one goes to the trash
      await drawer.getByTestId(`run-start-over-${OLD_RUN}`).click();
      const again = win.getByRole('dialog', { name: `Start run ${OLD_RUN} over` });
      await expect(again.getByTestId('photo-summary')).toContainText('12 photos, 1 camera', {
        timeout: 60_000,
      });
      await expect(again.getByTestId('start-over-removes')).toContainText(
        `Run ${OLD_RUN} and what it made go to the project trash when this run starts.`,
      );
      const runs = join(photoSite.dir, 'photogrammetry');
      const runsBefore = await entries(runs);
      await again.getByTestId('photo-start').click();
      const panel = win.getByTestId('photo-run');
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => (await entries(trash)).filter((e) => e.endsWith(`-run-${OLD_RUN}`)), {
          timeout: 30_000,
        })
        .toHaveLength(1);
      const [entry = ''] = (await entries(trash)).filter((e) => e.endsWith(`-run-${OLD_RUN}`));
      expect(await exists(join(trash, entry, 'photogrammetry', OLD_RUN, 'run.json'))).toBe(true);
      // the old run's folder is gone; the new run has its own folder with its run.json
      expect(await exists(join(runs, OLD_RUN))).toBe(false);
      const added = async () => (await entries(runs)).filter((r) => !runsBefore.includes(r));
      await expect.poll(added, { timeout: 30_000 }).toHaveLength(1);
      const [newRun = ''] = await added();
      expect(newRun).not.toBe(OLD_RUN);
      await expect
        .poll(() => exists(join(runs, newRun, 'run.json')), { timeout: 30_000 })
        .toBe(true);
      // back in the drawer the old run is gone
      await panel.getByRole('button', { name: 'Close' }).click();
      await expect(panel).toHaveCount(0);
      await openProcessing(win);
      await expect(runRow()).toHaveCount(0);
    },
  );
});
