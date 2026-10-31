import { brand } from '@aio/brand';
import { t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { useToastNotice } from './exports/useToastNotice';
import { photoUi } from './photogrammetry/store';
import { isPlayer } from './player';
import {
  openProcessingTools,
  packNoticeKey,
  processingTools,
  useProcessingTools,
} from './processingTools';
import { useProcessing } from './processing/store';
import { useShell } from './shell';

function ToolsNoticeBody() {
  return (
    <div className="q-toast-acts">
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
  );
}

/**
 * The one quiet notice about the processing tools: once a project is open, when the pipeline pack
 * is missing, too old for what this version does, or not made for it. **Update processing tools**
 * opens Settings, Processing tools. Dismissed, it stays away for that pack (kept per profile), and
 * comes back only when another pack, or none, is the problem. Never in a read-only package (it
 * runs no jobs), never in an automated run, and never beside a panel that says the same: Settings,
 * the Create maps from photos dialog, the Processing drawer's "Processing cannot run yet". Lives
 * as a toast on the host.
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
  // the Processing drawer says it itself when no tools can be used at all
  const drawerOpen = useProcessing((s) => s.open);
  useEffect(() => {
    if (open) void processingTools.getState().load();
  }, [open]);
  const key = packNoticeKey(status);
  // not where the same thing is already said: Settings, the Create maps dialog, and the
  // Processing drawer, which shows when no tools can be used at all
  const drawerSaysIt = drawerOpen && status?.state !== 'too-old';
  const show =
    open &&
    !player &&
    !installing &&
    status !== null &&
    key !== null &&
    key !== dismissed &&
    screen !== 'settings' &&
    !photoOpen &&
    !drawerSaysIt;
  const missing = status?.state === 'missing';
  useToastNotice(
    'tools-notice',
    show
      ? {
          message: t(missing ? 'tools.notice.missing.title' : 'tools.notice.tooOld.title'),
          detail: missing
            ? t('tools.notice.missing')
            : status.state === 'too-old'
              ? t('tools.notice.tooOld', {
                  version: status.version ?? '',
                  product: brand.productName,
                })
              : t('tools.notice.incompatible', { product: brand.productName }),
          tone: 'warn',
          testId: 'tools-notice',
          body: ToolsNoticeBody,
          closeLabel: t('tools.notice.dismiss'),
          closeTestId: 'tools-notice-dismiss',
          onDismiss: () => {
            processingTools.getState().dismissNotice();
          },
        }
      : null,
  );
  return null;
}
