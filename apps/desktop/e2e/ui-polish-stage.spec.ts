/**
 * Stage polish (UI revision W1b) in the real app, on the synthetic quarry demo: three monthly
 * surveys, three piles and the pit, prepared quietly on open. The bottom strip's collapse tip goes
 * with the click and does not come back while the pointer rests on the button; the Show control's
 * buttons ("Cut & fill" among them) keep their names on one line; in Split the pile labels stay
 * inside their own pane, never cut by the next pane or the right panel. Off-screen, zero network,
 * pipeline Python needed.
 */
import type { Page } from '@playwright/test';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { stageMode, stageShow, volumesView } from './island';
import { openDemo } from './surveyJobs';
import type { SurveyDemoProject } from './surveyFixtures';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

/** Open the quarry with its surveys prepared and the strip drawing every date. */
async function opened(win: Page, p: SurveyDemoProject): Promise<void> {
  await openDemo(win, p.name, p.id);
  await volumesView(win);
  const strip = win.getByRole('region', { name: 'Survey dates chart' });
  await expect(strip.locator('[data-survey][data-state="ready"]')).toHaveCount(3, {
    timeout: 360_000,
  });
}

/**
 * The shown pile labels that leave their view: each label against the pane it is drawn over (the
 * 3D view or the map), with a pixel of slack.
 */
const strayLabels = (win: Page): Promise<string[]> =>
  win.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.sv-labels .sv-label')) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const pane = el.closest('[data-scene-view], .pane-map');
      if (!pane) continue;
      const r = el.getBoundingClientRect();
      const p = pane.getBoundingClientRect();
      if (
        r.left < p.left - 1 ||
        r.right > p.right + 1 ||
        r.top < p.top - 1 ||
        r.bottom > p.bottom + 1
      )
        out.push(`${el.dataset.id ?? '?'} ${JSON.stringify([r.left, r.right, p.left, p.right])}`);
    }
    return out;
  });

test('timeline collapse tip is gone after the click, Show control buttons are one line, pile labels stay inside the pane in Split', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(600_000);
  await opened(win, quarryProject);

  // the collapse tip: shown on hover, gone with the click, not back while the pointer rests
  const collapse = win.getByTestId('strip-collapse');
  await collapse.hover();
  // the tip repeats the button's name, so it is aria-hidden: found by its class
  const tip = win.locator('.tip-pop');
  await expect(tip).toHaveText('Collapse the timeline');
  await collapse.click();
  await expect(collapse).toHaveAttribute('aria-expanded', 'false');
  await expect(tip).toHaveCount(0);
  await win.waitForTimeout(800); // past the tip's 400 ms delay
  await expect(tip).toHaveCount(0);
  await collapse.click();
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');

  // the Show control: every button's name on one line (none wraps inside its 24 px)
  const show = await stageShow(win);
  await expect(show.getByRole('button', { name: 'Cut & fill', exact: true })).toBeVisible();
  const wrapped = await show
    .locator('.seg button')
    .evaluateAll((buttons) =>
      buttons
        .filter((b) => b.scrollHeight > b.clientHeight + 1 || b.scrollWidth > b.clientWidth + 1)
        .map((b) => b.textContent),
    );
  expect(wrapped).toEqual([]);

  // Split: the labels of both panes keep inside them
  await stageMode(win, 'Split');
  await expect
    .poll(() => win.locator('.sv-labels .sv-label:visible').count(), { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect.poll(() => strayLabels(win), { timeout: 30_000 }).toEqual([]);
});
