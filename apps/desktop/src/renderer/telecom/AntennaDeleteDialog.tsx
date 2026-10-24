/**
 * The confirmation before antennas are deleted (`antennaDelete`): names the units, the RF sectors
 * that hold them and, when the coverage plan has unsaved edits, that it must be saved.
 */
import { useT } from '@aio/ui';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { cancelDeleteAntennas, confirmDeleteAntennas, useAntennaDelete } from './antennaDelete';

export function AntennaDeleteDialog() {
  const t = useT();
  const ask = useAntennaDelete((s) => s.ask);
  const busy = useAntennaDelete((s) => s.busy);
  if (!ask) return null;
  const count = ask.ids.length;
  return (
    <ConfirmDialog
      danger
      testId="antenna-delete-confirm"
      title={t('project.antennas.confirm.title', { count, name: ask.names[0] ?? '' })}
      yes={t('project.antennas.confirm.yes', { count })}
      busy={busy}
      onConfirm={() => {
        void confirmDeleteAntennas();
      }}
      onCancel={cancelDeleteAntennas}
    >
      <p>{t('project.antennas.confirm.body')}</p>
      {ask.sectors.map((h) => (
        <p key={h.unitId} data-testid="antenna-delete-sector">
          {t('project.antennas.confirm.sector', { name: h.unitName, sector: h.sector })}
        </p>
      ))}
      {ask.planUnsaved && (
        <p data-testid="antenna-delete-plan-unsaved">{t('project.antennas.confirm.planUnsaved')}</p>
      )}
    </ConfirmDialog>
  );
}
