/**
 * Date lanes (timeline phase L1): one lane per survey date on a site time-of-day axis. A synthetic
 * project with six dates, two short clips on each of the last three, none on the first three.
 */
import { cameraQuatFromGimbal, fromWgs84 } from '@aio/geo';
import { ProjectManifest, SCHEMA_VERSION, type ProjectManifestInput } from '@aio/schema';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test as base, type DataRoot } from './fixtures';
import { tinyMp4 } from './tinyVideo';

const ID = 'e2e-date-lanes';
const NAME = 'E2E date lanes';
/** A synthetic place at about 48 degrees east: site time is UTC+3. */
const SITE: [number, number] = [48.1, 29.0];
const DATES = ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26', '2026-10-03', '2026-10-10'];
const VIDEO_FROM = 3; // d4, d5, d6 have video

interface Probe {
  __stratlas: {
    workspace: { getState(): { activeClip: string | null; playing: boolean } };
  };
}

async function writeProject(data: DataRoot): Promise<void> {
  const dir = join(data.root, 'projects', ID);
  for (const sub of ['video', 'flights']) await mkdir(join(dir, sub), { recursive: true });
  const mp4 = await tinyMp4();
  const lens = { model: 'pinhole', hfovDeg: 71.59, aspect: 1.7778 } as const;
  const q = cameraQuatFromGimbal(0, -30, 0);
  const layers: ProjectManifestInput['layers'] = [];
  for (const [i, date] of DATES.entries()) {
    if (i < VIDEO_FROM) continue;
    for (const [k, second] of [
      ['a', 0],
      ['b', 30],
    ] as const) {
      const id = `v${String(i + 1)}${k}`;
      // 06:00 UTC is 09:00 at the site
      const startUtcMs = Date.parse(`${date}T06:00:00Z`) + second * 1000;
      await writeFile(
        join(dir, 'flights', `${id}.json`),
        JSON.stringify({
          schema: 'aio.flight/1',
          startUtcMs,
          lens,
          samples: [
            { t: 0, pos: [0, 40, 0], q },
            { t: 1000, pos: [5, 40, 0], q },
          ],
        }),
      );
      await writeFile(join(dir, 'video', `${id}.mp4`), mp4);
      layers.push({
        kind: 'video',
        id,
        name: `Clip ${id}`,
        capture: `d${String(i + 1)}`,
        src: { path: `video/${id}.mp4` },
        flight: { src: { path: `flights/${id}.json` }, startUtcMs },
        lens,
        offsetMs: 0,
      });
    }
  }
  const o = fromWgs84([SITE[0], SITE[1], 0], 32639);
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: ID,
    name: NAME,
    customer: 'E2E',
    site: 'Synthetic site',
    crs: { epsg: 32639 },
    origin: [o[0], o[1], 0],
    captures: DATES.map((date, i) => ({ id: `d${String(i + 1)}`, label: `Survey ${date}`, date })),
    layers,
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(ProjectManifest.parse(input)));
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
  );
}

const test = base.extend<{ dataRoot: DataRoot }>({
  dataRoot: async ({ dataRoot }, use) => {
    await writeProject(dataRoot);
    await use(dataRoot);
  },
});
test.setTimeout(120_000);

async function openLanes(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: NAME }).first().click();
  await expect(win.locator('.crumbs')).toContainText(NAME);
  await expect(win.getByTestId('lane-timeline')).toBeVisible({ timeout: 30_000 });
}
const state = (win: Page) =>
  win.evaluate(() => {
    const s = (window as unknown as Probe).__stratlas.workspace.getState();
    return { activeClip: s.activeClip, playing: s.playing };
  });

test('lanes show the focused date and its neighbours, the rest folded', async ({ win }) => {
  await openLanes(win);
  const tl = win.getByTestId('lane-timeline');
  await expect(win.getByTestId('date-bar')).toHaveCount(0);
  await expect(tl.getByTestId('date-bar-open')).toContainText('10 Oct 2026');
  await expect(tl.getByTestId('lane-label-d6')).toHaveAttribute('aria-pressed', 'true');
  for (const id of ['d4', 'd5', 'd6'])
    await expect(tl.getByTestId(`lane-label-${id}`)).toBeVisible();
  await expect(tl.getByTestId('lane-label-d3')).toHaveCount(0);
  await expect(tl.getByTestId('lane-clock')).toHaveText('site time ≈ UTC+3');
});

test('+N earlier expands the folded dates, and a date without video has a lane', async ({
  win,
}) => {
  await openLanes(win);
  const tl = win.getByTestId('lane-timeline');
  await expect(tl.getByTestId('lane-fold-earlier')).toContainText('+3 earlier');
  await tl.getByTestId('lane-fold-earlier').click();
  await expect(tl.getByTestId('lane-label-d1')).toBeVisible();
  await expect(tl.getByTestId('lane-fold-earlier')).toHaveCount(0);
  await expect(tl.getByTestId('lane-d1').getByTestId('lane-clip')).toHaveCount(0);
});

test('a lane label focuses its date and the sidebar follows', async ({ win }) => {
  await openLanes(win);
  await win.getByTestId('lane-label-d5').click();
  await expect(win.getByTestId('date-bar-open')).toContainText('3 Oct 2026');
  await expect(win.getByTestId('lane-label-d5')).toHaveAttribute('aria-pressed', 'true');
  await expect(win.getByTestId('date-folder-d5')).toHaveAttribute('aria-expanded', 'true');
});

test('a clip click selects it without playing', async ({ win }) => {
  await openLanes(win);
  const bar = win.getByTestId('lane-d6').getByTestId('lane-clip').nth(1);
  await bar.click();
  await expect.poll(async () => (await state(win)).activeClip).toBe('v6b');
  expect((await state(win)).playing).toBe(false);
  await expect(
    win.getByTestId('lane-timeline').getByRole('button', { name: 'Play', exact: true }),
  ).toBeVisible();
});

test('the other lanes show a ghost line at the playhead time', async ({ win }) => {
  await openLanes(win);
  await expect(win.getByTestId('lane-d6').getByTestId('playhead')).toHaveCount(1);
  await expect(win.getByTestId('lane-timeline').getByTestId('ghost-line')).toHaveCount(2);
});

test('T folds the timeline to the date row, and Alt+Left still steps', async ({ win }) => {
  await openLanes(win);
  await win.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await win.keyboard.press('t');
  await expect(win.getByTestId('date-row')).toBeVisible();
  await expect(win.getByTestId('lane-timeline')).toHaveCount(0);
  await expect(win.getByTestId('date-bar-open')).toContainText('10 Oct 2026');
  await win.keyboard.press('Alt+ArrowLeft');
  await expect(win.getByTestId('date-bar-open')).toContainText('3 Oct 2026');
  await win.keyboard.press('t');
  await expect(win.getByTestId('lane-timeline')).toBeVisible();
});
