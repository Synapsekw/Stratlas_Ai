import { Icon, t } from '@aio/ui';
import { useState } from 'react';
import { SavedPath } from '../../diagnostics/SavedPath';
import { diagnostics, saveDiagnostics } from '../../diagnostics/state';
import { bridge } from '../../shell';

/** Settings, About and updates: Export diagnostics and Report a problem (stream D5). */
export function Diagnostics() {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exportBundle = async () => {
    setBusy(true);
    setError(null);
    const r = await saveDiagnostics(bridge);
    setBusy(false);
    if (!r.ok) setError(r.error);
    else if (r.value) setSaved(r.value);
  };

  return (
    <div className="sblock" data-testid="diagnostics">
      <h2>
        {t('diag.title')}
        <span className="acts">
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              diagnostics.getState().openProblem();
            }}
          >
            <Icon name="bell" size={14} />
            {t('diag.report')}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={() => void exportBundle()}
          >
            <Icon name="download" size={14} />
            {busy ? t('diag.saving') : t('diag.export')}
          </button>
        </span>
      </h2>
      <p className="help">{t('diag.text')}</p>
      {saved && (
        <p className="help" role="status">
          <SavedPath path={saved} />
        </p>
      )}
      {error && <p className="prov-err">{error}</p>}
    </div>
  );
}
