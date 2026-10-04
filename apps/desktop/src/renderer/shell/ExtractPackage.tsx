import { packageEditAllowed, type IpcEvent, type PackageInfo } from '@aio/schema';
import { formatBytes, Icon, t } from '@aio/ui';
import { useEffect, useState } from 'react';
import { bridge, shell } from '../shell';

const newJobId = () => `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Extract to edit (BLD-9): copy the open package into a new editable project in the data folder
 * and open it. Hidden behind a notice when the package's policy forbids editing.
 */
export function ExtractPackage({ projectId, pkg }: { projectId: string; pkg: PackageInfo }) {
  const [job, setJob] = useState<string | null>(null);
  const [progress, setProgress] = useState<IpcEvent<'package:progress'> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!job) return;
    return window.aio.on('package:progress', (p) => {
      if (p.jobId === job) setProgress(p);
    });
  }, [job]);

  if (!packageEditAllowed(pkg.header)) {
    return (
      <p className="muted" data-testid="extract-forbidden">
        <Icon name="lock" size={12} /> {t('package.extract.forbidden')}
      </p>
    );
  }

  const run = async () => {
    const jobId = newJobId();
    setJob(jobId);
    setError(null);
    setProgress(null);
    const r = await bridge.call('package:extract', { jobId, projectId });
    setJob(null);
    if (!r.ok) setError(r.error);
    else if (!r.value.ok) setError(r.value.error);
    else if (r.value.root) {
      const root = r.value.root;
      await shell.getState().loadLibrary();
      await shell.getState().openProject(root);
    }
  };

  const pct =
    progress && progress.bytesTotal > 0
      ? Math.round((progress.bytesDone / progress.bytesTotal) * 100)
      : 0;
  return (
    <div className="extract-pkg" data-testid="extract-package">
      {job ? (
        <div className="pkg-progress" aria-live="polite">
          <div className="track">
            <i style={{ width: `${String(pct)}%` }} />
          </div>
          <div className="meta">
            <span className="mono">
              {progress
                ? t('package.extract.progress', {
                    done: formatBytes(progress.bytesDone),
                    total: formatBytes(progress.bytesTotal),
                  })
                : ''}
            </span>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => void bridge.call('package:cancel', { jobId: job })}
            >
              {t('package.extract.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn"
          onClick={() => void run()}
          data-testid="extract-to-edit"
        >
          <Icon name="copy" size={14} />
          {t('package.extract.button')}
        </button>
      )}
      {error && (
        <p className="notice danger" role="alert">
          <Icon name="warn" size={14} />
          {error}
        </p>
      )}
    </div>
  );
}
