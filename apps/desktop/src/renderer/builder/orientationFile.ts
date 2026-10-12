import type { OrientationFile } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { bridge } from '../shell';

export { withClipKeys, withPhotoFixes } from './orientationEdit';

/*
 * The open project's orientation.json (aio.orientation/1) in the renderer: loaded into the
 * workspace when a project opens, saved through `orientation:write` (journalled, with a backup),
 * and only put in the workspace once main has written it.
 */

/** Bumped by every load and every good write: an older read in flight is dropped. */
let loading = 0;
/** Saves one after the other, each from the file the one before wrote. */
let saving: Promise<unknown> = Promise.resolve();

/** Read the open project's orientation file into the workspace (none: null). */
export async function loadOrientation(): Promise<void> {
  const ws = workspace.getState();
  const id = ws.project?.id;
  const ticket = ++loading;
  ws.setOrientation(null, false);
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

/**
 * Save an edit of the open project's file; an error text or null. Saves run one at a time, each
 * editing the file the one before wrote. When the workspace has not loaded the file yet the edit
 * starts from the file on disk, and nothing is written when that cannot be read, so a save never
 * drops other clips' keyframes or photos' corrections.
 */
export function saveOrientationEdit(
  edit: (file: OrientationFile | null) => OrientationFile,
): Promise<string | null> {
  const run = saving.then(() => editNow(edit));
  saving = run.catch(() => undefined);
  return run;
}

async function editNow(
  edit: (file: OrientationFile | null) => OrientationFile,
): Promise<string | null> {
  const ws = workspace.getState();
  const id = ws.project?.id;
  if (!id) return 'No project is open.';
  let base = ws.orientation;
  if (!ws.orientationLoaded) {
    const r = await bridge.call('orientation:read', { projectId: id });
    if (!r.ok) return r.error;
    if (!r.value.ok) return r.value.error;
    if (workspace.getState().project?.id !== id) return 'The project changed before the save.';
    base = r.value.file;
  }
  return saveOrientation(edit(base));
}

/** Save the whole file; an error text or null. The workspace takes it after a good write. */
export async function saveOrientation(next: OrientationFile): Promise<string | null> {
  const id = workspace.getState().project?.id;
  if (!id) return 'No project is open.';
  const file: OrientationFile = { ...next, updatedAt: new Date().toISOString() };
  const r = await bridge.call('orientation:write', { projectId: id, file });
  if (!r.ok) return r.error;
  if (!r.value.ok) return r.value.error ?? 'The camera directions were not saved.';
  if (workspace.getState().project?.id === id) {
    // a read under way started before this write: it would put the older file back
    loading += 1;
    workspace.getState().setOrientation(file);
  }
  return null;
}
