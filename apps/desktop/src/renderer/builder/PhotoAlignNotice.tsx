import { Icon, useT } from '@aio/ui';
import { photoAlign, usePhotoAlign } from './alignSession';

/**
 * "Photo alignment" saved, reset or undone, with Undo (or Redo), and the offer to give the other
 * photos of the same flight the same correction (DJI gimbal and compass errors hold for a flight).
 */
export function PhotoAlignNotice() {
  const t = useT();
  const notice = usePhotoAlign((s) => s.notice);
  if (!notice) return null;
  return (
    <div className="toast" data-testid="photo-align-notice">
      <div className="toast-h">
        <Icon name="photo" size={14} />
        <b>{t('align.photoAlign.notice')}</b>
        <span className="toast-grow" />
        {notice.action && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => void photoAlign.getState().applyNotice()}
            data-testid={`photo-align-${notice.action.kind}`}
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
            photoAlign.getState().dismissNotice();
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="toast-p" data-testid="photo-align-notice-text">
        {notice.text}
      </div>
      {notice.flight && (
        <button
          type="button"
          className="btn sm"
          onClick={() => void photoAlign.getState().applyToFlight()}
          data-testid="photo-align-flight"
        >
          {t('align.photoAlign.applyFlight', { count: notice.flight.ids.length })}
        </button>
      )}
    </div>
  );
}
