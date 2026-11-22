/**
 * The bulk bar under the antenna rows while any row is ticked: "N selected · Accept · Reject ·
 * Delete · ✕". Only the ticked rows the filter shows count. Accept and Reject follow the one rule
 * of every route (`reviewUnits`: rows that all have that status already go back to Draft) and
 * clear the ticks; Delete asks once for all of them (the dialog's yes deletes, and the ticks of
 * deleted units go with them). Accept and Reject stay live while a job runs, as on every route
 * (the jobs read the file again when they commit); Delete waits for the job.
 */
import { Button, IconButton, t } from '@aio/ui';
import type { ReactElement } from 'react';
import { askDeleteAntennas } from './antennaDelete';
import {
  clearTicked,
  deleteBlockedReason,
  reviewUnits,
  useAntennas,
  visibleTickedIds,
} from './antennaStore';

export function AntennaBulkBar(): ReactElement | null {
  const file = useAntennas((s) => s.file);
  const filter = useAntennas((s) => s.filter);
  const ticked = useAntennas((s) => s.ticked);
  const readOnly = useAntennas((s) => s.readOnly);
  const running = useAntennas((s) => s.running);
  const flagStarting = useAntennas((s) => s.flagStarting);
  const flagJob = useAntennas((s) => s.flagJob);
  // the ticked rows on screen, in their order: a tick whose unit has gone, or that the filter
  // hides, neither counts nor is acted on
  const ids = visibleTickedIds({ file, filter, ticked });
  if (ids.length === 0) return null;
  const reason = readOnly ? { disabledReason: t('telecom.antennas.readOnly') } : {};
  const deleteWhy = deleteBlockedReason({ readOnly, running, flagStarting, flagJob });
  const deleteReason = deleteWhy ? { disabledReason: deleteWhy } : {};
  const decide = (status: 'accepted' | 'rejected') => {
    if (readOnly) return;
    void reviewUnits(ids, status);
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
        variant="danger"
        icon="trash"
        data-testid="antenna-bulk-delete"
        {...deleteReason}
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
