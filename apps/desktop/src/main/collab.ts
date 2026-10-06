/**
 * The multi-reviewer workflow (M9 stream T3): comments, assignments, approvals and the team policy
 * (`collab:*`), written as journal ops and read as their projection. The agent has no approve tool.
 * T0 stubs: every channel answers "not available yet" until T3 fills it.
 */
import { notYet, type Handle } from './notYet';

export interface CollabIpcDeps {
  handle: Handle;
}

export function registerCollabIpc({ handle }: CollabIpcDeps): void {
  const what = 'Comments, assignments and approvals';
  handle('collab:read', () => notYet(what));
  handle('collab:comment', () => notYet(what));
  handle('collab:editComment', () => notYet(what));
  handle('collab:deleteComment', () => notYet(what));
  handle('collab:assign', () => notYet(what));
  handle('collab:approve', () => notYet(what));
  handle('collab:withdraw', () => notYet(what));
  handle('collab:policy', () => notYet(what));
}
