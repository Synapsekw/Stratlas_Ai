/**
 * The volumetric report's rebuilt layout (plan 2026-11-20) in the real app, proven on the saved
 * pictures and the exported files, on copies of the synthetic quarry demo.
 *
 * The first test reshapes the copy before it is opened: one stockpile is filed under the earliest
 * survey date, one stockpile's outline is drawn a second time as a pile of its own, and a pile
 * that was never computed lies across the corner of the survey. The report then lists six piles
 * with five measured; the uncomputed pile's row and card read "Not computed" and its card still
 * has its photos; the overlap warning is printed once and names the two piles; the 3D picture of
 * the pile filed under the earliest date is taken on the latest date and shows its box; and the
 * ground the survey does not cover is paper in the top-down pictures, not black. The offline HTML
 * file lists the uncomputed pile too.
 *
 * The second test runs in the smallest window (1100 x 700): the progress card fits it, Stop ends
 * a capture after the current picture, nothing is saved (no file, no save dialog, the pictures
 * taken before are untouched) and the person's own view of the stage comes back.
 *
 * Off-screen, zero network, pipeline Python needed.
 */
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { openOffline } from './htmlOffline';
import { stageMode, volumesView } from './island';
import { pdfText } from './pdf';
import { openDemo } from './surveyJobs';
import type { SurveyDemoProject } from './surveyFixtures';
import {
  answerSaves,
  cardLog,
  isBlack,
  isPaper,
  probeJpeg,
  readFrame,
  saveDialogs,
  secondsPerPicture,
  viewsDir,
  watchCard,
  type Frame,
  type FrameView,
} from './volumetricCapture';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

/** The quarry's survey covers 512 m about its origin (survey_synth.py `quarry_site`). */
const SURVEY = { e0: 552_744, n0: 2_332_744, e1: 553_256, n1: 2_333_256 };
const LATEST = 'm3';
/** The pile that is filed under the earliest date in the reshaped copy. */
const EARLY = { id: 'm-sp3', label: 'Stockpile SP3' };
/** One stockpile's outline drawn again as a pile of its own. */
const TWICE = {
  of: 'm-sp2',
  ofLabel: 'Stockpile SP2',
  id: 'm-sp2b',
  label: 'Stockpile SP2 recount',
};
/** A pile nobody computed, across the north-east corner of the survey. */
const UNCOMPUTED = { id: 'm-edge', label: 'Stockpile SP4' };

/** Text without spaces, lower case: pdfjs splits the report's runs. */
const flat = (s: string) => s.replace(/\s+/g, '').toLowerCase();
const times = (text: string, part: string) => text.split(part).length - 1;

const stripOf = (win: Page): Locator => win.getByRole('region', { name: 'Dates strip' });

interface MeasurementsFile {
  measurements: {
    id: string;
    label: string;
    scope?: unknown;
    points: [number, number, number][];
    material?: string;
    items: unknown[];
    results: unknown[];
  }[];
}

/** Reshape the copied demo's measurements (see the file comment). */
async function reshape(dir: string): Promise<void> {
  const file = join(dir, 'survey', 'measurements.json');
  const data = JSON.parse(await readFile(file, 'utf8')) as MeasurementsFile;
  const of = (id: string) => {
    const m = data.measurements.find((x) => x.id === id);
    if (!m) throw new Error(`the quarry demo has no ${id}`);
    return m;
  };
  of(EARLY.id).scope = { kind: 'survey', capture: 'm1' };
  const twice = of(TWICE.of);
  data.measurements.push({ ...twice, id: TWICE.id, label: TWICE.label });
  // no material, no base and no result: drawn and never computed
  const bare = { ...twice };
  delete bare.material;
  const { e1, n1 } = SURVEY;
  data.measurements.push({
    ...bare,
    id: UNCOMPUTED.id,
    label: UNCOMPUTED.label,
    points: [
      [e1 - 20, n1 - 20, 140],
      [e1 + 20, n1 - 20, 140],
      [e1 + 20, n1 + 20, 140],
      [e1 - 20, n1 + 20, 140],
    ],
    items: [],
    results: [],
  });
  await writeFile(file, JSON.stringify(data, null, 2));
}

/** Open the quarry and wait until every survey date is prepared and has its figures. */
async function opened(win: Page, p: SurveyDemoProject): Promise<void> {
  await openDemo(win, p.name, p.id);
  const view = await volumesView(win);
  await expect(stripOf(win).locator('[data-survey][data-state="ready"]')).toHaveCount(3, {
    timeout: 360_000,
  });
  await expect(stripOf(win).locator('circle.ds-dot')).toHaveCount(3, { timeout: 240_000 });
  await expect(view.getByTestId('volumes-site-total')).toBeVisible({ timeout: 120_000 });
}

/** Reports, Customer reports, Open volumetric report: the editor with its preview. */
async function openEditor(win: Page): Promise<Locator> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Reports' }).first().click();
  const block = win.getByTestId('customer-reports');
  await expect(block).toBeVisible({ timeout: 60_000 });
  await block.getByTestId('open-volumetric-report').click();
  const editor = win.getByTestId('volumetric-editor');
  await expect(editor).toBeVisible();
  await expect(editor.getByTestId('volumetric-preview')).toBeVisible({ timeout: 180_000 });
  return editor;
}

/** Wait for the export's saved toast and return the file's path. */
async function exported(app: ElectronApplication, win: Page): Promise<string> {
  const msg = win.getByTestId('export-toast-message').last();
  await expect(msg).toContainText(/saved to|not |could not|failed|stopped/i, { timeout: 600_000 });
  await expect(msg).toContainText('saved to');
  await win.getByRole('button', { name: 'Dismiss' }).last().click();
  return (await saveDialogs(app)).last;
}

/** A site point as fractions of a top-down picture's width and height, from the top left. */
const at = (extent: readonly number[], e: number, n: number): [number, number] => {
  const [e0 = 0, n0 = 0, e1 = 1, n1 = 1] = extent;
  return [(e - e0) / (e1 - e0), (n1 - n) / (n1 - n0)];
};

const viewOf = (frame: Frame, want: Partial<FrameView>): FrameView => {
  const v = frame.views.find((x) =>
    (Object.keys(want) as (keyof FrameView)[]).every((k) => x[k] === want[k]),
  );
  if (!v) throw new Error(`no picture for ${JSON.stringify(want)}`);
  return v;
};

test('piles without a volume, an overlap, a pile filed under an earlier date and ground outside the survey', async ({
  app,
  dataRoot,
  quarryProject,
  win,
}) => {
  test.setTimeout(1_500_000);
  const p = quarryProject;
  await reshape(p.dir);
  const out = join(dataRoot.base, 'out');
  await mkdir(out, { recursive: true });
  await answerSaves(app, out);
  await opened(win, p);

  // ---- the preview: every pile listed, the uncomputed one too, and the overlap warning
  const editor = await openEditor(win);
  const preview = editor.getByTestId('volumetric-preview');
  const cover = preview.locator('.vr-page-cover').first();
  await expect(cover.locator('.vr-title-meta')).toContainText('6 piles, 5 measured', {
    timeout: 240_000,
  });
  await expect(preview.locator('.vr-table tbody tr')).toHaveCount(6);
  const row = preview.locator(`.vr-table tr[data-pile="${UNCOMPUTED.id}"]`);
  await expect(row).toHaveClass(/is-uncomputed/);
  await expect(row).toContainText(UNCOMPUTED.label);
  await expect(row.locator('.vr-col-none')).toHaveText('Not computed');
  await expect(preview.locator('.vr-table tr.is-uncomputed')).toHaveCount(1);
  // both outlines of the pile drawn twice have a volume, so the warning names them, once
  for (const id of [TWICE.of, TWICE.id])
    await expect(preview.locator(`.vr-table tr[data-pile="${id}"]`)).not.toHaveClass(
      /is-uncomputed/,
    );
  const notice = preview.locator('[data-notice="overlap"]');
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText(TWICE.ofLabel);
  await expect(notice).toContainText(TWICE.label);
  await expect(notice).toContainText(
    'overlap, so the site total may count the same material twice.',
  );
  // the uncomputed pile has its card, reading "Not computed"
  const card = preview.locator(`.vr-pile[data-pile="${UNCOMPUTED.id}"]`);
  await expect(card).toHaveCount(1);
  await expect(card).toHaveClass(/is-uncomputed/);
  await expect(card.locator('.vr-pile-volume')).toHaveText('Not computed');

  // ---- Export PDF: the capture, then the file
  await watchCard(win);
  await editor.getByRole('button', { name: 'Export PDF' }).click();
  const pdfFile = await exported(app, win);
  // kept with the run's output, to be looked at
  await copyFile(pdfFile, test.info().outputPath('volumetric-report.pdf'));
  const log = await cardLog(win);
  expect(log.some((c) => c.what.endsWith(`: ${UNCOMPUTED.label}`))).toBe(true);
  const pace = secondsPerPicture(log);
  const paceText = `${String(pace.pictures)} pictures: ${String(pace.all)} s each (site ${String(pace.site)} s, pile ${String(pace.pile)} s)`;
  test.info().annotations.push({ type: 'seconds-per-picture', description: paceText });
  process.stdout.write(`[e2e] volumetric report capture, ${paceText}\n`);

  const frame = await readFrame(p.dir);
  if (!frame) throw new Error('the export saved no frame.json');
  const dir = viewsDir(p.dir);
  const keep = test.info().outputPath('pictures');
  await mkdir(keep, { recursive: true });
  const kept = async (v: FrameView, name: string) => {
    await copyFile(join(dir, v.file), join(keep, `${name}.jpg`));
    return join(dir, v.file);
  };

  // ---- (b) the pile filed under the earliest date: its 3D picture is of the latest date and
  // shows the pile's box, as the picture of a pile filed under the latest date does
  const pile3d = frame.views.filter((v) => v.kind === 'pile-3d');
  expect(pile3d.length).toBeGreaterThanOrEqual(5);
  expect(pile3d.map((v) => v.capture)).toEqual(pile3d.map(() => LATEST));
  const early3d = viewOf(frame, { kind: 'pile-3d', pile: EARLY.id });
  const site3d = viewOf(frame, { kind: '3d', capture: LATEST });
  const late3d = viewOf(frame, { kind: 'pile-3d', pile: 'm-sp1' });
  const early = await probeJpeg(win, await kept(early3d, 'pile-3d-filed-under-the-earliest-date'));
  const late = await probeJpeg(win, await kept(late3d, 'pile-3d-filed-under-the-latest-date'));
  const site = await probeJpeg(win, await kept(site3d, 'site-3d-latest-date'));
  expect([early.width, early.height]).toEqual([800, 600]);
  const boxText = `early ${early.red.toFixed(3)}, late ${late.red.toFixed(3)}, site 3D ${site.red.toFixed(3)}`;
  test.info().annotations.push({ type: 'pile-box-share', description: boxText });
  process.stdout.write(`[e2e] share of the picture the pile box's surface takes: ${boxText}\n`);
  expect(late.red, 'a pile on the latest date shows its box').toBeGreaterThan(0.15);
  expect(early.red, 'the pile filed under the earliest date shows its box too').toBeGreaterThan(
    0.15,
  );
  expect(site.red, 'the site 3D view has no box').toBeLessThan(0.01);

  // ---- (a) ground the survey does not cover is paper, never black
  const outside: [number, number][] = [
    [SURVEY.e1 + 30, SURVEY.n1 + 30],
    [SURVEY.e1 + 40, SURVEY.n1 - 60],
    [SURVEY.e1 - 200, SURVEY.n1 + 30],
  ];
  const inside: [number, number][] = [
    [553_000, 2_333_000],
    [552_900, 2_333_200],
  ];
  expect(frame.extent[2], 'the frame reaches past the survey').toBeGreaterThan(SURVEY.e1 + 40);
  expect(frame.extent[3]).toBeGreaterThan(SURVEY.n1 + 30);
  for (const kind of ['photo', 'elevation'] as const) {
    const v = viewOf(frame, { kind, capture: LATEST });
    const pts = [...outside, ...inside].map(([e, n]) => at(frame.extent, e, n));
    const probe = await probeJpeg(win, await kept(v, `site-${kind}-latest-date`), pts);
    outside.forEach((_, i) => {
      const c = probe.points[i] ?? [0, 0, 0];
      expect(isPaper(c), `${kind}: outside the survey is paper, got ${c.join(',')}`).toBe(true);
    });
    inside.forEach((_, i) => {
      const c = probe.points[outside.length + i] ?? [0, 0, 0];
      expect(isPaper(c), `${kind}: the survey itself is drawn, got ${c.join(',')}`).toBe(false);
      expect(isBlack(c), `${kind}: the survey is not black, got ${c.join(',')}`).toBe(false);
    });
    expect(probe.black, `${kind}: no black region`).toBeLessThan(0.01);
    expect(probe.paper, `${kind}: the uncovered ground is paper`).toBeGreaterThan(0.05);
  }
  // the uncomputed pile's own photo lies across the survey's corner: paper on three quarters
  const edgePhoto = viewOf(frame, { kind: 'pile-photo', pile: UNCOMPUTED.id, capture: LATEST });
  if (!edgePhoto.extent) throw new Error('a pile photo gives its extent');
  const edge = await probeJpeg(win, await kept(edgePhoto, 'pile-photo-across-the-corner'), [
    [0.9, 0.1],
    [0.1, 0.1],
    [0.9, 0.9],
    [0.1, 0.9],
  ]);
  for (const i of [0, 1, 2])
    expect(isPaper(edge.points[i] ?? [0, 0, 0]), `corner ${String(i)} is paper`).toBe(true);
  expect(isPaper(edge.points[3] ?? [0, 0, 0]), 'the survey corner is drawn').toBe(false);
  expect(edge.black, 'no black in the pile photo').toBeLessThan(0.01);
  expect(frame.views.filter((v) => v.kind === 'pile-photo')).toHaveLength(12);

  // ---- the uncomputed pile's card still has its photos
  await expect(card.locator('.vr-pile-pic img')).not.toHaveCount(0, { timeout: 60_000 });
  expect(await card.locator('.vr-pile-pic img').count()).toBeGreaterThanOrEqual(2);
  await win.screenshot({ path: test.info().outputPath('editor-after-export.png') });

  // ---- the PDF
  const pdf = await pdfText(
    pdfFile,
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  expect(pdf.count, 'cover, overview, three pile pages, change').toBe(6);
  const page = (n: number) => flat(pdf.text.get(n) ?? '');
  const all = Array.from({ length: pdf.count }, (_, i) => page(i + 1)).join(' ');
  expect(page(1)).toContain(flat('6 piles, 5 measured'));
  expect(page(1)).toContain(flat(UNCOMPUTED.label));
  expect(page(1)).toContain(flat('Not computed'));
  expect(times(all, flat('so the site total may count the same material twice')), 'once').toBe(1);
  expect(page(1)).toContain(flat(`${TWICE.label} overlap`));
  // the uncomputed pile ranks last: the third pile page, with "Not computed" on its card
  expect(page(5)).toContain(flat('Piles 5 to 6 of 6'));
  expect(page(5)).toContain(flat(UNCOMPUTED.label));
  expect(page(5)).toContain(flat('Not computed'));
  // every card's 3D picture is captioned with the latest survey date
  for (const n of [3, 4]) expect(times(page(n), flat('3D view, 31 Mar 2026'))).toBe(2);
  expect(all).not.toContain(flat('3D view, 31 Jan'));
  expect(all).not.toContain(flat('3D view, 28 Feb'));

  // ---- the offline HTML lists the uncomputed pile and prints the same pages
  await editor.getByRole('button', { name: 'Export HTML' }).click();
  const htmlFile = await exported(app, win);
  expect(htmlFile).toMatch(/\.html$/);
  const offline = await openOffline(app, htmlFile);
  try {
    const d = offline.page;
    await expect(d.locator('.vr-d-band h1')).toBeVisible({ timeout: 30_000 });
    const listed = d.locator(`.vr-d-list-row[data-pile="${UNCOMPUTED.id}"]`);
    await expect(listed).toContainText(UNCOMPUTED.label);
    await expect(listed.locator('.vr-d-row-amount')).toHaveText('Not computed');
    await expect(d.locator('.vr-d-list-row')).toHaveCount(6);
    expect(await d.locator('.vr-print .vr-page').count()).toBeGreaterThanOrEqual(5);
    await expect(d.locator('.vr-print .vr-page')).toHaveCount(pdf.count);
    await expect(d.locator('.vr-print [data-notice="overlap"]')).toHaveCount(1);
    expect(await offline.requests(), 'requests from the offline HTML').toEqual([]);
  } finally {
    await offline.close();
  }
});

test.describe('in the smallest window', () => {
  test.use({ appEnv: { ...PIPELINE_ENV, QUADRION_WINDOW_SIZE: '1100x700' } });

  /** The mean difference of two screenshots of the same size, 0 to 255 per channel. */
  async function difference(win: Page, a: Buffer, b: Buffer): Promise<number> {
    return win.evaluate(
      async ([x, y]) => {
        const read = async (b64: string) => {
          const raw = atob(b64);
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          const g = c.getContext('2d');
          if (!g) throw new Error('no 2D canvas');
          g.drawImage(bmp, 0, 0);
          return g.getImageData(0, 0, bmp.width, bmp.height);
        };
        const [p, q] = await Promise.all([read(x ?? ''), read(y ?? '')]);
        if (p.width !== q.width || p.height !== q.height) return 255;
        let sum = 0;
        for (let i = 0; i < p.data.length; i++)
          sum += Math.abs((p.data[i] ?? 0) - (q.data[i] ?? 0));
        return sum / p.data.length;
      },
      [a.toString('base64'), b.toString('base64')],
    );
  }

  test('the progress card fits, Stop saves nothing and the view comes back', async ({
    app,
    dataRoot,
    quarryProject,
    win,
  }) => {
    test.setTimeout(1_500_000);
    const p = quarryProject;
    const out = join(dataRoot.base, 'out');
    await mkdir(out, { recursive: true });
    await answerSaves(app, out);
    await opened(win, p);
    expect(await win.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700]);

    // ---- a view of the person's own: the 3D stage on the middle date, zoomed in
    await stageMode(win, '3D');
    const canvas = win.locator('[data-scene-view] canvas').first();
    await expect(canvas).toBeVisible();
    const strip = stripOf(win);
    const settled = async () => {
      let before = await canvas.screenshot();
      await expect
        .poll(
          async () => {
            const now = await canvas.screenshot();
            const d = await difference(win, before, now);
            before = now;
            return d;
          },
          { timeout: 120_000, intervals: [1500] },
        )
        .toBeLessThan(0.2);
      return before;
    };
    const fresh = await settled();
    await strip.locator('[data-survey="m2"]').click();
    await expect(strip.locator('[data-survey="m2"]')).toHaveAttribute('aria-current', 'date');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no stage canvas');
    await win.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.55);
    for (let i = 0; i < 4; i++) await win.mouse.wheel(0, -240);
    await win.mouse.move(box.x + 20, box.y + box.height - 20);
    const mine = await settled();
    await win.screenshot({ path: test.info().outputPath('view-before.png') });
    expect(await difference(win, fresh, mine), 'the view was changed').toBeGreaterThan(2);
    const backOnStage = async () => {
      await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).first().click();
      await expect(canvas).toBeVisible();
      await expect(strip.locator('[data-survey="m2"]')).toHaveAttribute('aria-current', 'date');
      await win.mouse.move(box.x + 20, box.y + box.height - 20);
      return settled();
    };

    // ---- Export PDF with no pictures, stopped while they are taken
    let editor = await openEditor(win);
    const note = editor.getByTestId('volumetric-pictures');
    await expect(note).toContainText('Pictures are taken when you export.');
    const progress = win.getByTestId('volumetric-picture-progress');
    const stop = progress.getByRole('button', { name: 'Stop taking pictures' });
    const stopped = win.getByTestId('export-toast-message').last();

    await watchCard(win);
    await editor.getByRole('button', { name: 'Export PDF' }).click();
    await expect(progress).toBeVisible({ timeout: 60_000 });
    await expect(progress.locator('.vre-progress-count')).toHaveText(/^Picture [2-9] of \d+$/, {
      timeout: 120_000,
    });
    // the card fits the window: all of it in view, Stop reachable, nothing scrolls
    const fits = await progress.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const b = [...el.querySelectorAll('button')].find((x) =>
        x.textContent.includes('Stop taking pictures'),
      );
      const s = b?.getBoundingClientRect();
      const hit = s ? document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2) : null;
      return {
        inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        stopReached: b !== undefined && hit !== null && (hit === b || b.contains(hit)),
        scrolls: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
        page: document.documentElement.scrollHeight > innerHeight + 1,
      };
    });
    expect(fits).toEqual({ inside: true, stopReached: true, scrolls: false, page: false });
    await win.screenshot({ path: test.info().outputPath('progress-card-1100x700.png') });
    await stop.click();
    await expect(progress).toHaveCount(0, { timeout: 120_000 });
    await expect(stopped).toContainText('Taking them was stopped.', { timeout: 60_000 });
    await win.getByRole('button', { name: 'Dismiss' }).last().click();
    let log = await cardLog(win);
    expect(log.some((c) => c.phase === 'stopping' && c.what.startsWith('Stopping after'))).toBe(
      true,
    );
    expect(
      log.some((c) => c.phase === 'writing'),
      'the file was never written',
    ).toBe(false);
    expect((await saveDialogs(app)).count, 'no save dialog').toBe(0);
    expect(await readdir(out), 'no file').toEqual([]);
    expect(await readFrame(p.dir), 'no pictures saved').toBeNull();
    // the editor is back, still without pictures
    await expect(editor).toBeVisible({ timeout: 60_000 });
    await expect(note).toContainText('Pictures are taken when you export.');
    // and the stage shows the person's view again
    const afterStop = await backOnStage();
    await win.screenshot({ path: test.info().outputPath('view-after-stop.png') });
    expect(await difference(win, mine, afterStop), 'the view after Stop').toBeLessThan(1);

    // ---- "Take them now" takes the whole set; the view comes back after a full run too
    await win.locator('.sb-nav .nav-item', { hasText: 'Reports' }).first().click();
    await expect(editor).toBeVisible({ timeout: 60_000 });
    await note.getByRole('button', { name: 'Take them now' }).click();
    await expect(progress).toBeVisible({ timeout: 60_000 });
    await expect(progress).toHaveCount(0, { timeout: 600_000 });
    await expect(note, 'the pictures are current').toHaveCount(0, { timeout: 60_000 });
    expect((await saveDialogs(app)).count, 'pictures alone ask for no file').toBe(0);
    const frameFile = join(viewsDir(p.dir), 'frame.json');
    const first = await readFrame(p.dir);
    if (!first) throw new Error('Take them now saved no frame.json');
    const afterRun = await backOnStage();
    expect(await difference(win, mine, afterRun), 'the view after a full run').toBeLessThan(1);

    // ---- the pictures made stale, then an export stopped: the saved set is untouched
    await win.locator('.sb-nav .nav-item', { hasText: 'Reports' }).first().click();
    await expect(editor).toBeVisible({ timeout: 60_000 });
    await editor.getByRole('button', { name: 'Back to the reports' }).click();
    await expect(editor).toHaveCount(0);
    await writeFile(frameFile, JSON.stringify({ ...first, fingerprint: 'changed-since' }));
    const before = {
      frame: await readFile(frameFile, 'utf8'),
      files: await Promise.all(
        first.views.map(async (v) => (await stat(join(viewsDir(p.dir), v.file))).mtimeMs),
      ),
    };
    editor = await openEditor(win);
    await expect(editor.getByTestId('volumetric-pictures')).toContainText(
      'The data changed since the pictures were taken.',
      { timeout: 120_000 },
    );
    await watchCard(win);
    await editor.getByRole('button', { name: 'Export PDF' }).click();
    await expect(progress.locator('.vre-progress-count')).toHaveText(/^Picture [2-9] of \d+$/, {
      timeout: 120_000,
    });
    await stop.click();
    await expect(progress).toHaveCount(0, { timeout: 120_000 });
    await expect(stopped).toContainText('Taking them was stopped.', { timeout: 60_000 });
    log = await cardLog(win);
    expect(log.some((c) => c.phase === 'writing')).toBe(false);
    expect((await saveDialogs(app)).count, 'no save dialog').toBe(0);
    expect(await readdir(out), 'no file').toEqual([]);
    expect(await readFile(frameFile, 'utf8'), 'the previous frame.json is untouched').toBe(
      before.frame,
    );
    expect(
      await Promise.all(
        first.views.map(async (v) => (await stat(join(viewsDir(p.dir), v.file))).mtimeMs),
      ),
      'the previous pictures are untouched',
    ).toEqual(before.files);
    await expect(editor).toBeVisible({ timeout: 60_000 });
    await expect(editor.getByTestId('volumetric-pictures')).toContainText(
      'The data changed since the pictures were taken.',
    );
  });
});
