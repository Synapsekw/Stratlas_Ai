/**
 * Measurements under their survey dates, in the real app, on the synthetic earthworks demo (three
 * surveys, the first two prepared as height surfaces). An area drawn on the first date is filed
 * under it and leaves the view when another date is focused; dragged onto that date's folder it
 * is measured again there (its heights now the second survey's, over Stockpile B, which the
 * second survey adds) and waits for Save; a move onto a date with no prepared surfaces is refused
 * with the offer to prepare them; the row menu's Move to date moves it back without a drag; an
 * antenna measurement stays on its date; and a DSM dragged to another date takes the measurements
 * made on it along. Off-screen, zero network, pipeline Python needed.
 */
import { MeasurementsFile } from '@aio/schema';
import type { Locator, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { measureControl, measureSaved, measureTree, stageMode } from './island';
import { openDemo, prepareSurveys, setAutoPrepare } from './surveyJobs';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

/** Stockpile B (truth.json `features.pile-b`): 3 m high, 10 m round, on the second survey on. */
const PILE_B = [551130, 2331340] as const;

/** A 12 m square around Stockpile B's centre, at the first survey's ground. */
const square = (half: number): [number, number, number][] => [
  [PILE_B[0] - half, PILE_B[1] - half, 120],
  [PILE_B[0] + half, PILE_B[1] - half, 120],
  [PILE_B[0] + half, PILE_B[1] + half, 120],
  [PILE_B[0] - half, PILE_B[1] + half, 120],
];

const SEED = MeasurementsFile.parse({
  schema: 'aio.measurements/1',
  measurements: [
    {
      id: 'pile-d1',
      family: 'polygon',
      tool: 'area',
      label: 'Pile on d1',
      folder: 'Piles',
      scope: { kind: 'survey', capture: 'd1' },
      source: { layer: 'dsm-d1' },
      pickedOn: ['ground', 'ground', 'ground', 'ground'],
      points: square(6),
      items: [],
      results: [],
      createdAt: '2026-10-20T00:00:00Z',
    },
    {
      id: 'pile-d2',
      family: 'polygon',
      tool: 'area',
      label: 'Pile on d2',
      folder: 'Piles',
      scope: { kind: 'survey', capture: 'd2' },
      source: { layer: 'dsm-d2' },
      pickedOn: ['ground', 'ground', 'ground', 'ground'],
      points: square(8),
      items: [],
      results: [],
      createdAt: '2026-10-20T00:00:00Z',
    },
    {
      id: 'ant-d1',
      family: 'line',
      tool: 'azimuth',
      label: 'Antenna on d1',
      scope: { kind: 'survey', capture: 'd1' },
      source: { layer: 'ortho-d1' },
      pickedOn: ['ground', 'ground', 'ground'],
      points: [
        [551180, 2331440, 120],
        [551181, 2331440, 120],
        [551181, 2331441, 120],
      ],
      items: [],
      results: [],
      createdAt: '2026-10-20T00:00:00Z',
    },
  ],
});

/** A measurement's row under one date's Measurements group, by id. */
const rowIn = (win: Page, date: string, id: string): Locator =>
  win.getByTestId(`date-folder-${date}`).locator(`[data-testid="measure-row"][data-id="${id}"]`);

/** A measurement folder row under one date, by name. */
const folderIn = (win: Page, date: string, name: string): Locator =>
  win
    .getByTestId(`date-folder-${date}`)
    .locator(`[data-testid="measure-folder"][data-folder="${name}"]`);

/**
 * Drag a row onto a target the way a person can, always with stepped pointer moves: a one-jump
 * `dragTo` drop onto a date name never registers. In CI's short window the sidebar list is about
 * 200 px high and a date's folder can be further than that from a row under another date, so the
 * drag is held at the list's edge, which Chromium scrolls under a held drag, until the target is
 * in view (`timeline.spec.ts`).
 */
async function dragOnto(win: Page, row: Locator, target: Locator): Promise<void> {
  const targetEl = await target.elementHandle();
  const above = await row.evaluate((rowEl, other) => {
    let list: HTMLElement | null = rowEl.parentElement;
    while (list && !/(auto|scroll)/.test(getComputedStyle(list).overflowY))
      list = list.parentElement;
    const a = rowEl.getBoundingClientRect();
    const b = other.getBoundingClientRect();
    if (list) {
      const mid = (Math.min(a.top, b.top) + Math.max(a.bottom, b.bottom)) / 2;
      const box = list.getBoundingClientRect();
      list.scrollTop += mid - (box.top + box.height / 2);
    }
    return b.top < a.top;
  }, targetEl);
  await row.evaluate((el) => {
    el.scrollIntoView({ block: 'center' });
  });
  const list = await win.locator('.sb-scroll').boundingBox();
  const box = await row.boundingBox();
  if (!list || !box) throw new Error('the row or the sidebar list is not on screen');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x + 16, y + 4, { steps: 4 });
  const edge = { x: list.x + list.width / 2, y: above ? list.y + 6 : list.y + list.height - 6 };
  await win.mouse.move(edge.x, edge.y, { steps: 5 });
  let nudge = 0;
  await expect(async () => {
    nudge = 1 - nudge;
    await win.mouse.move(edge.x + nudge, edge.y);
    await expect(target).toBeInViewport({ ratio: 1, timeout: 100 });
  }).toPass({ timeout: 15_000 });
  await target.hover();
  await target.hover();
  await win.mouse.up();
}

/** Fold a date folder with its arrow (the focus stays), so the folders around it are near. */
async function fold(win: Page, date: string): Promise<void> {
  const f = win.getByTestId(`date-folder-${date}`);
  if ((await f.getAttribute('aria-expanded')) === 'true')
    await f.getByRole('button', { name: /^Collapse/ }).click();
  await expect(f).toHaveAttribute('aria-expanded', 'false');
}

const onDisk = async (file: string) =>
  MeasurementsFile.parse(JSON.parse(await readFile(file, 'utf8'))).measurements;

test('measurements file under their dates, move between dates and follow their layer', async ({
  earthworksProject,
  win,
}, testInfo) => {
  test.setTimeout(420_000);
  const root = earthworksProject.dir;
  const file = join(root, 'survey', 'measurements.json');
  await writeFile(file, JSON.stringify(SEED, null, 1));
  await prepareSurveys(win, root);
  // the third survey stays unprepared: nothing prepares it on its own when the project opens
  await setAutoPrepare(win, false);
  await openDemo(win, earthworksProject.name, earthworksProject.id);
  await stageMode(win, '3D');
  const canvas = win.locator('[data-scene-view] canvas').first();
  await expect(canvas).toBeVisible();

  // the seeds sit under their dates; nothing for the backfill to do, nothing unsaved
  await measureTree(win, 'd1');
  await expect(rowIn(win, 'd1', 'pile-d1')).toBeVisible();
  await expect(rowIn(win, 'd1', 'ant-d1')).toBeVisible();
  await measureTree(win, 'd2');
  await expect(rowIn(win, 'd2', 'pile-d2')).toBeVisible();
  await expect(await measureSaved(win)).not.toContainText('Unsaved changes');

  // (1) focus the first survey, frame its pile, and draw an area there in 3D
  await win.getByTestId('date-name-d1').click();
  await expect(win.getByTestId('date-folder-d1')).toHaveAttribute('aria-selected', 'true');
  await measureTree(win, 'd1');
  await rowIn(win, 'd1', 'pile-d1').click({ button: 'right' });
  await win.getByTestId('ctx-item-measure.flyTo').click();
  await (await measureControl(win, 'survey-tool-area')).click();
  await expect(win.getByTestId('survey-drawbar')).toBeVisible();
  // the seeded square's label sits at its centroid, Stockpile B's centre: once the flight has
  // settled, draw a small square just below it (the label box runs up and to the right)
  const anchorOf = () =>
    win.locator('.sv-label[data-id="pile-d1"]').evaluate((el) => {
      const host = el.parentElement?.getBoundingClientRect();
      const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec((el as HTMLElement).style.transform);
      return host && m
        ? { x: Math.round(host.left + Number(m[1])), y: Math.round(host.top + Number(m[2])) }
        : null;
    });
  // still over three reads in a row: a read taken before the flight starts is not settled
  let at = await anchorOf();
  let still = 0;
  await expect(async () => {
    const now = await anchorOf();
    still = now !== null && at !== null && now.x === at.x && now.y === at.y ? still + 1 : 0;
    at = now;
    expect(still, 'the view has settled on the pile').toBeGreaterThanOrEqual(3);
  }).toPass({ timeout: 20_000, intervals: [400] });
  if (!at) throw new Error('no anchor for the seeded pile');
  const { x: px, y: py } = at;
  const corners = [
    [px - 6, py + 4],
    [px + 6, py + 4],
    [px + 6, py + 14],
    [px - 6, py + 14],
  ] as const;
  const onCanvas = await win.evaluate(
    (pts) => pts.map(([x, y]) => document.elementFromPoint(x, y) instanceof HTMLCanvasElement),
    corners.map(([x, y]) => [x, y] as [number, number]),
  );
  expect(onCanvas, 'every corner lies on the 3D canvas').toEqual([true, true, true, true]);
  for (const [x, y] of corners) await win.mouse.click(x, y);
  await win.keyboard.press('Enter');
  await win.keyboard.press('Escape');
  const group = await measureTree(win, 'd1');
  const seeded = new Set(SEED.measurements.map((m) => m.id));
  const drawnRow = group.locator(
    `[data-testid="measure-row"]${[...seeded].map((id) => `:not([data-id="${id}"])`).join('')}`,
  );
  await expect(drawnRow).toHaveCount(1);
  const drawnId = (await drawnRow.getAttribute('data-id')) ?? '';
  expect(drawnId).not.toBe('');
  await expect(win.locator(`.sv-label[data-id="${drawnId}"]`)).toBeVisible();

  // save it, to compare its heights after the move
  await (await measureSaved(win)).getByTestId('survey-list-save').click();
  await expect(win.getByTestId('survey-saved')).toContainText('Measurements saved.');
  const drawn = (await onDisk(file)).find((m) => m.id === drawnId);
  expect(drawn?.scope).toEqual({ kind: 'survey', capture: 'd1' });
  // picked in 3D on the first survey's DSM (its shaded relief, the date's base layer)
  expect(drawn?.source).toEqual({ layer: 'dsm-d1' });
  const zBefore = (drawn?.points ?? []).map((p) => p[2]);

  // (2) focus the second survey: the drawn row is dimmed and its label leaves the 3D view
  await win.getByTestId('date-name-d2').click();
  await expect(win.getByTestId('date-folder-d2')).toHaveAttribute('aria-selected', 'true');
  await measureTree(win, 'd1');
  await expect(rowIn(win, 'd1', drawnId)).toHaveClass(/\bdim\b/);
  await expect(win.locator(`.sv-label[data-id="${drawnId}"]`)).toHaveCount(0);

  // (3) into the first survey's Piles folder, then onto the second survey: measured again there
  await dragOnto(win, rowIn(win, 'd1', drawnId), folderIn(win, 'd1', 'Piles'));
  await expect(
    folderIn(win, 'd1', 'Piles').locator('..').locator(`[data-id="${drawnId}"]`),
  ).toHaveCount(1);
  await fold(win, 'd2');
  await fold(win, 'd3');
  await dragOnto(win, rowIn(win, 'd1', drawnId), win.getByTestId('date-name-d2'));
  const note = win.getByTestId('date-note');
  await expect(note).toContainText('measured again', { timeout: 60_000 });
  await testInfo.attach('note after the move', { body: (await note.innerText()) || '' });
  await measureTree(win, 'd2');
  await expect(
    folderIn(win, 'd2', 'Piles').locator('..').locator(`[data-id="${drawnId}"]`),
  ).toHaveCount(1);
  await expect(rowIn(win, 'd1', drawnId)).toHaveCount(0);
  await expect(await measureSaved(win)).toContainText('Unsaved changes');
  await win.screenshot({ path: testInfo.outputPath('measurement-dates-moved.png') });
  await (await measureSaved(win)).getByTestId('survey-list-save').click();
  await expect(win.getByTestId('survey-saved')).toContainText('Measurements saved.');
  const moved = (await onDisk(file)).find((m) => m.id === drawnId);
  expect(moved?.scope).toEqual({ kind: 'survey', capture: 'd2' });
  expect(moved?.folder).toBe('Piles');
  expect(moved?.source).toEqual({ layer: 'dsm-d2' });
  const zAfter = (moved?.points ?? []).map((p) => p[2]);
  await testInfo.attach('heights', {
    body: JSON.stringify({ from: drawn?.source, to: moved?.source, zBefore, zAfter }),
  });
  expect(zAfter).toHaveLength(zBefore.length);
  expect(
    zAfter.some((z, i) => z - (zBefore[i] ?? z) > 0.5),
    `heights on the second survey (${zAfter.join(', ')}) stand over the first (${zBefore.join(', ')})`,
  ).toBe(true);

  // (4) onto the third survey, not prepared: refused with Prepare surfaces, nothing moved
  await fold(win, 'd1');
  await fold(win, 'd3');
  await dragOnto(win, rowIn(win, 'd2', 'pile-d2'), win.getByTestId('date-name-d3'));
  await expect(note.getByTestId('date-note-prepare')).toBeVisible();
  await expect(rowIn(win, 'd2', 'pile-d2')).toHaveCount(1);
  expect((await onDisk(file)).find((m) => m.id === 'pile-d2')?.scope).toEqual({
    kind: 'survey',
    capture: 'd2',
  });

  // (4b) without a drag: the row menu's Move to date (the other dates only) takes it back
  await note.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(note).toHaveCount(0);
  await measureTree(win, 'd2');
  await rowIn(win, 'd2', drawnId).click({ button: 'right' });
  await win.getByTestId('ctx-item-measure.moveToDate').click();
  await expect(win.getByTestId('measure-date-to-d3')).toBeVisible();
  await expect(win.getByTestId('measure-date-to-d2')).toHaveCount(0);
  await win.getByTestId('measure-date-to-d1').click();
  await expect(note).toContainText('measured again', { timeout: 60_000 });
  await measureTree(win, 'd1');
  await expect(rowIn(win, 'd1', drawnId)).toHaveCount(1);
  await expect(rowIn(win, 'd2', drawnId)).toHaveCount(0);

  // (5) an antenna measurement stays on the date it was picked on (the last note put away first:
  // it sits over the top of the list, where the drag is held)
  await note.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(note).toHaveCount(0);
  await fold(win, 'd2');
  await measureTree(win, 'd1');
  await dragOnto(win, rowIn(win, 'd1', 'ant-d1'), win.getByTestId('date-name-d2'));
  await expect(note).toContainText('Antenna measurements stay on the date they were picked on.');
  await expect(rowIn(win, 'd1', 'ant-d1')).toHaveCount(1);

  // (6) the first survey's DSM dragged to the third survey takes its measurement along
  await note.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(note).toHaveCount(0);
  const dsm = win.getByTestId('date-folder-d1').getByTestId('tree-row-dsm-d1');
  await fold(win, 'd2');
  await fold(win, 'd3');
  await dragOnto(win, dsm, win.getByTestId('date-name-d3'));
  await expect(dsm).toHaveCount(0);
  await measureTree(win, 'd3');
  await expect(win.getByTestId('date-folder-d3').getByTestId('tree-row-dsm-d1')).toHaveCount(1);
  await expect(rowIn(win, 'd3', 'pile-d1')).toHaveCount(1);
  await expect(rowIn(win, 'd1', 'pile-d1')).toHaveCount(0);
  await expect(rowIn(win, 'd1', 'ant-d1')).toHaveCount(1);
  await win.screenshot({ path: testInfo.outputPath('measurement-dates-followed.png') });
});
