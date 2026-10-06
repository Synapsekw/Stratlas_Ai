/**
 * Change sets between capture dates (M8 stream C1): `change:list|read|write|compute|cancel` and the
 * `change:progress` event. C0 stubs: every channel answers "not available yet" until C1 fills it.
 */
import { notYet, type Handle } from './notYet';

export interface ChangeIpcDeps {
  handle: Handle;
}

export function registerChangeIpc({ handle }: ChangeIpcDeps): void {
  const what = 'Change detection';
  handle('change:list', () => notYet(what));
  handle('change:read', () => notYet(what));
  handle('change:write', () => notYet(what));
  handle('change:compute', () => notYet(what));
  handle('change:cancel', () => ({ ok: false }));
}
