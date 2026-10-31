import { issueEditor, moveFindingPoint } from '@aio/annotate';
import { spaceOfIssue, spaceOfLayer, unshiftLocal, type Vec3 } from '@aio/schema';
import { dismissToast, t, toast } from '@aio/ui';
import { dateShiftOf, workspace } from '@aio/workspace';
import { createStore } from 'zustand';

/**
 * Move point: the person picks a finding's new place on the point cloud. One session at a time;
 * `MovePointMount` arms the 3D pick while it is open. The move is one undo step of the issue
 * editor, offered back on a toast for as long as it is still the latest step.
 */
export const moveSession = createStore<{ issueId: string | null }>()(() => ({ issueId: null }));

export function startMovePoint(issueId: string): void {
  dismissToast('fly-move-hit');
  moveSession.setState({ issueId });
}

export function cancelMovePoint(): void {
  moveSession.setState({ issueId: null });
  dismissToast('fly-move-hit');
}

export type MoveResult = 'moved' | 'no-hit' | 'not-cloud' | 'no-issue';

/** Undo the move only while it is still the editor's latest step (a later edit stays). */
function undoIfLatest(label: string): void {
  if (issueEditor.state.undoLabel === label) issueEditor.undo();
}

/**
 * The person clicked `hit` (a scene hit: its layer and the point in the scene's local frame).
 * Only a point cloud layer of the finding's own space counts; any other click keeps the point and
 * the session open, and says so.
 */
export function applyMovePoint(
  hit: { layerId: string; point: Vec3 } | null,
  now: string,
): MoveResult {
  const id = moveSession.getState().issueId;
  const ws = workspace.getState();
  const manifest = ws.project?.manifest;
  const issue = id === null ? undefined : ws.issues.find((i) => i.id === id);
  if (!manifest || !issue) {
    cancelMovePoint();
    return 'no-issue';
  }
  const miss = (result: MoveResult): MoveResult => {
    toast(t('fly.move.noHit'), { tone: 'warn', id: 'fly-move-hit', testId: 'fly-move-hit' });
    return result;
  };
  if (!hit) return miss('no-hit');
  const layer = manifest.layers.find((l) => l.id === hit.layerId);
  if (layer?.kind !== 'pointcloud' || spaceOfLayer(layer) !== spaceOfIssue(manifest, issue)) {
    return miss('not-cloud');
  }
  const stored = unshiftLocal(hit.point, dateShiftOf(manifest, layer.id));
  const label = `Move point of ${issue.code}`;
  const r = issueEditor.commitIssues([moveFindingPoint(issue, layer.id, stored, now)], label);
  if (!r.ok) {
    toast(r.error, { tone: 'error', id: 'fly-move-hit' });
    return 'no-hit';
  }
  cancelMovePoint();
  toast(t('fly.move.done'), {
    tone: 'ok',
    id: 'fly-move',
    action: {
      label: t('fly.move.undo'),
      run: () => {
        undoIfLatest(label);
      },
      testId: 'fly-move-undo',
    },
  });
  return 'moved';
}
