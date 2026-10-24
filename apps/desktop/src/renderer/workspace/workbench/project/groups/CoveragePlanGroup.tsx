/**
 * The Coverage plan group of the "In this project" list: one row saying whether the plan has a
 * finished run ("not planned", else "last run {date}") and a button that opens the Coverage tab.
 */
import { Button, Row, useT } from '@aio/ui';
import type { ReactElement } from 'react';
import { useRf } from '../../../../rf/rfStore';
import { openCoverage } from '../../../../rf/rfTab';
import type { ProjectGroupDef } from '../groupRegistry';
import { useCoverageApplies } from './SectorsGroup';

/** When the newest finished run was made (runs are newest first); null without one. */
function useLastRunAt(): string | null {
  return useRf((s) => s.runs.find((r) => r.status === 'done')?.createdAt ?? null);
}

function CoveragePlanBody(): ReactElement {
  const t = useT();
  const at = useLastRunAt();
  const text =
    at === null
      ? t('project.coverage.notPlanned')
      : t('project.coverage.lastRun', { date: new Date(at).toLocaleDateString() });
  return (
    <ul className="pl-rows">
      <Row
        as="li"
        kind="tree"
        data-row-id="coverage"
        label={text}
        actions={
          <Button
            onClick={() => {
              openCoverage();
            }}
          >
            {t('project.coverage.open')}
          </Button>
        }
      />
    </ul>
  );
}

export const coveragePlanGroup: ProjectGroupDef = {
  id: 'coverage',
  title: 'project.group.coverage',
  useCount: () => 0,
  useApplies: useCoverageApplies,
  Body: CoveragePlanBody,
};
