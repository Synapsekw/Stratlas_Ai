import type { OrientationFile } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { bridge } from '../shell';

export { withClipKeys, withPhotoFixes } from './orientationEdit';

/*
 * The open project's orientation.json (aio.orientation/1) in the renderer: loaded into the
 * workspace when a project opens, saved through `orientation:write` (journalled, with a backup),
 * and only put in the workspace once main has written it.
 */

let loading = 0;

/** Read the open project's orientation file into the workspace (none: null). */
export async function loadOrientation(): Promise<void> {
  const ws = workspace.getState();
  const id = ws.project?.id;
  const ticket = ++loading;
  ws.setOrientation(null);
  if (!id) return;
  const r = await bridge.call('orientation:read', { projectId: id });
  if (ticket !== loading || workspace.getState().project?.id !== id) return;
  if (!r.ok) {
    console.warn('orientation.json not read', r.error);
    return;
  }
  if (!r.value.ok) {
    console.warn('orientation.json not read', r.value.error);
    return;
  }
  workspace.getState().setOrientation(r.value.file);
}

/** Save the whole file; an error text or null. The workspace takes it after a good write. */
export async function saveOrientation(next: OrientationFile): Promise<string | null> {
  const id = workspace.getState().project?.id;
  if (!id) return 'No project is open.';
  const file: OrientationFile = { ...next, updatedAt: new Date().toISOString() };
  const r = await bridge.call('orientation:write', { projectId: id, file });
  if (!r.ok) return r.error;
  if (!r.value.ok) return r.value.error ?? 'The camera directions were not saved.';
  if (workspace.getState().project?.id === id) workspace.getState().setOrientation(file);
  return null;
}
