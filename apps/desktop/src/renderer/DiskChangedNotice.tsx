import { Icon, t } from '@aio/ui';
import { useEffect } from 'react';
import { diskChanged, reloadFromDisk, useDiskChanged, watchDiskChanged } from './diskChanged';

/**
 * A save refused because someone else changed the file on the shared folder (compare-before-write):
 * main's sentence, and Reload, which reads the project's records again. Lives in the toast stack,
 * bottom right, until reloaded or dismissed.
 */
export function DiskChangedNotice() {
  useEffect(() => watchDiskChanged(), []);
  const message = useDiskChanged((s) => s.message);
  const reloading = useDiskChanged((s) => s.reloading);
  const error = useDiskChanged((s) => s.error);
  if (!message) return null;
  return (
    <div className="toast error" role="alert" data-testid="disk-changed">
      <div className="toast-h">
        <Icon name="warn" size={14} />
        <b>{t('diskChanged.title')}</b>
        <span className="toast-grow" />
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('diskChanged.dismiss')}
          onClick={() => {
            diskChanged.getState().dismiss();
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="toast-p">{message}</div>
      {error && <div className="toast-p">{t('diskChanged.failed', { error })}</div>}
      <div className="toast-p">
        <button
          type="button"
          className="btn sm"
          disabled={reloading}
          onClick={() => {
            void reloadFromDisk();
          }}
        >
          <Icon name="refresh" size={12} />
          {reloading ? t('diskChanged.reloading') : t('diskChanged.reload')}
        </button>
      </div>
    </div>
  );
}
