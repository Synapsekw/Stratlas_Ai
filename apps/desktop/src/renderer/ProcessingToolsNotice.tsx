import { brand } from '@aio/brand';
import { Icon, t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect } from 'react';
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
 * runs no jobs) and never in an automated run. Lives in the toast stack, bottom right.
 */
export function ProcessingToolsNotice() {
  const open = useWorkspace((s) => s.project !== null);
  const player = useShell((s) => isPlayer(s.pkg));
  const onSettings = useShell((s) => s.screen === 'settings');
  const status = useProcessingTools((s) => s.status);
  const dismissed = useProcessingTools((s) => s.dismissed);
  const installing = useProcessingTools((s) => s.installing);
  useEffect(() => {
    if (open) void processingTools.getState().load();
  }, [open]);
  const key = packNoticeKey(status);
  if (!open || player || onSettings || installing || !status || key === null || key === dismissed)
    return null;
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
          {t(missing ? 'tools.notice.install' : 'tools.notice.update')}
        </button>
      </div>
    </div>
  );
}
