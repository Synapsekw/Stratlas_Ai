/**
 * Step 1 of the Coverage panel, Antennas: `N accepted · M draft`, a link to the antenna
 * inventory and the "include drafts" switch (moved here from the study settings). The step is
 * done once a unit can take part: an accepted one, or a draft with drafts included.
 */
import { Button, useT } from '@aio/ui';
import type { ReactElement, ReactNode } from 'react';
import { setIncludeUnreviewed, useRf } from '../rfStore';
import { LabelledSwitch } from './parts';
import { Step } from './Step';

export interface StepAntennasProps {
  accepted: number;
  drafts: number;
  onReview: () => void;
  /** More facts about the units, under the line (the tower, the highest antenna). */
  children?: ReactNode;
}

export function StepAntennas({
  accepted,
  drafts,
  onReview,
  children,
}: StepAntennasProps): ReactElement {
  const t = useT();
  const include = useRf((s) => s.includeUnreviewed);
  const done = accepted > 0 || (include && drafts > 0);
  return (
    <Step
      n={1}
      done={done}
      title={t('rf.steps.antennas.title')}
      meta={`${t('rf.steps.antennas.accepted', { count: accepted })} · ${t('rf.steps.antennas.drafts', { count: drafts })}`}
      testId="rf-step-antennas"
    >
      <div className="rf-step-line">
        <span>{t('rf.steps.antennas.from')}</span>
        <Button variant="link" data-testid="rf-step-review" onClick={onReview}>
          {t('rf.steps.antennas.review')}
        </Button>
      </div>
      <LabelledSwitch
        checked={include}
        label={t('rf.steps.antennas.includeDrafts')}
        onChange={setIncludeUnreviewed}
      />
      {children}
    </Step>
  );
}
