/**
 * The person's own local model server (M8 stream C7, AI-9): discovery (`ai:localModels`) and the
 * capability probe (`ai:localProbe`), loopback only unless the person accepted the cloud warning.
 * C0 stubs: both channels answer "not available yet" until C7 fills them.
 */
import { notYet, type Handle } from './notYet';

export interface LocalModelsIpcDeps {
  handle: Handle;
}

export function registerLocalModelsIpc({ handle }: LocalModelsIpcDeps): void {
  handle('ai:localModels', () => notYet('Finding local models'));
  handle('ai:localProbe', () => notYet('Testing a local model'));
}
