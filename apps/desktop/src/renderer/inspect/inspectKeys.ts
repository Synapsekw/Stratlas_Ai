/**
 * Inspect's keyboard: the review commands of the shortcut registry (scope `review`, so Settings,
 * Keyboard shows the same keys) read for the panel in view. In the review queue F fixes the
 * current suggestion and Esc goes back to the photos; on the photo list F fits the photo and Esc
 * is left to the app. A, D and L act on a suggestion, so on the photo list they need one picked.
 */
import type { ReviewCommand } from '../detections/keys';

export type InspectAction =
  | 'accept'
  | 'dismiss'
  | 'fix'
  | 'next'
  | 'prev'
  /** Shift+J / Shift+K in the queue: the first suggestion of the next or previous photo or frame. */
  | 'nextSource'
  | 'prevSource'
  | 'draw'
  | 'link'
  | 'leave'
  | 'undo'
  | 'redo'
  | 'fit'
  | 'mask'
  /** Severity digit, C / Shift+C, U, Delete: applied to the current draft as the Detections screen did. */
  | { edit: ReviewCommand };

/** The screen's action for a review command: F fixes in the queue and fits outside it; Esc leaves only the queue; edits only in the queue or with a draft selected. */
export function inspectAction(
  cmd: ReviewCommand,
  panel: 'photo' | 'queue',
  draftSelected: boolean,
): InspectAction | null {
  const queue = panel === 'queue';
  switch (cmd.kind) {
    case 'next':
    case 'prev':
      return cmd.kind;
    case 'nextSource':
      return queue ? 'nextSource' : 'next';
    case 'prevSource':
      return queue ? 'prevSource' : 'prev';
    case 'accept':
      return draftSelected ? 'accept' : null;
    case 'reject':
      return draftSelected ? 'dismiss' : null;
    case 'link':
      return draftSelected ? 'link' : null;
    case 'fix':
      return queue ? 'fix' : 'fit';
    case 'fit':
      return 'fit';
    case 'leave':
      return queue ? 'leave' : null;
    case 'tool':
      return cmd.tool === 'box' ? 'draw' : null;
    case 'mask':
      return draftSelected ? 'mask' : null;
    // the review's history in the queue; on the photo list Ctrl+Z belongs to the findings
    case 'undo':
    case 'redo':
      return queue ? cmd.kind : null;
    case 'severity':
    case 'class':
    case 'uncertain':
    case 'delete':
      return draftSelected ? { edit: cmd } : null;
    case 'reopen':
    case 'note':
      return null;
  }
}
