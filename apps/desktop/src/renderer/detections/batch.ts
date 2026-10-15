import type { IssueContext } from '@aio/annotate';
import { acceptMany, type Detection, type ReviewChange } from '@aio/annotate/detections';

/*
 * Accept all and Reject all (ANN-7) over the filtered list on screen. The issue editor command
 * and the review change of one Accept all carry the same label, so undo can do both or neither.
 */

export interface BatchPlan {
  /** Waiting detections Accept all turns into issues. */
  accept: number;
  /** Waiting detections it skips (no class, no severity...). */
  skip: number;
  /** Waiting detections Reject all rejects. */
  reject: number;
}

export function planBatch(
  list: readonly Detection[],
  ctx: IssueContext,
  sizeOf?: (d: Detection) => readonly [number, number] | undefined,
): BatchPlan {
  const r = acceptMany(list, ctx, sizeOf);
  return {
    accept: r.accepted.length,
    skip: r.skipped.length,
    reject: list.filter((d) => d.status === 'draft').length,
  };
}

const n = (count: number, one: string) => `${String(count)} ${one}${count === 1 ? '' : 's'}`;
export const acceptLabel = (count: number) => `Accept ${n(count, 'detection')}`;
export const rejectLabel = (count: number) => `Reject ${n(count, 'detection')}`;

export type UndoStep = 'none' | 'review' | 'with-issues' | 'blocked';

/** The issues an Accept all change made (the `issueId` of each accepted detection). */
export function batchIssueIds(change: ReviewChange): string[] {
  return Object.values(change.after).flatMap((d) => (d?.issueId ? [d.issueId] : []));
}

/**
 * What undo (or redo) may do with the review's last change, given the issue editor's undo (or
 * redo) label. Two Accept alls of the same size share a label, so the editor's command must also
 * be this batch's: for undo every issue of the change is there (`present` true), for redo none is
 * (`present` false). `has` says whether an issue is in the register.
 */
export function undoStep(
  top: ReviewChange | undefined,
  editorLabel: string | null,
  has: (issueId: string) => boolean = () => true,
  present = true,
): UndoStep {
  if (!top) return 'none';
  if (!top.issues) return 'review';
  if (editorLabel !== top.label) return 'blocked';
  return batchIssueIds(top).every((id) => has(id) === present) ? 'with-issues' : 'blocked';
}
