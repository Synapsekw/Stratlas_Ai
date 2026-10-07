import { DEFAULT_HOSTING } from '@aio/schema';

/**
 * The preview label (decision 1): one flag for the app and the server. When
 * `DEFAULT_HOSTING.server` becomes `ga`, every "(preview)" goes away; `off` hides the team server
 * in the app.
 */
export const PREVIEW = DEFAULT_HOSTING.server === 'preview';

/** "Team Server (preview)" while the preview flag is on. */
export function productName(): string {
  return PREVIEW ? 'Team Server (preview)' : 'Team Server';
}
