/**
 * The dates chart strip and the timelapse (volumetrics redesign, spec section 5, boards 1, 2, 6) in
 * the real app, on the synthetic quarry demo: three monthly surveys, prepared quietly on open
 * (`autoPrepareSurfaces`), three piles of three materials and the pit. Under the stage, labelled
 * "Survey dates chart" (never "Timeline", the footage's): a marker per survey, the site's volume
 * stacked by material, Volume | Tonnes | Cut & fill; a marker click or a playhead drag moves the
 * date in focus, and the notch, the sidebar's Stockpiles group, the pile labels in 3D and the
 * Volumes tab follow it; Compare draws the band with its change and brackets that move it; Fit
 * zooms to the band; collapse is remembered per project. Play steps through every survey, the
 * notch reading "Playing · …" and the floats standing in the bottom corners, Esc stops it, loop
 * wraps. A selected pile draws its own line, and its chip clears it. In a project with video the
 * bottom bar offers Dates | Footage and remembers the choice (the tank farm demo). The strip and
 * the floats leave the view's centre free at 1100 x 700. Off-screen, zero network, pipeline
 * Python needed.
 */
import type { Locator, Page } from '@playwright/test';
import {
  DEMO_FOLDER,
  expect,
  hasPipelinePython,
  PIPELINE_ENV,
  test,
  VENV_PYTHON,
} from './fixtures';
import { islandDate, stockpileTree, volumesView } from './island';
import { openDemo } from './surveyJobs';
import type { SurveyDemoProject } from './surveyFixtures';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

/** The quarry's surveys, oldest first, and their dates as the strip labels them. */
const DATES = ['m1', 'm2', 'm3'] as const;
const LABEL = { m1: '31 Jan 2026', m2: '28 Feb 2026', m3: '31 Mar 2026' } as const;
const SP1_ID = 'm-sp1';
const SP3 = 'Stockpile SP3';

const stripOf = (win: Page): Locator => win.getByRole('region', { name: 'Survey dates chart' });

/**
 * Open the quarry with the Volumes tab up (it works out every pile's dates) and wait until every
 * survey's surface is prepared and the strip draws the site's total on each of them.
 */
async function opened(win: Page, p: SurveyDemoProject): Promise<Locator> {
  await openDemo(win, p.name, p.id);
  await volumesView(win);
  const strip = stripOf(win);
  await expect(strip).toBeVisible();
  await expect(strip.locator('[data-survey][data-state="ready"]')).toHaveCount(3, {
    timeout: 360_000,
  });
  await expect(strip.locator('circle.ds-dot')).toHaveCount(3, { timeout: 240_000 });
  return strip;
}

/** The survey the strip has in focus (its marker is the current date). */
async function focused(strip: Locator): Promise<string | null> {
  return strip.locator('[data-survey][aria-current="date"]').getAttribute('data-survey');
}

/** Focus a survey with a click on its marker, and wait for the strip to show it in focus. */
async function focusOn(strip: Locator, capture: (typeof DATES)[number]): Promise<void> {
  await strip.locator(`[data-survey="${capture}"]`).click();
  await expect(strip.locator(`[data-survey="${capture}"]`)).toHaveAttribute('aria-current', 'date');
}

/** The page x of a survey's marker (the button stands centred on its date). */
async function markerX(strip: Locator, capture: string): Promise<number> {
  const box = await strip.locator(`[data-survey="${capture}"] .ds-mk-dot`).boundingBox();
  if (!box) throw new Error(`no marker for ${capture}`);
  return box.x + box.width / 2;
}

/** A label's text in the 3D view (the pile's name and its figure on the date in focus). */
const label3d = (win: Page, id: string): Locator =>
  win.locator(`[data-scene-view] .sv-labels .sv-label[data-id="${id}"]`).first();

test('two or more dates show the strip; its markers match the survey dates; Volume, Tonnes and Cut & fill; collapse is remembered', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  const strip = await opened(win, quarryProject);

  // a marker per survey, oldest first, labelled with its date; the latest in focus
  const markers = strip.locator('[data-survey]');
  expect(await markers.evaluateAll((els) => els.map((e) => e.getAttribute('data-survey')))).toEqual(
    [...DATES],
  );
  for (const d of DATES)
    await expect(strip.locator(`[data-survey="${d}"]`)).toContainText(LABEL[d]);
  expect(await focused(strip)).toBe('m3');
  // month gridlines along the top
  await expect(strip.locator('[data-month]')).not.toHaveCount(0);

  // Volume: the site stacked by material, each in the legend
  await expect(strip).toHaveAttribute('data-mode', 'volume');
  const stacks = await strip
    .locator('g[data-stack]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-stack')));
  expect(stacks).toEqual(expect.arrayContaining(['crushed-20', 'washed-sand', 'base-course']));
  const legend = strip.getByTestId('strip-legend');
  for (const name of ['Crushed rock 20 mm', 'Washed sand', 'Base course'])
    await expect(legend).toContainText(name);
  // the readout: the date in focus, its volume and tonnes, the change since the survey before
  const readout = strip.getByTestId('strip-readout');
  await expect(readout).toContainText(LABEL.m3);
  await expect(readout).toContainText('m³');
  await expect(readout).toContainText('vs 28 Feb 2026');

  // Tonnes: the same stack in tonnes
  await strip.getByRole('button', { name: 'Tonnes', exact: true }).click();
  await expect(strip).toHaveAttribute('data-mode', 'tonnes');
  await expect(strip.locator('.pc-axis-title').first()).toHaveText('Tonnes (t)');
  await expect(strip.locator('g[data-stack]')).not.toHaveCount(0);

  // Cut & fill: a diverging bar between each pair of consecutive surveys
  await strip.getByRole('button', { name: 'Cut & fill', exact: true }).click();
  await expect(strip).toHaveAttribute('data-mode', 'cutFill');
  await expect(strip.locator('g[data-bar]')).toHaveCount(2, { timeout: 240_000 });
  expect(
    await strip
      .locator('g[data-bar]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-bar'))),
  ).toEqual(['m1>m2', 'm2>m3']);
  await expect(strip.locator('g[data-stack]')).toHaveCount(0);
  await strip.getByRole('button', { name: 'Volume', exact: true }).click();
  await expect(strip).toHaveAttribute('data-mode', 'volume');

  // collapse: the bar alone, remembered for this project across a reload
  const collapse = strip.getByTestId('strip-collapse');
  await collapse.click();
  await expect(strip).toHaveAttribute('data-collapsed', '');
  await expect(strip.getByTestId('strip-chart')).toHaveCount(0);
  await expect(collapse).toHaveAttribute('aria-expanded', 'false');
  expect(
    await win.evaluate(() => localStorage.getItem('stratlas.datesStrip.collapsed') ?? ''),
  ).toContain(quarryProject.id);
  await win.reload();
  await expect(
    win.locator('[data-testid="project-card"], [data-scene-view] canvas').first(),
  ).toBeVisible();
  if (await win.getByTestId('project-card').first().isVisible())
    await openDemo(win, quarryProject.name, quarryProject.id);
  await expect(stripOf(win)).toHaveAttribute('data-collapsed', '');
  await stripOf(win).getByTestId('strip-collapse').click();
  await expect(stripOf(win).getByTestId('strip-chart')).toBeVisible();
  await expect(stripOf(win)).not.toHaveAttribute('data-collapsed', '');
});

test('a marker click and a playhead drag move the date in focus: the notch, the sidebar Stockpiles, the pile labels and the Volumes tab follow', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  const strip = await opened(win, quarryProject);
  const view = await volumesView(win);
  const header = view.getByTestId('volumes-header');
  const group = await stockpileTree(win);
  const head = win.getByTestId('tree-group-stockpiles').locator('.gcount');
  const sp3 = group.getByTestId('measure-row').filter({ hasText: SP3 }).locator('.tm');

  // on the latest survey
  await expect(islandDate(win)).toContainText('31 Mar');
  await expect(head).toContainText(LABEL.m3);
  await expect(header.getByTestId('volumes-date')).toContainText('31 Mar');
  await expect(sp3).toContainText('m³');
  const label = label3d(win, SP1_ID);
  await expect(label).toBeVisible({ timeout: 60_000 });
  const on = {
    kpi: await header.getByTestId('volumes-kpi-volume').innerText(),
    label: await label.innerText(),
  };

  // a click on the first marker: everything reads 31 January
  await focusOn(strip, 'm1');
  await expect(islandDate(win)).toContainText('31 Jan');
  await expect(head).toContainText(LABEL.m1);
  await expect(header.getByTestId('volumes-date')).toContainText('31 Jan');
  await expect(header.getByTestId('volumes-kpi-volume')).not.toHaveText(on.kpi);
  // the third pile was first measured in March: no figure on this date
  await expect(sp3).not.toContainText('m³');
  // the first pile's label reads its January figure
  await expect(label).not.toHaveText(on.label);

  // drag the playhead from January to February: the readout follows, the focus lands on February
  const playhead = strip.getByTestId('strip-playhead');
  const box = await playhead.boundingBox();
  if (!box) throw new Error('no playhead');
  const y = box.y + box.height / 2;
  const to = await markerX(strip, 'm2');
  await win.mouse.move(box.x + box.width / 2, y);
  await win.mouse.down();
  await expect(playhead).toHaveAttribute('data-dragging', '');
  await win.mouse.move(to, y, { steps: 12 });
  await expect(strip.getByTestId('strip-readout')).toContainText(LABEL.m2);
  await win.mouse.up();
  await expect(playhead).not.toHaveAttribute('data-dragging', '');
  await expect(strip.locator('[data-survey="m2"]')).toHaveAttribute('aria-current', 'date');
  await expect(playhead).toHaveAttribute('aria-valuetext', LABEL.m2);
  await expect(islandDate(win)).toContainText('28 Feb');
  await expect(head).toContainText(LABEL.m2);
  await expect(header.getByTestId('volumes-date')).toContainText('28 Feb');

  // the arrow keys step the playhead too
  await playhead.focus();
  await win.keyboard.press('ArrowRight');
  await expect(strip.locator('[data-survey="m3"]')).toHaveAttribute('aria-current', 'date');
  await expect(islandDate(win)).toContainText('31 Mar');
  await expect(header.getByTestId('volumes-kpi-volume')).toHaveText(on.kpi);
});

test('Compare shows the band with its change; the brackets move it; Fit zooms to it and back', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  const strip = await opened(win, quarryProject);
  const compare = strip.getByTestId('strip-compare');
  await compare.click();
  await expect(compare).toHaveAttribute('aria-pressed', 'true');

  // the pair: the survey before the one in focus, to it
  const band = strip.getByTestId('strip-band');
  const label = strip.getByTestId('strip-band-label');
  await expect(band).toBeVisible();
  await expect(label).toContainText('28 Feb');
  await expect(label).toContainText('31 Mar');
  await expect(label).toContainText('m³');
  await expect(label.locator('.ds-band-delta')).toHaveText(/^[+−]/);
  const from = strip.getByTestId('strip-bracket-from');
  const to = strip.getByTestId('strip-bracket-to');
  await expect(from).toHaveAccessibleName(`Compare from ${LABEL.m2}`);
  await expect(to).toHaveAccessibleName(`Compare to ${LABEL.m3}`);

  // Fit: the strip zooms to the band, the first survey out of view; again for all surveys
  const fit = strip.getByTestId('strip-fit');
  await expect(fit).toHaveAccessibleName('Fit to the compare range');
  await fit.click();
  await expect(strip.locator('[data-survey="m1"]')).toHaveCount(0);
  await expect(strip.locator('[data-survey]')).toHaveCount(2);
  await expect(fit).toHaveAccessibleName('Fit to all surveys');
  await fit.click();
  await expect(strip.locator('[data-survey]')).toHaveCount(3);

  // drag the From bracket onto January: the band and its change follow
  const before = await label.innerText();
  const fb = await from.boundingBox();
  if (!fb) throw new Error('no bracket');
  const y = fb.y + fb.height / 2;
  await win.mouse.move(fb.x + fb.width / 2, y);
  await win.mouse.down();
  await win.mouse.move(await markerX(strip, 'm1'), y, { steps: 12 });
  await win.mouse.up();
  await expect(from).toHaveAccessibleName(`Compare from ${LABEL.m1}`);
  await expect(label).toContainText('31 Jan');
  await expect(label).not.toHaveText(before);
  // and back by key
  await from.focus();
  await win.keyboard.press('ArrowRight');
  await expect(from).toHaveAccessibleName(`Compare from ${LABEL.m2}`);

  // Compare off: no band
  await compare.click();
  await expect(compare).toHaveAttribute('aria-pressed', 'false');
  await expect(band).toHaveCount(0);
  await expect(from).toHaveCount(0);
});

test('play steps through every date and stops at the end; the notch says Playing; Esc stops; loop wraps', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  const strip = await opened(win, quarryProject);
  const view = await volumesView(win);
  await focusOn(strip, 'm1');
  // half speed: four seconds a gap, time to see each survey
  const speed = strip.getByRole('button', { name: /^Playback speed/ });
  for (let i = 0; i < 3; i += 1) await speed.click();
  await expect(speed).toHaveText('0.5×');

  const play = strip.getByTestId('strip-play');
  const blend = win.getByTestId('timelapse-blend');
  const totals = win.getByTestId('timelapse-totals');
  await play.click();
  await expect(play).toHaveAccessibleName('Pause');
  await expect(islandDate(win)).toContainText('Playing · ');
  await expect(blend).toBeVisible();
  await expect(blend).toContainText('Between surveys');
  await expect(blend.getByRole('button', { name: 'Crossfade' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(totals).toBeVisible();
  await expect(totals).toContainText('Figures change only at survey dates');
  await expect(totals).toContainText('m³');
  // the Volumes tab shows the last survey passed and says so
  await expect(view.getByTestId('volumes-playback-note')).toBeVisible();
  await expect(view.getByTestId('volumes-date')).toContainText('last survey passed');

  // each survey in turn, then it stops on the last
  await expect.poll(() => focused(strip), { timeout: 20_000 }).toBe('m2');
  await expect.poll(() => focused(strip), { timeout: 20_000 }).toBe('m3');
  await expect(play).toHaveAccessibleName('Play through the survey dates', { timeout: 20_000 });
  await expect(islandDate(win)).not.toContainText('Playing');
  await expect(blend).toHaveCount(0);
  await expect(totals).toHaveCount(0);
  expect(await focused(strip)).toBe('m3');

  // loop: from the last it starts again at the first and carries on past the end
  const loop = strip.getByRole('button', { name: 'Loop', exact: true });
  await loop.click();
  await expect(loop).toHaveAttribute('aria-pressed', 'true');
  await speed.click();
  await speed.click();
  await expect(speed).toHaveText('2×');
  await play.click();
  const seen: string[] = [];
  await expect
    .poll(
      async () => {
        const f = await focused(strip);
        if (f && seen.at(-1) !== f) seen.push(f);
        return seen.join(' ');
      },
      { intervals: [100], timeout: 30_000 },
    )
    .toMatch(/m3 m1/);
  await expect(play).toHaveAccessibleName('Pause');

  // Esc stops it where it is, and the floats go
  await win.keyboard.press('Escape');
  await expect(play).toHaveAccessibleName('Play through the survey dates');
  await expect(islandDate(win)).not.toContainText('Playing');
  await expect(blend).toHaveCount(0);
  await expect(totals).toHaveCount(0);
});

test('a selected pile shows its line over the site total, faded, and the Pile chip clears it', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  const strip = await opened(win, quarryProject);
  const view = await volumesView(win);
  await expect(strip.getByTestId('strip-pile-line')).toHaveCount(0);
  await view.getByTestId('volumes-pile').filter({ hasText: 'Stockpile SP1' }).click();
  await expect(view.getByTestId('pile-panel')).toBeVisible();

  // the pile's own line, a dot on each survey; the site total faded behind it
  const line = strip.getByTestId('strip-pile-line');
  await expect(line).toBeVisible();
  await expect(line.locator('circle.ds-pile-dot')).toHaveCount(3);
  await expect(strip.getByTestId('strip-legend')).toHaveCount(0);
  await expect(strip).toContainText('Stockpile SP1');
  await expect(strip).toContainText('Site total, faded');
  await expect(strip.getByTestId('strip-readout')).toContainText(`${LABEL.m3} · Stockpile SP1`);

  // the chip's ×: back to the site, the pile closed
  await strip.getByTestId('strip-clear-pile').click();
  await expect(line).toHaveCount(0);
  await expect(strip.getByTestId('strip-legend')).toBeVisible();
  await expect(view.getByTestId('pile-panel')).toHaveCount(0);
  await expect(view.getByTestId('volumes-inventory')).toBeVisible();
});

test.describe('the smallest window, 1100 x 700', () => {
  test.use({ appEnv: { ...PIPELINE_ENV, QUADRION_WINDOW_SIZE: '1100x700' } });

  test('the strip and the timelapse floats leave the view free while playing', async ({
    quarryProject,
    win,
  }) => {
    test.setTimeout(600_000);
    const strip = await opened(win, quarryProject);
    await focusOn(strip, 'm1');
    const speed = strip.getByRole('button', { name: /^Playback speed/ });
    for (let i = 0; i < 3; i += 1) await speed.click();
    await expect(speed).toHaveText('0.5×');
    await strip.getByTestId('strip-play').click();
    const blend = win.getByTestId('timelapse-blend');
    const totals = win.getByTestId('timelapse-totals');
    await expect(blend).toBeVisible();
    await expect(totals).toBeVisible();

    const layout = await win.evaluate(() => {
      const box = (el: Element | null) => {
        const r = el?.getBoundingClientRect();
        return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
      };
      const stage = document.querySelector('.ws > .stage');
      const s = stage?.getBoundingClientRect();
      const cx = s ? s.left + s.width / 2 : 0;
      const cy = s ? s.top + s.height / 2 : 0;
      const hit = document.elementFromPoint(cx, cy);
      return {
        stage: box(stage),
        strip: box(document.querySelector('[role="region"][aria-label="Survey dates chart"]')),
        blend: box(document.querySelector('[data-testid="timelapse-blend"]')),
        totals: box(document.querySelector('[data-testid="timelapse-totals"]')),
        show: box(document.querySelector('[data-testid="stage-show"]')),
        centre: { x: cx, y: cy },
        centreHit: hit?.tagName ?? null,
        centreInView: hit?.closest('[data-scene-view]') !== null,
      };
    });
    expect(layout.stage).not.toBeNull();
    expect(layout.strip).not.toBeNull();
    expect(layout.centreHit, 'the centre click reaches the view').toBe('CANVAS');
    expect(layout.centreInView).toBe(true);
    const { stage, strip: bar, centre } = layout;
    if (!stage || !bar) return;
    // the strip lies under the stage, never over it
    expect(bar.top).toBeGreaterThanOrEqual(stage.bottom - 1);
    const holds = (b: { left: number; right: number; top: number; bottom: number }) =>
      b.left <= centre.x && centre.x <= b.right && b.top <= centre.y && centre.y <= b.bottom;
    for (const [name, b] of [
      ['the blend', layout.blend],
      ['the site totals', layout.totals],
      ['the Show control', layout.show],
    ] as const) {
      if (!b) continue;
      expect(holds(b), `${name} over the view's centre`).toBe(false);
      expect(b.left, `${name} inside the stage`).toBeGreaterThanOrEqual(stage.left - 1);
      expect(b.right, `${name} inside the stage`).toBeLessThanOrEqual(stage.right + 1);
      expect(b.top, `${name} inside the stage`).toBeGreaterThanOrEqual(stage.top - 1);
      expect(b.bottom, `${name} inside the stage`).toBeLessThanOrEqual(stage.bottom + 1);
    }
    // the floats keep to their own sides of the stage
    if (layout.blend && layout.totals) {
      expect(layout.blend.right).toBeLessThanOrEqual(centre.x);
      expect(layout.totals.left).toBeGreaterThanOrEqual(centre.x);
    }
    await win.keyboard.press('Escape');
    await expect(blend).toHaveCount(0);
  });
});

test.describe('a project with video', () => {
  test.use({ appEnv: { ...PIPELINE_ENV, QUADRION_DEMO: DEMO_FOLDER } });

  test('the bottom bar offers Dates and Footage, opens on the dates with piles, and remembers the choice', async ({
    win,
  }) => {
    test.setTimeout(240_000);
    await openDemo(win, 'Demo tank farm', 'demo-tank-farm');
    const dates = win.getByTestId('bottom-switch-dates');
    const footage = win.getByTestId('bottom-switch-footage');
    await expect(win.getByRole('group', { name: 'Bottom timeline' })).toBeVisible();
    await expect(dates).toHaveAttribute('aria-pressed', 'true');
    await expect(stripOf(win)).toBeVisible();
    await expect(win.locator('.ws-tl')).toHaveCount(0);

    await footage.click();
    await expect(footage).toHaveAttribute('aria-pressed', 'true');
    await expect(stripOf(win)).toHaveCount(0);
    await expect(win.locator('.ws-tl')).toBeVisible();

    // remembered for this project across a reload
    await win.reload();
    await expect(
      win.locator('[data-testid="project-card"], [data-scene-view] canvas').first(),
    ).toBeVisible();
    if (await win.getByTestId('project-card').first().isVisible())
      await openDemo(win, 'Demo tank farm', 'demo-tank-farm');
    await expect(win.getByTestId('bottom-switch-footage')).toHaveAttribute('aria-pressed', 'true');
    await expect(win.locator('.ws-tl')).toBeVisible();
    await expect(stripOf(win)).toHaveCount(0);

    await win.getByTestId('bottom-switch-dates').click();
    await expect(stripOf(win)).toBeVisible();
    await expect(win.locator('.ws-tl')).toHaveCount(0);
  });
});
