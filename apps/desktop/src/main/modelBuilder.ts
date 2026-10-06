/**
 * Procedural models (M8 stream C5, BLD-11): `model:list|read|write|build` and the project policy
 * `ai:setCloudDrawings`. C0 stubs: every channel answers "not available yet" until C5 fills it.
 */
import { notYet, type Handle } from './notYet';

export interface ModelBuilderIpcDeps {
  handle: Handle;
}

export function registerModelBuilderIpc({ handle }: ModelBuilderIpcDeps): void {
  const what = 'The model builder';
  handle('model:list', () => notYet(what));
  handle('model:read', () => notYet(what));
  handle('model:write', () => notYet(what));
  handle('model:build', () => notYet(what));
  handle('ai:setCloudDrawings', () => notYet('The cloud drawings policy'));
}
