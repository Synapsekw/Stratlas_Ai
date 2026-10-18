/**
 * The Coverage panel's Advanced fold: the study settings and the CSV import, folded by default.
 * Its header line sums up the study, for example `TR 38.901 · urban macro · 3 km · 10 m`.
 */
import type { PropagationModel, RfEnvironment, RfStudy } from '@aio/schema';
import { Icon, type MessageKey, type t as T } from '@aio/ui';
import { useId, type ReactElement, type ReactNode } from 'react';

const MODEL_SHORT: Record<PropagationModel, MessageKey> = {
  tr38901: 'rf.steps.model.tr38901',
  'okumura-hata': 'rf.steps.model.okumuraHata',
  'cost231-hata': 'rf.steps.model.cost231Hata',
  'free-space': 'rf.steps.model.freeSpace',
};
const ENV_SHORT: Record<RfEnvironment, MessageKey> = {
  uma: 'rf.steps.env.uma',
  umi: 'rf.steps.env.umi',
  rma: 'rf.steps.env.rma',
};

/** The study in one line; the environment only counts for TR 38.901. */
export function studySummary(t: typeof T, study: RfStudy): string {
  const radius =
    study.radiusM >= 1000
      ? t('rf.steps.advanced.km', { v: Number((study.radiusM / 1000).toFixed(1)) })
      : t('rf.steps.advanced.m', { v: study.radiusM });
  return [
    t(MODEL_SHORT[study.model]),
    ...(study.model === 'tr38901' ? [t(ENV_SHORT[study.environment])] : []),
    radius,
    t('rf.steps.advanced.m', { v: study.gridResolutionM }),
    t('rf.steps.advanced.csv'),
  ].join(' · ');
}

export interface AdvancedFoldProps {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}

export function AdvancedFold({
  title,
  summary,
  open,
  onToggle,
  children,
}: AdvancedFoldProps): ReactElement {
  const bodyId = useId();
  return (
    <section className="rf-adv" data-open={open}>
      <button
        type="button"
        className="rf-adv-head"
        aria-expanded={open}
        aria-controls={bodyId}
        data-testid="rf-advanced"
        onClick={onToggle}
      >
        <Icon name="chev-r" size={12} />
        <span className="rf-adv-title">{title}</span>
        <span className="rf-adv-sum">· {summary}</span>
      </button>
      {open && (
        <div className="rf-adv-bd" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}
