import { Icon, useT } from '@aio/ui';
import { useEffect } from 'react';
import { useToastNotice } from '../exports/useToastNotice';
import { positionEdit, usePositionEdit } from './alignSession';
import { otherUndo } from './AlignToNotice';

function Body() {
  const t = useT();
  const notice = usePositionEdit((s) => s.notice);
  if (!notice) return null;
  return (
    <>
      <div data-testid="position-text">{notice.text}</div>
      {notice.action && (
        <div className="q-toast-acts">
          <button
            type="button"
            className="btn ghost sm"
            data-testid={`position-${notice.action.kind}`}
            onClick={() => void positionEdit.getState().apply()}
          >
            <Icon name="undo" size={12} />
            {notice.action.kind === 'undo' ? t('align.direction.undo') : t('align.direction.redo')}
          </button>
        </div>
      )}
    </>
  );
}

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
  useToastNotice(
    'position-notice',
    notice
      ? {
          message: t('position.edit'),
          icon: 'crosshair',
          testId: 'position-notice',
          body: Body,
          closeLabel: t('syncNotice.dismiss'),
          onDismiss: () => {
            positionEdit.getState().dismiss();
          },
        }
      : null,
    notice,
  );
  return null;
}
