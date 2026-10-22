/**
 * Typed corrections on an engineering model the pipeline built for real (synthetic data only):
 * one synthetic photo and the fast detail give a provisional scale and an unplaced model, as case
 * `C:` of `engineering-flow.spec.ts` (no PDAL needed). The reviewer types what is wrong and sends;
 * the scripted provider (QUADRION_AI_TEST_PROVIDER) answers the correction prompt with a proposal,
 * which is compared Before and After and accepted, or rejected and sent again with a reply. The
 * zero-network guard of the fixture stays on.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import {
  agent,
  approveAgent,
  ask,
  engFixture,
  ENV,
  nextOpenDialog,
  openProject,
  openReview,
  readModel,
  readRun,
  runToReview,
  setupStep,
  startSetup,
  type EngProject,
} from './engineeringFlow';
import { expect, hasPipelinePython, test, VENV_PYTHON } from './fixtures';

test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

const engTest = test.extend<{ eng: EngProject }>({ eng: engFixture });
engTest.use({ appEnv: ENV });

const EXPLANATION = 'Scripted: the ladder is removed as the reviewer asked.';

/** Case C's path: one photo from files, fast detail, run to the review, open the corrections. */
async function buildFromPhoto(app: ElectronApplication, win: Page, eng: EngProject) {
  await openProject(win);
  await win.keyboard.press('Control+K');
  await win.keyboard.type('Create engineering model');
  await win.getByRole('option', { name: /Create engineering model from point clouds/ }).click();
  const setup = win.getByTestId('eng-setup');
  await expect(setup).toBeVisible();
  await nextOpenDialog(app, [eng.photo]);
  await setup.getByTestId('eng-add-photos').click();
  await expect(setup.getByTestId('eng-photo-files')).toContainText('1 photo from files');
  await setupStep(setup, 1);
  await setup.getByTestId('eng-detail-fast').check();
  await startSetup(setup);
  await runToReview(win);
}

async function openCorrections(win: Page) {
  await openReview(win);
  await win.getByRole('button', { name: 'Corrections', exact: true }).click();
  const panel = win.getByRole('region', { name: 'Model corrections' });
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * Approve the scripted proposal. The send preview opens a moment after Send, so wait for it or
 * for the awaiting step before `approveAgent` looks (it checks the preview once, without waiting).
 */
async function approveProposal(win: Page) {
  const preview = win.getByRole('dialog', { name: /^Send to / });
  await expect(preview.or(agent(win).locator('.step.awaiting')).first()).toBeVisible({
    timeout: 30_000,
  });
  await approveAgent(win, 'propose_model_correction');
}

engTest(
  'typed correction on a provisional model: send, compare, accept',
  async ({ app, eng, win }) => {
    test.setTimeout(300_000);
    await buildFromPhoto(app, win, eng);
    const before = await readModel(eng.dir);
    expect(before.scale?.status).toBe('provisional');
    const ladder = before.assemblies.find((a) => a.kind === 'ladder');
    if (!ladder) throw new Error('the draft has no ladder to remove');

    const panel = await openCorrections(win);
    const box = panel.getByRole('textbox', { name: "Tell the AI what's wrong" });
    await box.fill('remove the ladder, there is not one');
    const send = panel.getByRole('button', { name: 'Send', exact: true });
    await expect(send).toBeEnabled();
    await send.click();
    await approveProposal(win); // confirms the send preview first
    await expect(panel.getByText(EXPLANATION)).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByText(/scale is provisional/)).toBeVisible();
    await panel.getByRole('button', { name: 'After', exact: true }).click();
    await panel.getByRole('button', { name: 'Accept correction', exact: true }).click();
    await expect
      .poll(async () => (await readModel(eng.dir)).assemblies.some((a) => a.id === ladder.id), {
        timeout: 60_000,
      })
      .toBe(false);
    // the run file follows the model file
    await expect
      .poll(async () => (await readRun(eng.dir)).corrections?.[0], { timeout: 30_000 })
      .toMatchObject({ status: 'accepted', target: { kind: 'model' } });
    // the box is ready for the next one
    await expect(box).toHaveValue('');
  },
);

engTest(
  'Send names its reason while a conversation is running, and a rejected request resends',
  async ({ app, eng, win }) => {
    test.setTimeout(300_000);
    await buildFromPhoto(app, win, eng);
    const panel = await openCorrections(win);
    const box = panel.getByRole('textbox', { name: "Tell the AI what's wrong" });
    await box.fill('remove the ladder, there is not one');
    const send = panel.getByRole('button', { name: 'Send', exact: true });
    await expect(send).toBeEnabled();

    // a conversation waiting at its send preview: Send says why it is off
    await ask(win, 'hello');
    const preview = win.getByRole('dialog', { name: /^Send to / });
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(send).toBeDisabled();
    await expect(
      panel.getByText('Finish or cancel the current AI conversation first.'),
    ).toBeVisible();
    await preview.getByRole('button', { name: 'Cancel' }).click();
    await expect(preview).toBeHidden();
    await expect(send).toBeEnabled({ timeout: 30_000 });

    // send, reject the proposal, reply and send again: a new proposal comes back
    await send.click();
    await approveProposal(win);
    await expect(panel.getByText(EXPLANATION)).toBeVisible({ timeout: 60_000 });
    await panel.getByRole('button', { name: 'Reject correction', exact: true }).click();
    await expect
      .poll(async () => (await readRun(eng.dir)).corrections?.[0]?.status, { timeout: 30_000 })
      .toBe('rejected');
    const request = panel.locator('.eng-correction-queue li').first().getByRole('button').first();
    if ((await request.getAttribute('aria-pressed')) !== 'true') await request.click();
    await expect(request).toHaveAttribute('aria-pressed', 'true');
    await panel.getByRole('textbox', { name: 'Reply to this request' }).fill('try again');
    const again = panel.getByRole('button', { name: 'Send again', exact: true });
    await expect(again).toBeEnabled();
    await again.click();
    await approveProposal(win);
    await expect
      .poll(async () => (await readRun(eng.dir)).corrections?.[0]?.status, { timeout: 60_000 })
      .toBe('proposed');
    await expect(panel.getByText(EXPLANATION)).toBeVisible();
    await expect(agent(win)).toBeVisible();

    const run = await readRun(eng.dir);
    const correction = run.corrections?.[0];
    expect(correction?.history).toHaveLength(1);
    expect(correction?.history[0]?.disposition).toBe('rejected');
    expect(correction?.replies.at(-1)?.comment).toBe('try again');
  },
);
