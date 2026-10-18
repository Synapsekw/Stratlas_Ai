/**
 * The save controls of the measurements, kept under the Measure bench's Selected panel now that
 * the list itself lives in the Datasets tree: Autosave, the status line, Revert and Save, the
 * read-only notice, a load error, and the bulk totals of the selection.
 */
import { Icon, Tip, t } from '@aio/ui';
import { BulkTotals } from './BulkTotals';
import {
  isDirty,
  revertMeasurements,
  saveMeasurements,
  setAutosave,
  useMeasure,
} from './measureStore';

export function SavedFooter() {
  const readOnly = useMeasure((s) => s.readOnly);
  const autosave = useMeasure((s) => s.autosave);
  const dirty = useMeasure(isDirty);
  const unwritten = useMeasure((s) => s.resultsUnwritten);
  const saving = useMeasure((s) => s.saving);
  const message = useMeasure((s) => s.message);
  const status = useMeasure((s) => s.status);
  const error = useMeasure((s) => s.error);
  if (status === 'idle') return null;
  return (
    <section
      className="sv-saved"
      role="group"
      aria-label={t('measureBench.saved.label')}
      data-testid="survey-saved"
    >
      {status === 'error' && (
        <p className="notice danger small" role="alert" data-testid="survey-saved-error">
          <Icon name="warn" size={14} />
          {error}
        </p>
      )}
      {readOnly ? (
        <p className="small faint sv-foot" data-testid="survey-list-readonly">
          {t('measureBench.saved.readOnly')}
        </p>
      ) : (
        <footer className="sv-foot" role="none">
          <label className="sv-check">
            <Tip content={t('measureBench.saved.autosaveTip')}>
              <input
                type="checkbox"
                checked={autosave}
                data-testid="survey-autosave"
                onChange={(e) => {
                  setAutosave(e.target.checked);
                }}
              />
            </Tip>
            {t('measureBench.saved.autosave')}
          </label>
          <span className="small faint sv-grow" role="status">
            {message ??
              (dirty
                ? t('measureBench.saved.unsaved')
                : unwritten
                  ? t('measureBench.saved.unwritten')
                  : t('measureBench.saved.all'))}
          </span>
          {dirty && (
            <button type="button" className="btn sm ghost" onClick={revertMeasurements}>
              {t('measureBench.saved.revert')}
            </button>
          )}
          <button
            type="button"
            className="btn sm primary"
            disabled={(!dirty && !unwritten) || saving}
            data-testid="survey-list-save"
            onClick={() => {
              void saveMeasurements();
            }}
          >
            {t('measureBench.saved.save')}
          </button>
        </footer>
      )}
      <BulkTotals />
    </section>
  );
}
