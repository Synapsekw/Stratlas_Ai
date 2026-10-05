import { t } from '@aio/ui';
import { shell } from '../../shell';

/** The same rule as `Settings.anthropicWorkspaceId` in @aio/schema; empty clears it. */
export const WORKSPACE_ID = /^[A-Za-z0-9_-]{0,128}$/;

/**
 * Save the Anthropic workspace ID (Settings, AI providers, and the agent panel's fix card): checked
 * here as well as in main, so a typo never reaches the stored settings. Returns the error to show,
 * or null when it is saved (or unchanged).
 */
export async function saveWorkspaceId(raw: string): Promise<string | null> {
  const next = raw.trim();
  if (!WORKSPACE_ID.test(next)) return t('settings.ai.workspaceInvalid');
  if (next === (shell.getState().settings.anthropicWorkspaceId ?? '')) return null;
  const error = await shell.getState().updateSettings({ anthropicWorkspaceId: next });
  return error ? t('settings.ai.workspaceInvalid') : null;
}
