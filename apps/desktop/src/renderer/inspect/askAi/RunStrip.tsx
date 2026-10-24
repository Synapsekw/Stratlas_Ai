/**
 * The Ask AI run strip: what the AI is checking and how far it got, Stop while it runs, and when
 * it ended what happened, "Try the n left again" (it sends only the items not looked at, on the
 * same backend and without a new confirm; a cloud run only while the settings still send to the
 * provider and model confirmed, else it says to press Ask AI again), "Review n suggestions" (the review queue) and Close.
 * Stop says "Stopping" until the run has ended. Under it, the detector runs waiting for the
 * graphics card, each with Cancel, whether or not an Ask AI run shows.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import { Tip, useT } from '@aio/ui';
import { useState, type ReactElement } from 'react';
import { openQueue } from '../inspectUi';
import { clearAskRun, retryAskRun, stopAskRun, useAskAiRun, type AskRun } from './runs';
import { WaitingRuns } from './WaitingRuns';
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
      return t(run.frames ? 'askAi.run.doneFrames' : 'askAi.run.done', {
        count: run.total,
        found: run.found,
      });
    case 'stopping':
      return t('askAi.run.stopping', { done: run.done, count: run.total });
    case 'stopped':
      return t('askAi.run.stopped', { done: run.done, count: run.total });
    case 'failed':
      return t('askAi.run.failed', { error: run.error ?? '' });
  }
}

export function RunStrip(): ReactElement {
  return (
    <>
      <RunLine />
      <WaitingRuns />
    </>
  );
}

function RunLine(): ReactElement | null {
  const t = useT();
  const readOnly = useAnnotateReadOnly();
  const run = useAskAiRun((s) => s.run);
  // a retry that cannot start, is refused or ends in an error says so here
  const [error, setError] = useState<string | null>(null);
  if (!run) return null;
  const busy = run.phase === 'running' || run.phase === 'queued';
  const stopping = run.phase === 'stopping';
  const pct = run.total > 0 ? Math.min(100, (run.done / run.total) * 100) : 0;
  const retry = (
    <button
      type="button"
      className="btn sm"
      data-testid="ask-ai-retry"
      // aria-disabled, not disabled: the read-only tip must still show on hover and focus
      aria-disabled={readOnly ? true : undefined}
      onClick={() => {
        if (readOnly) return;
        setError(null);
        retryAskRun().then(
          (r) => {
            if (r) setError(r.refused);
          },
          (e: unknown) => {
            setError(t('askAi.run.failed', { error: e instanceof Error ? e.message : String(e) }));
          },
        );
      }}
    >
      {t('askAi.run.retry', { count: run.remaining.length })}
    </button>
  );
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
        ) : stopping ? null : (
          <>
            {run.remaining.length > 0 &&
              (readOnly ? (
                <Tip content={t('inspect.readOnly')}>{retry}</Tip>
              ) : run.provider !== undefined ? (
                <Tip
                  content={t('askAi.run.retryTip', {
                    count: run.remaining.length,
                    provider: run.provider,
                  })}
                >
                  {retry}
                </Tip>
              ) : (
                retry
              ))}
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
          {error}
        </p>
      )}
    </div>
  );
}
