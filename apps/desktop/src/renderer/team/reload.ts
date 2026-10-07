/**
 * `journal:changed` (M9 integration): a merge, an import, an outside edit or a resolution changed
 * records of the open project under the renderer. Everything that came from disk is read again
 * (manifest, issues, change sets, detections), while the selection, the camera, the time and the
 * open panels stay as they are: the project is not reopened.
 */
import { changeStore } from '@aio/change';
import { issueSaver } from '@aio/annotate';
import type { RecordRef } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { loadDetections } from '../detections/store';
import { mergeDiskIssues } from '../jobs';
import { bridge } from '../shell';

/** Read the open project's records again, keeping selection and camera. */
export async function reloadRecords(
  projectId: string,
  records: readonly RecordRef[],
): Promise<void> {
  const project = workspace.getState().project;
  if (project?.id !== projectId) return;
  const r = await bridge.call('project:open', { path: project.root });
  const now = workspace.getState();
  if (!r.ok || !r.value.ok || now.project?.id !== projectId) return;
  const merged = mergeDiskIssues(now.issues, r.value.issues);
  workspace.setState({
    project: { ...now.project, manifest: r.value.manifest },
    issues: merged.issues,
  });
  if (merged.unsaved) issueSaver.schedule(projectId, merged.issues);
  const recs = new Set(records.map((x) => x.rec));
  const all = recs.has('project');
  if (all || recs.has('change-item') || recs.has('change-set')) {
    await changeStore.getState().load(projectId);
  }
  if (all || recs.has('detection') || recs.has('detection-pass')) {
    await loadDetections(projectId, true);
  }
}

/** Follow `journal:changed` for the open project. Returns an unsubscribe function. */
export function followJournalChanges(): () => void {
  return window.aio.on('journal:changed', (e) => {
    void reloadRecords(e.projectId, e.records);
  });
}
