import { Icon, useT } from '@aio/ui';
import { useEffect } from 'react';
import { useToastNotice } from '../exports/useToastNotice';
import { lineUpApp } from '../lineup/lineUpStore';
import { cleanup } from '../pointcloud/cleanupStore';
import { shell } from '../shell';
import { alignCamera, alignTo, photoAlign, useAlignTo } from './alignSession';
import { builder } from './state';

/** Fields, and the panels that keep their own undo (issues, cleanup). */
const OWN_UNDO =
  'input, textarea, select, [contenteditable="true"], [data-testid="issue-register"], ' +
  '[data-testid="issue-card"], [data-testid="cleanup-panel"]';

/** Whether Ctrl+Z belongs elsewhere: another screen, a field, or a panel or tool with its own undo. */
export function otherUndo(e: KeyboardEvent): boolean {
  if (shell.getState().screen !== 'scene') return true;
  if (e.target instanceof Element && e.target.closest(OWN_UNDO) !== null) return true;
  return (
    cleanup.store.getState().panelOpen ||
    alignCamera.getState().session !== null ||
    photoAlign.getState().session !== null ||
    // Place model, Georeference model or Calibrate video: the panel holds the layer as it opened,
    // and its own Undo and Done would overwrite a write made under it
    builder.getState().align !== null ||
    // Line up dates: the step is open, and a notice's Undo would change the dates it measured
    (lineUpApp.getState().store?.getState().dialog ?? null) !== null
  );
}

function AlignToBody() {
  const t = useT();
  const notice = useAlignTo((s) => s.notice);
  if (!notice) return null;
  return (
    <>
      <div data-testid="align-to-text">{notice.text}</div>
      {notice.action && (
        <div className="q-toast-acts">
          <button
            type="button"
            className="btn ghost sm"
            data-testid={`align-to-${notice.action.kind}`}
            onClick={() => void alignTo.getState().apply()}
          >
            <Icon name="undo" size={12} />
            {notice.action.kind === 'undo' ? t('align.direction.undo') : t('align.direction.redo')}
          </button>
        </div>
      )}
    </>
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
  useToastNotice(
    'align-to-notice',
    notice
      ? {
          message: t('align.to.notice'),
          icon: 'target',
          testId: 'align-to-notice',
          body: AlignToBody,
          closeLabel: t('syncNotice.dismiss'),
          onDismiss: () => {
            alignTo.getState().dismiss();
          },
        }
      : null,
    notice,
  );
  return null;
}
