/**
 * The Ask AI run strip: what the AI is checking and how far it got, Stop while it runs, and when
 * it ended what happened, "Try the n left again" (it sends only the items not looked at, on the
 * same backend and without a new confirm), "Review n suggestions" (the review queue) and Close.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import { useT } from '@aio/ui';
import { useState, type ReactElement } from 'react';
import { openQueue } from '../inspectUi';
import { clearAskRun, retryAskRun, stopAskRun, useAskAiRun, type AskRun } from './runs';
import './askAi.css';

function line(t: ReturnType<typeof useT>, run: AskRun): string {
  switch (run.phase) {
    case 'queued':
      return t('askAi.run.queued');
    case 'running':
      return t(run.frames ? 'askAi.run.frames' : 'askAi.run.photos', {
        count: run.total,
        what: run.what,
        done: run.done,
      });
    case 'done':
      return t('askAi.run.done', { count: run.total, found: run.found });
    case 'stopped':
      return t('askAi.run.stopped', { done: run.done, count: run.total });
    case 'failed':
      return t('askAi.run.failed', { error: run.error ?? '' });
  }
}

export function RunStrip(): ReactElement | null {
  const t = useT();
  const readOnly = useAnnotateReadOnly();
  const run = useAskAiRun((s) => s.run);
  // a retry that cannot start or ends in an error says so here
  const [error, setError] = useState<string | null>(null);
  if (!run) return null;
  const busy = run.phase === 'running' || run.phase === 'queued';
  const pct = run.total > 0 ? Math.min(100, (run.done / run.total) * 100) : 0;
  return (
    <div
      className={`ask-run${run.phase === 'failed' ? ' failed' : ''}`}
      data-testid="ask-ai-run"
      role="status"
    >
      <div className="ask-run-row">
        <span className="ask-run-line">{line(t, run)}</span>
        {busy ? (
          <button
            type="button"
            className="btn sm"
            data-testid="ask-ai-stop"
            onClick={() => {
              stopAskRun();
            }}
          >
            {t('askAi.run.stop')}
          </button>
        ) : (
          <>
            {run.remaining.length > 0 && (
              <button
                type="button"
                className="btn sm"
                data-testid="ask-ai-retry"
                disabled={readOnly}
                title={readOnly ? t('inspect.readOnly') : undefined}
                onClick={() => {
                  setError(null);
                  retryAskRun().catch((e: unknown) => {
                    setError(e instanceof Error ? e.message : String(e));
                  });
                }}
              >
                {t('askAi.run.retry', { count: run.remaining.length })}
              </button>
            )}
            {run.found > 0 && (
              <button
                type="button"
                className="btn sm primary"
                data-testid="ask-ai-review"
                onClick={() => {
                  openQueue();
                }}
              >
                {t('askAi.run.review', { count: run.found })}
              </button>
            )}
            <button
              type="button"
              className="btn sm ghost"
              data-testid="ask-ai-run-close"
              onClick={() => {
                clearAskRun();
              }}
            >
              {t('askAi.run.close')}
            </button>
          </>
        )}
      </div>
      <div
        className="ask-run-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={run.total}
        aria-valuenow={run.done}
      >
        <span style={{ width: `${String(pct)}%` }} />
      </div>
      {error !== null && (
        <p className="ask-note err" role="alert" data-testid="ask-ai-run-error">
          {t('askAi.run.failed', { error })}
        </p>
      )}
    </div>
  );
}
