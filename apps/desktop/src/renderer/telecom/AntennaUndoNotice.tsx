import { Button, useT } from '@aio/ui';
import { useToastNotice } from '../exports/useToastNotice';
import { dismissUndoDeleteAntennas, undoDeleteAntennas, useAntennaUndo } from './antennaDelete';
import { deleteBlockedReason, useAntennas } from './antennaStore';

function UndoBody() {
  const t = useT();
  const readOnly = useAntennas((s) => s.readOnly);
  const running = useAntennas((s) => s.running);
  const flagStarting = useAntennas((s) => s.flagStarting);
  const flagJob = useAntennas((s) => s.flagJob);
  // an undo is a write a job going would undo again, as a delete is: the same reason greys both
  const why = deleteBlockedReason({ readOnly, running, flagStarting, flagJob });
  return (
    <div className="q-toast-acts">
      <Button
        variant="quiet"
        icon="undo"
        data-testid="antenna-undo-button"
        {...(why ? { disabledReason: why } : {})}
        onClick={(e) => {
          if (e.detail <= 1) void undoDeleteAntennas();
        }}
      >
        {t('telecom.antennas.undo.undo')}
      </Button>
    </div>
  );
}

/**
 * "A3 deleted" with Undo, on the toast host, after any delete of antennas (the row's trash, the
 * details, the Delete key, the bulk bar, the right-click menu), as `MeasureUndoNotice` does for
 * measurements: Undo puts the units back with their photo crops and their places in the coverage
 * plan. It offers the latest delete of the open project; once that is undone, the one before it
 * (up to 10 back). It stays until every delete is undone or it is dismissed. The second click of a
 * double-click is ignored: it would land on the delete before, now under the pointer.
 */
export function AntennaUndoNotice() {
  const t = useT();
  const projectId = useAntennas((s) => s.projectId);
  const undo = useAntennaUndo((s) => s.undo.at(-1));
  const mine = undo?.projectId === projectId ? undo : undefined;
  const only = mine?.removed.length === 1 ? mine.removed[0] : undefined;
  const text = !mine
    ? ''
    : only
      ? t('telecom.antennas.undo.deletedOne', { name: only.unit.name })
      : t('telecom.antennas.undo.deleted', { count: mine.removed.length });
  useToastNotice(
    'antenna-undo',
    mine
      ? {
          message: text,
          icon: 'trash',
          testId: 'antenna-undo',
          body: UndoBody,
          closeLabel: t('telecom.antennas.undo.dismiss'),
          closeTestId: 'antenna-undo-dismiss',
          onDismiss: dismissUndoDeleteAntennas,
        }
      : null,
    mine,
  );
  return null;
}
