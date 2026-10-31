import { Icon, useT } from '@aio/ui';
import { useToastNotice } from '../exports/useToastNotice';
import { alignCamera, useAlign } from './alignSession';

function AlignBody() {
  const t = useT();
  const notice = useAlign((s) => s.notice);
  if (!notice) return null;
  return (
    <>
      <div data-testid="direction-notice-text">{notice.text}</div>
      {notice.action && (
        <div className="q-toast-acts">
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => void alignCamera.getState().applyNotice()}
            data-testid={`direction-${notice.action.kind}`}
          >
            <Icon name="undo" size={12} />
            {notice.action.kind === 'undo' ? t('align.direction.undo') : t('align.direction.redo')}
          </button>
        </div>
      )}
    </>
  );
}

/** "Camera direction" saved, cleared or undone, with Undo (or Redo), on the toast host. */
export function AlignNotice() {
  const t = useT();
  const notice = useAlign((s) => s.notice);
  useToastNotice(
    'direction-notice',
    notice
      ? {
          message: t('align.direction.notice'),
          icon: 'droneeye',
          testId: 'direction-notice',
          body: AlignBody,
          closeLabel: t('syncNotice.dismiss'),
          onDismiss: () => {
            alignCamera.getState().dismissNotice();
          },
        }
      : null,
    notice,
  );
  return null;
}
