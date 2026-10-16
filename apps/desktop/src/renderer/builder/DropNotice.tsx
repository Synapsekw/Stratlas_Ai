import { Icon, useT } from '@aio/ui';
import { useEffect } from 'react';
import { otherUndo } from './AlignToNotice';
import { dropToGround, useDrop } from './dropSession';

/** "Lowered Cloud 31.2 m (on the DSM)." with Undo; Ctrl+Z and Ctrl+Y while it shows. */
export function DropNotice() {
  const t = useT();
  const notice = useDrop((s) => s.notice);
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
        void dropToGround.getState().apply();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [notice]);
  if (!notice) return null;
  return (
    <div className="toast" data-testid="drop-notice">
      <div className="toast-h">
        <Icon name="chevdown" size={14} />
        <b>{t('drop.notice')}</b>
        <span className="toast-grow" />
        {notice.action && (
          <button
            type="button"
            className="btn ghost sm"
            data-testid={`drop-${notice.action.kind}`}
            onClick={() => void dropToGround.getState().apply()}
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
            dropToGround.getState().dismiss();
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="toast-p" data-testid="drop-text">
        {notice.text}
      </div>
    </div>
  );
}
