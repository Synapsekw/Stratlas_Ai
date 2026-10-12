import { Icon, useT } from '@aio/ui';
import type { MovedLayer } from './dateFolders';
import { DatePrompt, type DatePromptNote } from './DatePrompt';

/** A line under the Datasets header: what a move or a new date did, or why it failed. */
export interface DateNote {
  text: string;
  danger: boolean;
  undo?: { moved: MovedLayer[]; target: string | null };
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
  onDismiss,
}: {
  collapsed: boolean;
  canEdit: boolean;
  note: DateNote | null;
  onPromptResult: (note: DatePromptNote) => void;
  onUndo: (undo: NonNullable<DateNote['undo']>) => void;
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
          {note.undo && (
            <button
              type="button"
              className="dtree-undo"
              data-testid="date-undo"
              onClick={() => {
                if (note.undo) onUndo(note.undo);
              }}
            >
              {t('tree.dates.move.undo')}
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
