import { Icon, useT } from '@aio/ui';
import type { MovedLayer } from './dateFolders';
import { DatePrompt, type DatePromptNote } from './DatePrompt';

/**
 * A line under the Datasets header: what a move or a new date did, or why it failed. `undo` puts
 * layers back; `measureUndo` is the seq of a measurement move to undo (`undoMeasureChange`);
 * `prepare` offers Prepare surfaces (a measurement move refused for want of them).
 */
export interface DateNote {
  text: string;
  danger: boolean;
  /** `made`: the date made for the move, removed by Undo when it is left empty. */
  undo?: { moved: MovedLayer[]; target: string | null; made?: string };
  measureUndo?: number;
  prepare?: boolean;
  /** The seq of the measurement store's note this line shows (`measureStore.note`). */
  storeSeq?: number;
}

/**
 * The filing prompt and the note above the dataset list. Neither fits the collapsed 52 px rail,
 * so both wait until the sidebar is open again.
 */
export function DateNotes({
  collapsed,
  canEdit,
  note,
  onPromptResult,
  onUndo,
  onMeasureUndo,
  onPrepare,
  onDismiss,
}: {
  collapsed: boolean;
  canEdit: boolean;
  note: DateNote | null;
  onPromptResult: (note: DatePromptNote) => void;
  onUndo: (undo: NonNullable<DateNote['undo']>) => void;
  onMeasureUndo: (seq: number) => void;
  onPrepare: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  if (collapsed) return null;
  return (
    <>
      <DatePrompt canEdit={canEdit} onResult={onPromptResult} />
      {note && (
        <p
          className={`dtree-note${note.danger ? ' danger' : ''}`}
          role={note.danger ? 'alert' : 'status'}
          data-testid="date-note"
        >
          <span>{note.text}</span>
          {(note.undo !== undefined || note.measureUndo !== undefined) && (
            <button
              type="button"
              className="dtree-undo"
              data-testid="date-undo"
              onClick={() => {
                if (note.undo) onUndo(note.undo);
                else if (note.measureUndo !== undefined) onMeasureUndo(note.measureUndo);
              }}
            >
              {t('tree.dates.move.undo')}
            </button>
          )}
          {note.prepare === true && (
            <button
              type="button"
              className="dtree-undo"
              data-testid="date-note-prepare"
              onClick={onPrepare}
            >
              {t('tree.measure.move.prepare')}
            </button>
          )}
          <button
            type="button"
            aria-label={t('tree.dates.dismiss')}
            title={t('tree.dates.dismiss')}
            onClick={onDismiss}
          >
            <Icon name="x" size={12} />
          </button>
        </p>
      )}
    </>
  );
}
