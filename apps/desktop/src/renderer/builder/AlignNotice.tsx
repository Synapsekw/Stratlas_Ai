import { Icon, useT } from '@aio/ui';
import { alignCamera, useAlign } from './alignSession';

/** "Camera direction" saved, cleared or undone, with Undo (or Redo), in the toast stack. */
export function AlignNotice() {
  const t = useT();
  const notice = useAlign((s) => s.notice);
  if (!notice) return null;
  return (
    <div className="toast" data-testid="direction-notice">
      <div className="toast-h">
        <Icon name="droneeye" size={14} />
        <b>{t('align.direction.notice')}</b>
        <span className="toast-grow" />
        {notice.action && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => void alignCamera.getState().applyNotice()}
            data-testid={`direction-${notice.action.kind}`}
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
            alignCamera.getState().dismissNotice();
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="toast-p" data-testid="direction-notice-text">
        {notice.text}
      </div>
    </div>
  );
}
