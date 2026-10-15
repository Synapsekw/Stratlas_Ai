import { EngineerStage, type EngineerRun } from '@aio/schema';
import { Icon, useT, type IconName, type MessageKey } from '@aio/ui';
import './engineer.css';

type Stages = EngineerRun['stages'];
type Status = NonNullable<Stages[keyof Stages]>['status'];

const ICON: Record<Status, IconName> = {
  pending: 'clock',
  running: 'refresh',
  done: 'check',
  failed: 'warn',
  cancelled: 'x',
  skipped: 'chev-r',
};

/**
 * The six stages of an engineering model run, in order, each with its state and message: pending
 * until reached. Cancel while one runs; Retry once one failed or was cancelled.
 */
export function StageList({
  stages,
  onCancel,
  onRetry,
}: {
  stages: Stages;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  const list = EngineerStage.options.map((stage) => ({
    stage,
    state: stages[stage] ?? { status: 'pending' as const },
  }));
  const running = list.some((s) => s.state.status === 'running');
  const stopped = list.some((s) => s.state.status === 'failed' || s.state.status === 'cancelled');
  return (
    <section className="eng-stages" aria-label={t('eng.stage.title')}>
      <ol>
        {list.map(({ stage, state }) => {
          const failed = state.status === 'failed';
          return (
            <li
              key={stage}
              data-testid="eng-stage"
              data-stage={stage}
              data-status={state.status}
              className={`eng-stage ${state.status}`}
              aria-current={state.status === 'running' ? 'step' : undefined}
            >
              <Icon name={ICON[state.status]} size={14} />
              <span className="eng-stage-name">{t(`eng.stage.${stage}` as MessageKey)}</span>
              <span className="eng-stage-status">
                {t(`eng.stage.status.${state.status}` as MessageKey)}
              </span>
              {state.message && (
                <p className="eng-stage-msg" role={failed ? 'alert' : undefined}>
                  {state.message}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <div className="acts">
        {running && (
          <button type="button" className="btn sm" data-testid="eng-cancel" onClick={onCancel}>
            {t('eng.stage.cancel')}
          </button>
        )}
        {!running && stopped && (
          <button
            type="button"
            className="btn sm primary"
            data-testid="eng-retry"
            onClick={onRetry}
          >
            <Icon name="refresh" size={12} />
            {t('eng.stage.retry')}
          </button>
        )}
      </div>
    </section>
  );
}
