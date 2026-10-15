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
 * until reached. Cancel while the run is at work; Retry once it stopped short: a stage failed or
 * was cancelled, the run stopped with a reason (`error`, such as photos alone and offline), or
 * run.json still says a stage is running though nothing runs (the app closed mid-stage).
 */
export function StageList({
  stages,
  busy,
  error,
  onCancel,
  onRetry,
}: {
  stages: Stages;
  /** The store's `busy`: whether the run is at work now (run.json may say otherwise). */
  busy?: boolean;
  /** The store's `error`: the run stopped with this reason. */
  error?: string | null;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  const list = EngineerStage.options.map((stage) => ({
    stage,
    state: stages[stage] ?? { status: 'pending' as const },
  }));
  const saysRunning = list.some((s) => s.state.status === 'running');
  const running = busy ?? saysRunning;
  const stopped =
    list.some((s) => s.state.status === 'failed' || s.state.status === 'cancelled') ||
    Boolean(error) ||
    (busy === false && saysRunning);
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
