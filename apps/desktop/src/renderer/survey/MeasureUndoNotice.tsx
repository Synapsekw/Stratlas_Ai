import { Button, useT } from '@aio/ui';
import { useToastNotice } from '../exports/useToastNotice';
import { dismissUndoDelete, undoDeleteMeasurements, useMeasure } from './measureStore';

function UndoBody() {
  const t = useT();
  return (
    <div className="q-toast-acts">
      <Button
        variant="quiet"
        icon="undo"
        data-testid="measure-undo-button"
        onClick={(e) => {
          if (e.detail <= 1) undoDeleteMeasurements();
        }}
      >
        {t('measure.undo.undo')}
      </Button>
    </div>
  );
}

/**
 * "2 measurements deleted" with Undo, on the toast host, after any deletion of measurements (the
 * tree, the Delete key, the 3D and map menus, the Selected panel): a stray Delete can be taken
 * back, with Autosave on as well. It offers the latest deletion; once that is undone, the one
 * before it (up to 10 back). It stays until every deletion is undone or it is dismissed. The
 * second click of a double-click is ignored: it would land on the deletion before, now under the
 * pointer.
 */
export function MeasureUndoNotice() {
  const t = useT();
  const undo = useMeasure((s) => s.undoDeletes.at(-1));
  const only = undo?.items.length === 1 ? undo.items[0] : undefined;
  const text = !undo
    ? ''
    : only
      ? t('measure.undo.deletedOne', { name: only.m.label })
      : t('measure.undo.deleted', { count: undo.items.length });
  useToastNotice(
    'measure-undo',
    undo
      ? {
          message: text,
          icon: 'trash',
          testId: 'measure-undo',
          body: UndoBody,
          closeLabel: t('measure.undo.dismiss'),
          closeTestId: 'measure-undo-dismiss',
          onDismiss: dismissUndoDelete,
        }
      : null,
    undo,
  );
  return null;
}
