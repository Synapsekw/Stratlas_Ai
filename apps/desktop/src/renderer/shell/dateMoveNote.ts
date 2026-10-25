import { formatDate, type MessageKey } from '@aio/ui';
import type { ProjectManifest } from '@aio/schema';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { DateNote } from './DateNotes';
import type { MovedLayer } from './dateUndo';

/**
 * The "Moved ... / Undo" line every re-file to another survey date leaves under the Datasets
 * header, whichever way it was made: a drag, the right-click menu or the Selection card. The
 * first two reach the Datasets list directly; the Selection card announces through this store.
 */

export interface DateMoveAnnouncement {
  seq: number;
  moved: MovedLayer[];
  target: string | null;
}

export const moveAnnounce = createStore<{ last: DateMoveAnnouncement | null }>(() => ({
  last: null,
}));
let seq = 0;

/** Tell the Datasets list that these layers were just filed under `target` (null: no date). */
export function announceDateMove(moved: MovedLayer[], target: string | null) {
  if (moved.length === 0) return;
  seq += 1;
  moveAnnounce.setState({ last: { seq, moved, target } });
}

export const useDateMoveAnnouncement = () => useStore(moveAnnounce, (s) => s.last);

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** The note for a finished move: what was filed where, with Undo; null when nothing moved. */
export function moveNote(
  t: T,
  manifest: ProjectManifest | undefined,
  moved: readonly MovedLayer[],
  target: string | null,
): DateNote | null {
  const [first] = moved;
  if (!first) return null;
  const date = target ? manifest?.captures.find((c) => c.id === target)?.date : undefined;
  const undo = { moved: [...moved], target };
  if (moved.length > 1)
    return {
      text: date
        ? t('tree.dates.move.done', { count: moved.length, date: formatDate(date) })
        : t('tree.dates.move.doneNone', { count: moved.length }),
      danger: false,
      undo,
    };
  const name = manifest?.layers.find((l) => l.id === first.id)?.name ?? first.id;
  return {
    text: date
      ? t('tree.dates.move.doneOne', { name, date: formatDate(date) })
      : t('tree.dates.move.doneOneNone', { name }),
    danger: false,
    undo,
  };
}
