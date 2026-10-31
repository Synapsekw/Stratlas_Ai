import { Icon, useT } from '@aio/ui';
import { useToastNotice } from '../exports/useToastNotice';
import { photoAlign, usePhotoAlign } from './alignSession';

function PhotoAlignBody() {
  const t = useT();
  const notice = usePhotoAlign((s) => s.notice);
  if (!notice) return null;
  return (
    <>
      <div data-testid="photo-align-notice-text">{notice.text}</div>
      {(notice.action !== null || notice.flight !== null) && (
        <div className="q-toast-acts">
          {notice.action && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void photoAlign.getState().applyNotice()}
              data-testid={`photo-align-${notice.action.kind}`}
            >
              <Icon name="undo" size={12} />
              {notice.action.kind === 'undo'
                ? t('align.direction.undo')
                : t('align.direction.redo')}
            </button>
          )}
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
      )}
    </>
  );
}

/**
 * "Photo alignment" saved, reset or undone, with Undo (or Redo), and the offer to give the other
 * photos of the same flight the same correction (DJI gimbal and compass errors hold for a flight).
 */
export function PhotoAlignNotice() {
  const t = useT();
  const notice = usePhotoAlign((s) => s.notice);
  useToastNotice(
    'photo-align-notice',
    notice
      ? {
          message: t('align.photoAlign.notice'),
          icon: 'photo',
          testId: 'photo-align-notice',
          body: PhotoAlignBody,
          closeLabel: t('syncNotice.dismiss'),
          onDismiss: () => {
            photoAlign.getState().dismissNotice();
          },
        }
      : null,
    notice,
  );
  return null;
}
