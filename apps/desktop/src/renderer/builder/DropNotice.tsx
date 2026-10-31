import { Icon, useT } from '@aio/ui';
import { useEffect } from 'react';
import { useToastNotice } from '../exports/useToastNotice';
import { otherUndo } from './AlignToNotice';
import { dropToGround, useDrop } from './dropSession';

function Body() {
  const t = useT();
  const notice = useDrop((s) => s.notice);
  if (!notice) return null;
  return (
    <>
      <div data-testid="drop-text">{notice.text}</div>
      {notice.action && (
        <div className="q-toast-acts">
          <button
            type="button"
            className="btn ghost sm"
            data-testid={`drop-${notice.action.kind}`}
            onClick={() => void dropToGround.getState().apply()}
          >
            <Icon name="undo" size={12} />
            {notice.action.kind === 'undo' ? t('align.direction.undo') : t('align.direction.redo')}
          </button>
        </div>
      )}
    </>
  );
}

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
  useToastNotice(
    'drop-notice',
    notice
      ? {
          message: t('drop.notice'),
          icon: 'chevdown',
          testId: 'drop-notice',
          body: Body,
          closeLabel: t('syncNotice.dismiss'),
          onDismiss: () => {
            dropToGround.getState().dismiss();
          },
        }
      : null,
    notice,
  );
  return null;
}
