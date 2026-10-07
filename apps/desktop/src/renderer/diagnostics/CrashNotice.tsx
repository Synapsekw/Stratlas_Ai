import { brand } from '@aio/brand';
import type { CrashNotice as Notice } from '@aio/schema';
import { Icon, t } from '@aio/ui';
import { useEffect, useState } from 'react';
import { bridge } from '../shell';
import './diagnostics.css';
import { SavedPath } from './SavedPath';
import { saveDiagnostics } from './state';

/**
 * After a crash: "Quadrion AI closed unexpectedly last time" (or, after a window crash, that the
 * window was reopened), with Save a report and Dismiss. Shown until the person picks one.
 */
export function CrashNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void bridge.call('app:crashNotice', {}).then((r) => {
      if (live && r.ok) setNotice(r.value.notice);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!notice) return null;

  const dismiss = () => {
    setNotice(null);
    void bridge.call('app:dismissCrashNotice', {});
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const r = await saveDiagnostics(bridge);
    setBusy(false);
    if (!r.ok) setError(r.error);
    else if (r.value) {
      setSaved(r.value);
      void bridge.call('app:dismissCrashNotice', {});
    }
  };

  return (
    <aside className="crash-notice" role="status" aria-live="polite" data-testid="crash-notice">
      <div className="crash-notice-h">
        <Icon name="warn" size={16} />
        <b>
          {t(notice.kind === 'closed' ? 'diag.crash.closed' : 'diag.crash.window', {
            product: brand.productName,
          })}
        </b>
      </div>
      <p>
        {saved ? (
          <SavedPath path={saved} />
        ) : (
          t('diag.crash.text', { process: notice.process, reason: notice.reason })
        )}
      </p>
      {error && <p className="prov-err">{error}</p>}
      <div className="crash-notice-f">
        {saved ? (
          <button type="button" className="btn sm" onClick={dismiss}>
            {t('diag.problem.done')}
          </button>
        ) : (
          <>
            <button type="button" className="btn sm ghost" disabled={busy} onClick={dismiss}>
              {t('diag.crash.dismiss')}
            </button>
            <button
              type="button"
              className="btn sm primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? t('diag.saving') : t('diag.crash.save')}
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
