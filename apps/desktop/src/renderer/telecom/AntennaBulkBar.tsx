/**
 * The bulk bar under the antenna rows while any row is ticked: "N selected · Accept · Reject ·
 * Delete · ✕". Accept and Reject set every ticked unit and clear the ticks; Delete asks once for
 * all of them (the dialog's yes deletes, and the ticks of deleted units go with them).
 */
import { Button, IconButton, t } from '@aio/ui';
import type { ReactElement } from 'react';
import { askDeleteAntennas } from './antennaDelete';
import { clearTicked, setUnitStatus, useAntennas } from './antennaStore';

export function AntennaBulkBar(): ReactElement | null {
  const file = useAntennas((s) => s.file);
  const ticked = useAntennas((s) => s.ticked);
  const readOnly = useAntennas((s) => s.readOnly);
  // in the file's order; a tick whose unit has gone does not count
  const ids = (file?.units ?? []).filter((u) => ticked[u.id] === true).map((u) => u.id);
  if (ids.length === 0) return null;
  const reason = readOnly ? { disabledReason: t('telecom.antennas.readOnly') } : {};
  const decide = (status: 'accepted' | 'rejected') => {
    if (readOnly) return;
    for (const id of ids) void setUnitStatus(id, status);
    clearTicked();
  };
  const count = t('project.antennas.bulk.count', { count: ids.length });
  return (
    <div className="antenna-bulk" role="group" aria-label={count} data-testid="antenna-bulk">
      <strong className="antenna-bulk-count">{count}</strong>
      <Button
        size="sm"
        variant="quiet"
        data-testid="antenna-bulk-accept"
        {...reason}
        onClick={() => {
          decide('accepted');
        }}
      >
        {t('telecom.antennas.accept')}
      </Button>
      <Button
        size="sm"
        variant="quiet"
        data-testid="antenna-bulk-reject"
        {...reason}
        onClick={() => {
          decide('rejected');
        }}
      >
        {t('telecom.antennas.reject')}
      </Button>
      <Button
        size="sm"
        variant="quiet"
        icon="trash"
        data-testid="antenna-bulk-delete"
        {...reason}
        onClick={() => {
          askDeleteAntennas(ids);
        }}
      >
        {t('telecom.antennas.card.delete')}
      </Button>
      <span style={{ flex: 1 }} />
      <IconButton
        icon="x"
        label={t('project.antennas.bulk.clear')}
        data-testid="antenna-bulk-clear"
        onClick={clearTicked}
      />
    </div>
  );
}
