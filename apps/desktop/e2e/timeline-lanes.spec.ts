/**
 * Date lanes (timeline phase L1): one lane per survey date on a site time-of-day axis. A synthetic
 * project with seven dates (d0 to d6), two short clips on each of the last three, none on the first
 * four. Seven, so that a middle date shows a fold on both sides.
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
const DATES = [
  '2026-08-29',
  '2026-09-05',
  '2026-09-12',
  '2026-09-19',
  '2026-09-26',
  '2026-10-03',
  '2026-10-10',
];
const VIDEO_FROM = 4; // d4, d5, d6 have video
const DAY_MS = 86_400_000;

interface Probe {
  __stratlas: {
    workspace: { getState(): { activeClip: string | null; playing: boolean; nowMs: number } };
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
      const id = `v${String(i)}${k}`;
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
        capture: `d${String(i)}`,
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
    captures: DATES.map((date, i) => ({ id: `d${String(i)}`, label: `Survey ${date}`, date })),
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
  await expect(win.locator('.proj-switch')).toContainText(NAME);
  await expect(win.getByTestId('lane-timeline')).toBeVisible({ timeout: 30_000 });
}
const state = (win: Page) =>
  win.evaluate(() => {
    const s = (window as unknown as Probe).__stratlas.workspace.getState();
    return { activeClip: s.activeClip, playing: s.playing, nowMs: s.nowMs };
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
  await expect(tl.getByTestId('lane-fold-earlier')).toContainText('+4 earlier');
  await tl.getByTestId('lane-fold-earlier').click();
  await expect(tl.getByTestId('lane-label-d1')).toBeVisible();
  await expect(tl.getByTestId('lane-fold-earlier')).toHaveCount(0);
  await expect(tl.getByTestId('lane-d1').getByTestId('lane-clip')).toHaveCount(0);
});

test('a lane label focuses its date, the playhead follows and the sidebar too', async ({ win }) => {
  await openLanes(win);
  const before = await state(win);
  await win.getByTestId('lane-label-d5').click();
  await expect(win.getByTestId('date-bar-open')).toContainText('3 Oct 2026');
  await expect(win.getByTestId('lane-label-d5')).toHaveAttribute('aria-pressed', 'true');
  await expect(win.getByTestId('date-folder-d5')).toHaveAttribute('aria-expanded', 'true');
  // the same site time of day a week earlier, in that date's own clip, not playing
  await expect.poll(async () => (await state(win)).nowMs).toBe(before.nowMs - 7 * DAY_MS);
  const after = await state(win);
  expect(after.activeClip).toMatch(/^v5/);
  expect(after.playing).toBe(false);
  await expect(win.getByTestId('lane-d5').getByTestId('playhead')).toHaveCount(1);
});

test('the calendar opens from the lanes and picks a date', async ({ win }) => {
  await openLanes(win);
  await win.getByTestId('lane-timeline').getByTestId('date-bar-open').click();
  const cal = win.getByTestId('calendar');
  await expect(cal).toBeVisible();
  // wholly inside the window and on top, not clipped by the lanes' scrolling body
  const m = await cal.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      onTop: el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 8)),
    };
  });
  expect(m.inside).toBe(true);
  expect(m.onTop).toBe(true);
  await cal.getByTestId('cal-day-2026-10-03').click();
  await expect(cal).toHaveCount(0);
  await expect(win.getByTestId('lane-label-d5')).toHaveAttribute('aria-pressed', 'true');
  expect((await state(win)).activeClip).toMatch(/^v5/);
});

test('a clip click selects it without playing', async ({ win }) => {
  await openLanes(win);
  const bar = win.getByTestId('lane-d6').getByTestId('lane-clip').nth(1);
  await bar.click();
  await expect.poll(async () => (await state(win)).activeClip).toBe('v6b');
  // a delayed play() would still pass one read: watch the whole window, the clock must stay put
  const at = (await state(win)).nowMs;
  for (let i = 0; i < 15; i++) {
    const s = await state(win);
    expect(s.playing).toBe(false);
    expect(s.nowMs).toBe(at);
    await win.waitForTimeout(100);
  }
  await expect(
    win.getByTestId('lane-timeline').getByRole('button', { name: 'Play', exact: true }),
  ).toBeVisible();
});

test('the other lanes show a ghost line at the playhead time', async ({ win }) => {
  await openLanes(win);
  await expect(win.getByTestId('lane-d6').getByTestId('playhead')).toHaveCount(1);
  const ghosts = win.getByTestId('lane-timeline').getByTestId('ghost-line');
  await expect(ghosts).toHaveCount(2);
  // the ghost sits at the same time of day as the playhead
  const head = await win.getByTestId('lane-d6').getByTestId('playhead').boundingBox();
  const ghost = await ghosts.first().boundingBox();
  expect(head && ghost && Math.abs(head.x - ghost.x)).toBeLessThanOrEqual(2);
});

test('T folds the timeline to the date row, and Alt+Left still steps', async ({ win }) => {
  await openLanes(win);
  await win.keyboard.press('t');
  await expect(win.getByTestId('date-row')).toBeVisible();
  await expect(win.getByTestId('lane-timeline')).toHaveCount(0);
  await expect(win.getByTestId('date-bar-open')).toContainText('10 Oct 2026');
  await win.keyboard.press('Alt+ArrowLeft');
  await expect(win.getByTestId('date-bar-open')).toContainText('3 Oct 2026');
  await win.keyboard.press('t');
  await expect(win.getByTestId('lane-timeline')).toBeVisible();
});

test.describe('at the CI window size', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x720' } });

  test('the header keeps one row and nothing spills out of the bar', async ({ win }) => {
    await openLanes(win);
    const tl = win.getByTestId('lane-timeline');
    // focus a middle date so both folds show
    for (let i = 0; i < 3; i++) await win.keyboard.press('Alt+ArrowLeft');
    await expect(tl.getByTestId('date-bar-open')).toContainText('19 Sep 2026');
    await expect(tl.getByTestId('lane-fold-later')).toBeVisible();
    await expect(tl.getByTestId('lane-fold-earlier')).toBeVisible();
    const m = await tl.evaluate((el) => {
      const h = el.querySelector<HTMLElement>('.tl-h');
      const corner = el.querySelector<HTMLElement>('.lt-corner');
      const date = el.querySelector<HTMLElement>('[data-testid="date-bar-open"]');
      const clock = el.querySelector<HTMLElement>('[data-testid="lane-clock"]');
      if (!h || !corner || !date || !clock) throw new Error('lane header parts missing');
      const hb = h.getBoundingClientRect();
      const cb = corner.getBoundingClientRect();
      const db = date.getBoundingClientRect();
      const kids = [...h.children].map((k) => k.getBoundingClientRect());
      return {
        header: { scroll: h.scrollWidth, client: h.clientWidth, height: hb.height },
        corner: { scroll: corner.scrollWidth, client: corner.clientWidth },
        kidsInside: kids.every((k) => k.right <= hb.right + 0.5 && k.bottom <= hb.bottom + 0.5),
        date: { height: db.height, inside: db.top >= cb.top - 0.5 && db.bottom <= cb.bottom + 0.5 },
        clockTitle: clock.title,
      };
    });
    expect(m.header.scroll).toBeLessThanOrEqual(m.header.client);
    expect(m.kidsInside).toBe(true);
    expect(m.corner.scroll).toBeLessThanOrEqual(m.corner.client);
    // one line: the date never wraps
    expect(m.date.height).toBeLessThanOrEqual(24);
    expect(m.date.inside).toBe(true);
    expect(m.clockTitle).toBe('site time ≈ UTC+3');
  });
});
