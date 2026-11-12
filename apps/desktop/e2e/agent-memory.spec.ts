/**
 * A3 project notes end to end with the scripted test model (QUADRION_AI_TEST_PROVIDER, isolated
 * profile, no network) on the tiny folder project. "Remember that ..." asks with the card
 * "Remember: ...", the approved note lands in `<project>/ai/memory.json`, shows in the dock's
 * project panel and travels in the next message's window context as projectNotes (read from the
 * send preview, which shows the context exactly as it is sent). The step's Undo removes it; a
 * note added by hand in the panel is found by the fact index and deleted again from the panel.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createDataRoot, expect, launchApp, NetworkGuard, test, type DataRoot } from './fixtures';

const SHOTS = process.env.QUADRION_E2E_SHOTS;
const NOTE = 'The piles here are named SP-1 to SP-9';
const HAND = 'Volumes go in the weekly report';

const agent = (win: Page) => win.getByRole('region', { name: 'Ask AI chat' });
const remembers = (win: Page) =>
  agent(win)
    .locator('.step')
    .filter({ has: win.locator('code', { hasText: /^remember_note$/ }) });

async function ask(win: Page, text: string) {
  const box = agent(win).getByRole('textbox', { name: 'Message the agent' });
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press('Enter');
}

let app: ElectronApplication | null = null;
let data: DataRoot | null = null;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
  if (data) await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  data = null;
});

test('agent: a note the person states is saved with approval, followed, found and undone', async () => {
  test.setTimeout(120_000);
  data = await createDataRoot();
  const { projectId, projectDir } = data;
  app = await launchApp(data, { QUADRION_WINDOW_SIZE: '1100x720', QUADRION_AI_TEST_PROVIDER: '1' });
  const network = new NetworkGuard();
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.proj-switch')).toContainText('E2E tiny project');
  const fileNotes = async (): Promise<string[]> => {
    try {
      const raw = JSON.parse(await readFile(join(projectDir, 'ai', 'memory.json'), 'utf8')) as {
        notes: { text: string }[];
      };
      return raw.notes.map((n) => n.text);
    } catch {
      return [];
    }
  };

  // "remember that ..." asks with the note on its card; the first send previews, always allowed
  await ask(win, `Remember that ${NOTE.charAt(0).toLowerCase()}${NOTE.slice(1)}`);
  const preview = win.getByRole('dialog', { name: /Send to/ });
  await expect(preview).not.toContainText('projectNotes');
  await preview.getByRole('checkbox', { name: 'Always allow for this project' }).check();
  await preview.getByRole('button', { name: 'Send' }).click();
  const card = agent(win).locator('.approve');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(`Remember: ${NOTE}`);
  if (SHOTS) await win.screenshot({ path: join(SHOTS, 'agent-memory-card.png') });
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(remembers(win).first()).toHaveClass(/\bdone\b/);
  await expect(remembers(win).first()).toContainText(`Noted: ${NOTE}`);
  await expect.poll(fileNotes).toEqual([NOTE]);

  // the project panel shows it, saved by the agent
  const panelButton = agent(win).getByRole('button', {
    name: 'This project: notes and permissions',
  });
  await panelButton.click();
  const notes = agent(win).getByRole('list', { name: 'Notes' });
  await expect(notes).toContainText(NOTE);
  await expect(notes).toContainText('Saved by Ask AI');
  if (SHOTS) await win.screenshot({ path: join(SHOTS, 'agent-memory-panel.png') });

  // stop sending without the preview, so the next message shows its context: the note is in it
  await agent(win).getByRole('button', { name: 'Stop sending without the preview' }).click();
  await expect(
    agent(win).getByRole('button', { name: 'Stop sending without the preview' }),
  ).toHaveCount(0);
  await panelButton.click();
  await ask(win, 'How are the piles named?');
  await expect(preview).toContainText('"projectNotes"');
  await expect(preview).toContainText(NOTE);
  await preview.getByRole('button', { name: 'Send' }).click();
  await expect(agent(win).getByText(/^Scripted reply to: How are the piles named/)).toBeVisible();

  // Undo on the step removes the note
  await remembers(win).first().getByRole('button', { name: 'Undo' }).click();
  await expect(remembers(win).first()).toHaveClass(/\bundone\b/);
  await expect.poll(fileNotes).toEqual([]);

  // a note added by hand: in the file, found by the fact index, deleted from the panel
  await panelButton.click();
  await expect(agent(win).getByText('No notes yet.', { exact: false })).toBeVisible();
  await agent(win).getByRole('textbox', { name: 'Add a note' }).fill(HAND);
  await agent(win).getByRole('button', { name: 'Add', exact: true }).click();
  await expect(notes).toContainText(HAND);
  await expect(notes).toContainText('Added by you');
  await expect.poll(fileNotes).toEqual([HAND]);
  const found = () =>
    win.evaluate(async (id) => {
      const r = await window.aio.invoke('facts:query', {
        projectId: id,
        query: { text: 'weekly report', kinds: ['note'] },
      });
      return r.ok ? r.facts.map((f) => f.label) : [];
    }, projectId);
  await expect.poll(found, { timeout: 20_000 }).toEqual([HAND]);
  await agent(win)
    .getByRole('button', { name: `Delete note: ${HAND}` })
    .click();
  await expect(agent(win).getByText('No notes yet.', { exact: false })).toBeVisible();
  await expect.poll(fileNotes).toEqual([]);
  await expect.poll(found, { timeout: 20_000 }).toEqual([]);

  const outbound = await network.outbound();
  expect(outbound, 'the app made network requests').toEqual([]);
});
