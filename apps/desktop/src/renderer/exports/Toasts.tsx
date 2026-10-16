import { Icon, useT } from '@aio/ui';
import { useStore } from 'zustand';
import { AlignNotice } from '../builder/AlignNotice';
import { AlignToNotice } from '../builder/AlignToNotice';
import { PhotoAlignNotice } from '../builder/PhotoAlignNotice';
import { photoPicks, usePhotoPicks } from '../builder/photoPicks';
import { DiskChangedNotice } from '../DiskChangedNotice';
import { GraphicsNotice } from '../GraphicsNotice';
import { FarContentNotice } from '../builder/FarContentNotice';
import { ProjectMapNotice } from '../mapCoverage/ProjectMapNotice';
import { placement } from '../placement';
import { PlaceOnModelNotice } from '../placement/PlaceOnModelNotice';
import { ProcessingToolsNotice } from '../ProcessingToolsNotice';
import { SyncNotices } from '../team/SyncNotices';
import { cancelExport, toasts } from './exports';

/** "3 photos picked" with Clear, while several photo pins are picked. */
export function PhotoPicksNotice() {
  const t = useT();
  const count = usePhotoPicks((s) => s.picks.length);
  if (count < 1) return null;
  return (
    <div className="toast" data-testid="photo-picks">
      <div className="toast-h">
        <Icon name="photo" size={14} />
        <b>{t('align.photoMenu.picked', { count })}</b>
        <span className="toast-grow" />
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
    </div>
  );
}

/**
 * Export progress toasts and the graphics memory notice, bottom right. The live region stays mounted so screen readers hear an
 * export start (its title) and end (its message); the running progress text is not read out.
 */
export function Toasts() {
  const list = useStore(toasts, (s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      <GraphicsNotice />
      <DiskChangedNotice />
      <ProcessingToolsNotice />
      <SyncNotices />
      <AlignNotice />
      <PhotoAlignNotice />
      <AlignToNotice />
      <PhotoPicksNotice />
      <PlaceOnModelNotice store={placement} />
      <ProjectMapNotice />
      <FarContentNotice />
      {list.map((t) => {
        const pct = t.total > 0 ? Math.round((t.done / t.total) * 100) : null;
        return (
          <div key={t.id} className={`toast ${t.state}`} data-testid="export-toast">
            <div className="toast-h">
              <Icon
                name={t.state === 'error' ? 'warn' : t.state === 'done' ? 'check' : 'download'}
                size={14}
              />
              <b>{t.title}</b>
              <span className="toast-grow" />
              {t.state === 'running' ? (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => {
                    cancelExport(t.id);
                  }}
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  className="btn ghost icon sm"
                  aria-label="Dismiss"
                  onClick={() => {
                    toasts.getState().dismiss(t.id);
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
            {t.state === 'running' ? (
              <>
                <div className="toast-p" aria-hidden="true">
                  {t.phase}
                  {t.total > 1 && (
                    <span className="mono">
                      {' '}
                      {t.done} / {t.total}
                    </span>
                  )}
                </div>
                <div className={`toast-bar${pct === null ? ' busy' : ''}`} aria-hidden="true">
                  <i style={{ width: `${String(pct ?? 30)}%` }} />
                </div>
              </>
            ) : (
              <div className="toast-p" data-testid="export-toast-message">
                {t.message}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
