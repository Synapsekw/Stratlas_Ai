import { Icon, t } from '@aio/ui';
import { useEffect } from 'react';
import { diskChanged, reloadFromDisk, useDiskChanged, watchDiskChanged } from './diskChanged';
import { useToastNotice } from './exports/useToastNotice';

function DiskChangedBody() {
  const reloading = useDiskChanged((s) => s.reloading);
  const error = useDiskChanged((s) => s.error);
  return (
    <>
      {error && <div>{t('diskChanged.failed', { error })}</div>}
      <div className="q-toast-acts">
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
    </>
  );
}

/**
 * A save refused because someone else changed the file on the shared folder (compare-before-write):
 * main's sentence, and Reload, which reads the project's records again. An error toast (read out
 * at once) until reloaded or dismissed.
 */
export function DiskChangedNotice() {
  useEffect(() => watchDiskChanged(), []);
  const message = useDiskChanged((s) => s.message);
  useToastNotice(
    'disk-changed',
    message
      ? {
          message: t('diskChanged.title'),
          detail: message,
          tone: 'error',
          testId: 'disk-changed',
          body: DiskChangedBody,
          closeLabel: t('diskChanged.dismiss'),
          onDismiss: () => {
            diskChanged.getState().dismiss();
          },
        }
      : null,
    message,
  );
  return null;
}
