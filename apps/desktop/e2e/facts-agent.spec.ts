/**
 * The agent reads the project fact index (M1) in the real app: the scripted test model (no key,
 * no network) on the quarry survey demo at 1100 x 720. The quarry ships three volume measurements
 * named "Stockpile SP1", "Stockpile SP2" and "Stockpile SP3" (python/tests/survey_synth.py,
 * `quarry_site`), so a search for "Stockpile SP1" hits all three and history_of has to take the
 * one whose name is exactly that. The agent offers the fact tools only while the index is ready,
 * so the spec waits for the Project tab search to say how much it indexed before it asks "What
 * happened to Stockpile SP1 over time?"; the scripted model takes the subject from the question
 * and calls history_of, whose step must end done with the pile's entries, not an error. Built by
 * `pnpm demo:build --quick` (needs the pipeline Python; skipped without it).
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openSection } from './panel';
import { openDemo } from './surveyJobs';

test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x720', QUADRION_AI_TEST_PROVIDER: '1' } });

const PILE = 'Stockpile SP1';
const QUESTION = `What happened to ${PILE} over time?`;
/** Opening the quarry prepares its surfaces and builds the index: a slow runner gets room. */
const INDEXED = { timeout: 120_000 };
/** A scripted answer is quick; the tool reads main's index. */
const ANSWERED = { timeout: 60_000 };

const agent = (win: Page) => win.getByRole('region', { name: 'Ask AI chat' });
const dock = (win: Page) => win.locator('#agent-dock');
const toggle = (win: Page) => win.getByTestId('agent-toggle');
const historySteps = (win: Page) =>
  agent(win)
    .locator('.step')
    .filter({ has: win.locator('code', { hasText: /^history_of$/ }) });
const replies = (win: Page) => agent(win).getByText(/^Tool \w+ returned/);
const turnErrors = (win: Page) => agent(win).locator('.ag-err');

/**
 * Show the agent: the Scene has its own agent pane in the right column; a page with a header has
 * the Agent toggle that unfolds the dock instead.
 */
async function unfoldAgent(win: Page): Promise<void> {
  if (await agent(win).isVisible()) return;
  if ((await toggle(win).getAttribute('aria-expanded')) !== 'true') await toggle(win).click();
  await expect(dock(win)).toBeVisible();
  await expect(agent(win)).toBeVisible();
}

/** The Project tab search, once the index answers: the count line replaces the state line. */
async function indexReady(win: Page): Promise<Locator> {
  const body = await openSection(win, 'project', 'project.search');
  const search = body.getByTestId('project-search');
  await expect(search).toBeVisible();
  await expect(search.getByTestId('project-search-state')).toHaveCount(0, INDEXED);
  await expect(search.getByTestId('project-search-count')).toContainText('indexed', INDEXED);
  return search;
}

/**
 * Send the question and wait until the agent has answered it: a new history_of step that has
 * finished (done or failed), a new reply or a turn that failed. The first send in a project stops
 * at the send preview, which is accepted. Returns the new history_of step when it ended done.
 */
async function ask(win: Page, text: string): Promise<Locator | null> {
  const box = agent(win).getByRole('textbox', { name: 'Message the agent' });
  await expect(box).toBeEnabled(ANSWERED);
  const before = {
    steps: await historySteps(win).count(),
    replies: await replies(win).count(),
    errors: await turnErrors(win).count(),
  };
  await box.fill(text);
  await box.press('Enter');
  const preview = win.getByRole('dialog', { name: /Send to/ });
  const step = historySteps(win).nth(before.steps);
  const stepState = async (): Promise<'none' | 'running' | 'done' | 'error'> => {
    if ((await step.count()) === 0) return 'none';
    const cls = (await step.getAttribute('class')) ?? '';
    return /\bdone\b/.test(cls) ? 'done' : /\berror\b/.test(cls) ? 'error' : 'running';
  };
  await expect
    .poll(async () => {
      if (await preview.isVisible())
        await preview
          .getByRole('button', { name: 'Send' })
          .click()
          .catch(() => undefined);
      const state = await stepState();
      if (state === 'done' || state === 'error') return 'answered';
      if (state === 'running') return 'running';
      const answered =
        (await replies(win).count()) > before.replies ||
        (await turnErrors(win).count()) > before.errors;
      return answered ? 'answered' : 'waiting';
    }, ANSWERED)
    .toBe('answered');
  return (await stepState()) === 'done' ? step : null;
}

test('the agent answers what happened to a stockpile from the fact index', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(360_000);
  await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
  await openDemo(win, quarryProject.name, quarryProject.id);

  const search = await indexReady(win);
  // the pile is in the index under its own name before the agent is asked
  await search.getByRole('searchbox', { name: 'Search this project' }).fill(PILE);
  await expect(
    search.getByTestId('project-search-result').filter({ hasText: PILE }).first(),
  ).toBeVisible(INDEXED);

  await unfoldAgent(win);
  // an index update between the wait and the send can briefly take the tools away: ask again
  // (bounded) once the index says ready, rather than sleeping
  let step = await ask(win, QUESTION);
  for (let tries = 1; tries < 3 && step === null; tries++) {
    await indexReady(win);
    step = await ask(win, QUESTION);
  }
  expect(step, 'history_of never ended done').not.toBeNull();
  if (!step) return;
  await expect(step).toHaveClass(/\bdone\b/);
  // the step's summary is the pile's label and how many entries its history holds
  await expect(step).toContainText(new RegExp(`${PILE}: \\d+ entr(y|ies)`));

  // the scripted model reports what the tool returned: the pile's subject and its facts
  const reply = agent(win)
    .getByText(/^Tool history_of returned/)
    .last();
  await expect(reply).toBeVisible(ANSWERED);
  const returned = await reply.innerText();
  expect(returned).toContain('measurement:m-sp1');
  expect(returned).toContain(PILE);
  expect(returned).toMatch(/"facts":\[\{/);
  expect(returned).not.toMatch(
    /error-text|fits \d+ things|Nothing in the fact index|still being built/,
  );
});
