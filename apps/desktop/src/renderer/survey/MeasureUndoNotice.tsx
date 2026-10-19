import { Button, Icon, IconButton, useT } from '@aio/ui';
import { dismissUndoDelete, undoDeleteMeasurements, useMeasure } from './measureStore';

/**
 * "2 measurements deleted · Undo", bottom right, after any deletion of measurements (the tree,
 * the Delete key, the 3D and map menus, the Selected panel): a stray Delete can be taken back,
 * with Autosave on as well. It offers the latest deletion; once that is undone, the one before it
 * (up to 10 back). It stays until every deletion is undone or it is dismissed.
 */
export function MeasureUndoNotice() {
  const t = useT();
  const undo = useMeasure((s) => s.undoDeletes.at(-1));
  if (!undo) return null;
  const [only] = undo.items;
  const text =
    undo.items.length === 1 && only
      ? t('measure.undo.deletedOne', { name: only.m.label })
      : t('measure.undo.deleted', { count: undo.items.length });
  return (
    <div className="toast" data-testid="measure-undo">
      <div className="toast-h">
        <Icon name="trash" size={14} />
        <b dir="auto">{text}</b>
        <span className="toast-grow" />
        <Button
          variant="quiet"
          icon="undo"
          data-testid="measure-undo-button"
          onClick={undoDeleteMeasurements}
        >
          {t('measure.undo.undo')}
        </Button>
        <IconButton
          icon="x"
          label={t('measure.undo.dismiss')}
          data-testid="measure-undo-dismiss"
          onClick={dismissUndoDelete}
        />
      </div>
    </div>
  );
}
