import { Icon, useT } from '@aio/ui';
import { useEffect } from 'react';
import { positionEdit, usePositionEdit } from './alignSession';
import { otherUndo } from './AlignToNotice';

/** "Moved 12 photos." with Undo; Ctrl+Z and Ctrl+Y while it shows (as Align to). */
export function EditPositionNotice() {
  const t = useT();
  const notice = usePositionEdit((s) => s.notice);
  useEffect(() => {
    if (!notice?.action) return;
    const kind = notice.action.kind;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || otherUndo(e)) return;
      const k = e.key.toLowerCase();
      const undo = k === 'z' && !e.shiftKey;
      const redo = k === 'y' || (k === 'z' && e.shiftKey);
      if ((undo && kind === 'undo') || (redo && kind === 'redo')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void positionEdit.getState().apply();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [notice]);
  if (!notice) return null;
  return (
    <div className="toast" data-testid="position-notice">
      <div className="toast-h">
        <Icon name="crosshair" size={14} />
        <b>{t('position.edit')}</b>
        <span className="toast-grow" />
        {notice.action && (
          <button
            type="button"
            className="btn ghost sm"
            data-testid={`position-${notice.action.kind}`}
            onClick={() => void positionEdit.getState().apply()}
          >
            <Icon name="undo" size={12} />
            {notice.action.kind === 'undo' ? t('align.direction.undo') : t('align.direction.redo')}
          </button>
        )}
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('syncNotice.dismiss')}
          onClick={() => {
            positionEdit.getState().dismiss();
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="toast-p" data-testid="position-text">
        {notice.text}
      </div>
    </div>
  );
}
