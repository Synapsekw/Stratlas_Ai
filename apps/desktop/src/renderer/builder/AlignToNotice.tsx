import { Icon, useT } from '@aio/ui';
import { useEffect } from 'react';
import { alignTo, useAlignTo } from './alignSession';

const editable = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  el.closest('input, textarea, select, [contenteditable="true"]') !== null;

/** "Aligned 214 photos to Site model (moved 91.2 km)" with Undo; Ctrl+Z and Ctrl+Y while it shows. */
export function AlignToNotice() {
  const t = useT();
  const notice = useAlignTo((s) => s.notice);
  useEffect(() => {
    if (!notice?.action) return;
    const kind = notice.action.kind;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || editable(e.target)) return;
      const k = e.key.toLowerCase();
      const undo = k === 'z' && !e.shiftKey;
      const redo = k === 'y' || (k === 'z' && e.shiftKey);
      if ((undo && kind === 'undo') || (redo && kind === 'redo')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void alignTo.getState().apply();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [notice]);
  if (!notice) return null;
  return (
    <div className="toast" data-testid="align-to-notice">
      <div className="toast-h">
        <Icon name="target" size={14} />
        <b>{t('align.to.notice')}</b>
        <span className="toast-grow" />
        {notice.action && (
          <button
            type="button"
            className="btn ghost sm"
            data-testid={`align-to-${notice.action.kind}`}
            onClick={() => void alignTo.getState().apply()}
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
            alignTo.getState().dismiss();
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="toast-p" data-testid="align-to-text">
        {notice.text}
      </div>
    </div>
  );
}
