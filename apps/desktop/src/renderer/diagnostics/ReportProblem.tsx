import { Icon, t } from '@aio/ui';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { bridge } from '../shell';
import './diagnostics.css';
import { SavedPath } from './SavedPath';
import { diagnostics, saveDiagnostics, useDiagnostics } from './state';

/**
 * Help, Report a problem (also the palette and Settings, About and updates): a short form saved
 * with the diagnostics bundle as `problem.md`. Nothing is uploaded or emailed.
 */
export function ReportProblemDialog() {
  const open = useDiagnostics((s) => s.problemOpen);
  const [what, setWhat] = useState('');
  const [steps, setSteps] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The app menu's Help, Report a problem.
  useEffect(
    () =>
      window.aio.on('app:reportProblem', () => {
        diagnostics.getState().openProblem();
      }),
    [],
  );

  if (!open) return null;

  const close = () => {
    if (busy) return;
    setWhat('');
    setSteps('');
    setSaved(null);
    setError(null);
    diagnostics.getState().closeProblem();
  };

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!what.trim()) {
      setError(t('diag.problem.needWhat'));
      return;
    }
    setBusy(true);
    setError(null);
    const r = await saveDiagnostics(bridge, {
      what,
      ...(steps.trim() ? { steps } : {}),
    });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else if (r.value) setSaved(r.value);
  };

  return (
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <form
        className="dlg diag-problem"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diag-problem-title"
        data-testid="report-problem"
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
      >
        <div className="dlg-h">
          <Icon name="bell" size={16} />
          <h2 id="diag-problem-title">{t('diag.problem.title')}</h2>
        </div>
        <div className="dlg-b">
          <p className="help diag-flush">{t('diag.problem.intro')}</p>
          <label className="diag-field">
            <span>{t('diag.problem.what')}</span>
            <textarea
              className="input"
              autoFocus
              rows={4}
              maxLength={8000}
              placeholder={t('diag.problem.whatHint')}
              data-testid="problem-what"
              value={what}
              disabled={saved !== null}
              onChange={(e) => {
                setWhat(e.target.value);
              }}
            />
          </label>
          <label className="diag-field">
            <span>{t('diag.problem.steps')}</span>
            <textarea
              className="input"
              rows={4}
              maxLength={8000}
              placeholder={t('diag.problem.stepsHint')}
              data-testid="problem-steps"
              value={steps}
              disabled={saved !== null}
              onChange={(e) => {
                setSteps(e.target.value);
              }}
            />
          </label>
          {saved && (
            <p className="notice ok diag-flush" role="status" data-testid="problem-saved">
              <Icon name="check" size={14} />
              <SavedPath path={saved} />
            </p>
          )}
          {error && (
            <p className="prov-err diag-flush" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dlg-f">
          <span className="grow" />
          {saved ? (
            <button type="button" className="btn primary" onClick={close}>
              {t('diag.problem.done')}
            </button>
          ) : (
            <>
              <button type="button" className="btn ghost" disabled={busy} onClick={close}>
                {t('diag.problem.cancel')}
              </button>
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? t('diag.saving') : t('diag.problem.save')}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
