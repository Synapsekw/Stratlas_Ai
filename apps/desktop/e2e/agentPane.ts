/**
 * The Scene's agent pane in the e2e specs. With the AI off it is one row, "Agent off · Turn on"
 * (stage island D24), until it is clicked: specs that read why it is off, or measure it, open it.
 */
import type { Page } from '@playwright/test';

/** Opens the Scene's off agent from its one row to the agent's words on why it is off. */
export async function openAgentOff(win: Page): Promise<void> {
  await win.locator('.right').getByRole('button', { name: 'Agent off · Turn on' }).click();
}
