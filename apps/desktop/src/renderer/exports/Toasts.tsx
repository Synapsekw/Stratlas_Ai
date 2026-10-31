import { Progress, ToastHost, useT } from '@aio/ui';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { AlignNotice } from '../builder/AlignNotice';
import { AlignToNotice } from '../builder/AlignToNotice';
import { DropNotice } from '../builder/DropNotice';
import { EditPositionNotice } from '../builder/EditPositionNotice';
import { PhotoAlignNotice } from '../builder/PhotoAlignNotice';
import { photoPicks, usePhotoPicks } from '../builder/photoPicks';
import { DiskChangedNotice } from '../DiskChangedNotice';
import { GraphicsNotice } from '../GraphicsNotice';
import { LineUpNotice } from '../lineup/LineUpNotice';
import { LineUpOffer } from '../lineup/LineUpOffer';
import { FarContentNotice } from '../builder/FarContentNotice';
import { ProjectMapNotice } from '../mapCoverage/ProjectMapNotice';
import { placement } from '../placement';
import { MeasureUndoNotice } from '../survey/MeasureUndoNotice';
import { PlaceOnModelNotice } from '../placement/PlaceOnModelNotice';
import { ProcessingToolsNotice } from '../ProcessingToolsNotice';
import { SyncNotices } from '../team/SyncNotices';
import { cancelExport, toasts } from './exports';
import type { Toast as ExportToastState } from './exportModel';
import { useToastNotice } from './useToastNotice';

function PhotoPicksBody() {
  const t = useT();
  return (
    <div className="q-toast-acts">
      <button
        type="button"
        className="btn ghost sm"
        onClick={() => {
          photoPicks.getState().clear();
        }}
      >
        {t('align.photoMenu.clearPicks')}
      </button>
    </div>
  );
}

/** "3 photos picked" with Clear, while several photo pins are picked. */
export function PhotoPicksNotice() {
  const t = useT();
  const count = usePhotoPicks((s) => s.picks.length);
  useToastNotice(
    'photo-picks',
    count > 0
      ? {
          message: t('align.photoMenu.picked', { count }),
          icon: 'photo',
          testId: 'photo-picks',
          body: PhotoPicksBody,
          closable: false,
        }
      : null,
  );
  return null;
}

/** A running export's phase, count and bar with Cancel; a finished one's message. */
function ExportBody({ id }: { id: string }) {
  const x = useStore(toasts, (s) => s.toasts.find((y) => y.id === id));
  if (!x) return null;
  if (x.state !== 'running') return <div data-testid="export-toast-message">{x.message}</div>;
  const pct = x.total > 0 ? Math.round((x.done / x.total) * 100) : null;
  return (
    <>
      {/* the running progress text is not read out, only the start (title) and the end */}
      <div aria-hidden="true">
        {x.phase}
        {x.total > 1 && (
          <span className="mono">
            {' '}
            {x.done} / {x.total}
          </span>
        )}
      </div>
      <Progress pct={pct} />
      <div className="q-toast-acts">
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            cancelExport(id);
          }}
        >
          Cancel
        </button>
      </div>
    </>
  );
}

/** One export as a toast: running with Cancel, then done or failed until dismissed. */
function ExportToast({ x }: { x: ExportToastState }) {
  const running = x.state === 'running';
  // one body per export, kept so a replace does not remount it
  const body = useMemo(
    () =>
      function ExportToastBody() {
        return <ExportBody id={x.id} />;
      },
    [x.id],
  );
  useToastNotice(
    `export-${x.id}`,
    {
      message: x.title,
      tone: x.state === 'error' ? 'error' : x.state === 'done' ? 'ok' : 'info',
      icon: x.state === 'error' ? 'warn' : x.state === 'done' ? 'check' : 'download',
      testId: 'export-toast',
      body,
      // running, Cancel is the way out; the close button would hide a job that goes on
      closable: !running,
      closeLabel: 'Dismiss',
      onDismiss: () => {
        if (toasts.getState().toasts.find((y) => y.id === x.id)?.state !== 'running')
          toasts.getState().dismiss(x.id);
      },
    },
    x.state,
  );
  return null;
}

/**
 * The window's toast host, bottom right, and every notice that shows on it: export progress, the
 * graphics memory notice, undo notices and offers. One shows at a time, the newest first; the rest
 * wait their turn. The host's live regions stay mounted so screen readers hear a toast arrive.
 */
export function Toasts() {
  const list = useStore(toasts, (s) => s.toasts);
  return (
    <>
      <GraphicsNotice />
      <DiskChangedNotice />
      <ProcessingToolsNotice />
      <SyncNotices />
      <AlignNotice />
      <PhotoAlignNotice />
      <AlignToNotice />
      <EditPositionNotice />
      <DropNotice />
      <LineUpOffer />
      <LineUpNotice />
      <PhotoPicksNotice />
      <MeasureUndoNotice />
      <PlaceOnModelNotice store={placement} />
      <ProjectMapNotice />
      <FarContentNotice />
      {list.map((x) => (
        <ExportToast key={x.id} x={x} />
      ))}
      <ToastHost placement="window" />
    </>
  );
}
