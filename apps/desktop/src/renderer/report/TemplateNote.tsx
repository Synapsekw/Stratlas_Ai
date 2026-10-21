/**
 * The report template on the Reports screen (volumetric parity W8): once Add to report has chosen
 * measurements, the survey sections print only those. This says so, with how many, and offers
 * "Clear report template" (asked first) so the report lists every measurement again.
 */
import { isMeasurementEntry } from '@aio/schema';
import { announce, Button, useT } from '@aio/ui';
import { useState } from 'react';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { clearReportTemplate, useTemplate } from './templateStore';

export function TemplateNote({ readOnly }: { readOnly: boolean }) {
  const t = useT();
  const file = useTemplate();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = (file?.entries ?? []).filter(isMeasurementEntry).length;
  if (count === 0 && !error) return null;
  return (
    <div className="rep-template" data-testid="report-template-note">
      <span className="caps">{t('report.template.title')}</span>
      {count > 0 && <p className="faint small">{t('report.template.count', { count })}</p>}
      {error && (
        <p className="notice danger small" role="alert">
          {error}
        </p>
      )}
      {!readOnly && count > 0 && (
        <div>
          <Button
            variant="quiet"
            data-testid="report-template-clear"
            onClick={() => {
              setError(null);
              setAsking(true);
            }}
          >
            {t('report.template.clear')}
          </Button>
        </div>
      )}
      {asking && (
        <ConfirmDialog
          title={t('report.template.clearTitle')}
          yes={t('report.template.clear')}
          busy={busy}
          danger
          testId="report-template-clear-confirm"
          onCancel={() => {
            setAsking(false);
          }}
          onConfirm={() => {
            setBusy(true);
            clearReportTemplate()
              .then(() => {
                announce(t('report.template.cleared'));
              })
              .catch((e: unknown) => {
                setError(e instanceof Error ? e.message : String(e));
              })
              .finally(() => {
                setBusy(false);
                setAsking(false);
              });
          }}
        >
          <p style={{ margin: 0 }}>{t('report.template.clearText')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
