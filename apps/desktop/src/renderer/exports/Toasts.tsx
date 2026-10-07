import { Icon } from '@aio/ui';
import { useStore } from 'zustand';
import { DiskChangedNotice } from '../DiskChangedNotice';
import { GraphicsNotice } from '../GraphicsNotice';
import { cancelExport, toasts } from './exports';

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
