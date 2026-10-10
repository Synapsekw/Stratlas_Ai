import { brand } from '@aio/brand';
import { Icon, t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { photoUi } from './photogrammetry/store';
import { isPlayer } from './player';
import {
  openProcessingTools,
  packNoticeKey,
  processingTools,
  useProcessingTools,
} from './processingTools';
import { useShell } from './shell';

/**
 * The one quiet notice about the processing tools: once a project is open, when the pipeline pack
 * is missing, too old for what this version does, or not made for it. **Update processing tools**
 * opens Settings, Processing tools. Dismissed, it stays away for that pack (kept per profile), and
 * comes back only when another pack, or none, is the problem. Never in a read-only package (it
 * runs no jobs), never in an automated run, and never beside a panel that says the same: Settings,
 * the Create maps from photos dialog, the Jobs screen's "Jobs cannot run yet". Lives in the toast
 * stack, bottom right.
 */
export function ProcessingToolsNotice() {
  const open = useWorkspace((s) => s.project !== null);
  const player = useShell((s) => isPlayer(s.pkg));
  const screen = useShell((s) => s.screen);
  // the Create maps dialog says it itself, with the same button
  const photoOpen = useStore(photoUi, (s) => s.view !== null);
  const status = useProcessingTools((s) => s.status);
  const dismissed = useProcessingTools((s) => s.dismissed);
  const installing = useProcessingTools((s) => s.installing);
  useEffect(() => {
    if (open) void processingTools.getState().load();
  }, [open]);
  const key = packNoticeKey(status);
  if (!open || player || installing || !status || key === null || key === dismissed) return null;
  // not where the same thing is already said: Settings, the Create maps dialog, and Jobs, whose
  // own panel shows when no tools can be used at all
  const jobsSaysIt = screen === 'jobs' && status.state !== 'too-old';
  if (screen === 'settings' || photoOpen || jobsSaysIt) return null;
  const product = brand.productName;
  const missing = status.state === 'missing';
  return (
    <div className="toast tools-notice" data-testid="tools-notice" data-state={status.state}>
      <div className="toast-h">
        <Icon name="warn" size={14} />
        <b>{t(missing ? 'tools.notice.missing.title' : 'tools.notice.tooOld.title')}</b>
        <span className="toast-grow" />
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('tools.notice.dismiss')}
          data-testid="tools-notice-dismiss"
          onClick={() => {
            processingTools.getState().dismissNotice();
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="toast-p">
        {missing
          ? t('tools.notice.missing')
          : status.state === 'too-old'
            ? t('tools.notice.tooOld', { version: status.version ?? '', product })
            : t('tools.notice.incompatible', { product })}
      </div>
      <div className="toast-p">
        <button
          type="button"
          className="btn sm"
          data-testid="tools-notice-open"
          onClick={() => {
            openProcessingTools();
          }}
        >
          {t('tools.notice.update')}
        </button>
      </div>
    </div>
  );
}
