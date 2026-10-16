import { Icon, useT } from '@aio/ui';
import { volumetric } from '@aio/volumetric';
import { useEffect } from 'react';
import { cleanup } from '../pointcloud/cleanupStore';
import { shell } from '../shell';
import { alignCamera, alignTo, photoAlign, useAlignTo } from './alignSession';

/** Fields, and the panels that keep their own undo (issues, cleanup, volumes). */
const OWN_UNDO =
  'input, textarea, select, [contenteditable="true"], [data-testid="issue-register"], ' +
  '[data-testid="issue-card"], [data-testid="cleanup-panel"], .vol-panel';

/** Whether Ctrl+Z belongs elsewhere: another screen, a field, or a panel or tool with its own undo. */
export function otherUndo(e: KeyboardEvent): boolean {
  if (shell.getState().screen !== 'scene') return true;
  if (e.target instanceof Element && e.target.closest(OWN_UNDO) !== null) return true;
  return (
    cleanup.store.getState().panelOpen ||
    volumetric.getState().edit !== null ||
    alignCamera.getState().session !== null ||
    photoAlign.getState().session !== null
  );
}

/** "Aligned 214 photos to Site model (moved 91.2 km)" with Undo; Ctrl+Z and Ctrl+Y while it shows. */
export function AlignToNotice() {
  const t = useT();
  const notice = useAlignTo((s) => s.notice);
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
