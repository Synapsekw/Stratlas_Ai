/**
 * One job: status, progress, Cancel and Resume, steps, outputs, the parameters it ran with and
 * its live log. `folded` is the drawer's narrow form: one column, the parameters and the log
 * folded away.
 */
import type { JobLogLine, JobRecord, JobStep } from '@aio/schema';
import { Icon, t, type IconName } from '@aio/ui';
import { useLayoutEffect, useRef, useState } from 'react';
import { canResume, isActive } from '../jobs';
import { photoUi, runOfJob } from '../photogrammetry/store';
import { jobs, useJobs } from '../shell';
import { Bar, clock, duration, pct, STATUS, StatusChip } from './JobParts';
import { jobTitle } from './pipelines';

const STEP_ICON: Record<JobStep['state'], IconName | null> = {
  pending: null,
  running: null,
  done: 'check',
  skipped: 'check',
  failed: 'x',
  cancelled: 'minus',
};

function LogTail({ lines }: { lines: JobLogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div
      className="job-log mono"
      ref={ref}
      role="log"
      aria-label="Job log"
      aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {lines.length === 0 && <div className="faint">No log lines yet.</div>}
      {lines.map((l, i) => (
        <div key={i} className={`ll ${l.level}`}>
          <span className="lt">{l.time.slice(11, 19)}</span>
          <span className="lv">{l.level}</span>
          {l.step && <span className="ls">{l.step}</span>}
          <span className="lm">{l.message}</span>
        </div>
      ))}
    </div>
  );
}

export function JobDetail({
  job,
  now,
  folded = false,
}: {
  job: JobRecord;
  now: number;
  folded?: boolean;
}) {
  const lines = useJobs((s) => s.logs[job.id]) ?? [];
  const [actionError, setActionError] = useState<string | null>(null);
  const act = async (p: Promise<string | null>) => {
    setActionError(await p);
  };
  const outputs = job.artifacts.filter((a) => !a.path.startsWith('jobs/'));
  const params = Object.entries(job.params);
  const run = runOfJob(job);

  const steps = (
    <div className="jd-col">
      <h3 className="caps">Steps</h3>
      <ol className="jd-steps">
        {job.steps.length === 0 && <li className="faint">Waiting for the runtime.</li>}
        {job.steps.map((s) => {
          const icon = STEP_ICON[s.state];
          return (
            <li key={s.name} data-state={s.state}>
              <span className="si">{icon ? <Icon name={icon} size={12} /> : <i />}</span>
              <span className="sn">{s.title ?? s.name}</span>
              <span className="ss">{s.state === 'skipped' ? 'kept from last run' : s.state}</span>
            </li>
          );
        })}
      </ol>
      {outputs.length > 0 && (
        <>
          <h3 className="caps">Outputs</h3>
          <ul className="jd-out">
            {outputs.map((a) => (
              <li key={a.path} className="mono">
                <Icon name={a.kind === 'folder' ? 'layers' : 'report'} size={12} />
                {a.path}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
  const facts = (
    <dl className="jd-kv">
      <dt>Project</dt>
      <dd className="mono">{job.project}</dd>
      {params.map(([k, v]) => (
        <div key={k} className="kvr">
          <dt>{k}</dt>
          <dd className="mono">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
        </div>
      ))}
      <dt>Started</dt>
      <dd>{clock(job.createdAt)}</dd>
      {job.finishedAt && (
        <>
          <dt>Finished</dt>
          <dd>{clock(job.finishedAt)}</dd>
        </>
      )}
      {job.packVersion && (
        <>
          <dt>Processing tools</dt>
          <dd className="mono">{job.packVersion}</dd>
        </>
      )}
      {folded && (
        <>
          <dt>{t('processing.detail.jobId')}</dt>
          <dd className="mono">{job.id}</dd>
        </>
      )}
    </dl>
  );

  return (
    <section
      className="job-detail"
      aria-label="Job details"
      data-job={job.id}
      data-form={folded ? 'folded' : 'wide'}
    >
      <header className="jd-h">
        <div className="jd-t">
          <h2>{jobTitle(job.pipeline)}</h2>
          {!folded && <span className="mono faint">{job.id}</span>}
        </div>
        <StatusChip status={job.status} />
        <div className="jd-acts">
          {isActive(job) && (
            <button
              type="button"
              className="btn sm"
              disabled={job.status === 'cancelling'}
              onClick={() => void act(jobs.getState().cancel(job.id))}
            >
              <Icon name="x" size={14} />
              Cancel
            </button>
          )}
          {canResume(job) && (
            <button
              type="button"
              className="btn sm primary"
              onClick={() => void act(jobs.getState().start({ resume: job.id }))}
            >
              <Icon name="refresh" size={14} />
              Resume
            </button>
          )}
          {run && (
            <button
              type="button"
              className="btn sm"
              data-testid="job-open-run"
              onClick={() => {
                photoUi.getState().openRun(run);
              }}
            >
              <Icon name="link" size={14} />
              {t('processing.detail.openRun')}
            </button>
          )}
          <button
            type="button"
            className="btn sm"
            disabled={outputs.length === 0}
            onClick={() => void act(jobs.getState().open(job.id, 'output'))}
          >
            <Icon name="link" size={14} />
            Open output
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => void act(jobs.getState().open(job.id, 'log'))}
          >
            Log file
          </button>
        </div>
      </header>
      {actionError && (
        <p className="nj-err" role="alert">
          {actionError}
        </p>
      )}

      <div className="jd-progress">
        <div className="jd-pl">
          <span className="mono jd-pct">{pct(job.progress)}</span>
          <span className="jd-msg">
            {job.status === 'done'
              ? `Finished in ${duration(job, now)}`
              : (job.message ?? STATUS[job.status].label)}
          </span>
          <span className="mono faint">{duration(job, now)}</span>
        </div>
        <Bar job={job} />
      </div>

      {job.error && (
        <div className="jd-error" role="alert">
          <Icon name="warn" size={14} />
          <span>{job.error}</span>
        </div>
      )}

      {folded ? (
        <>
          {steps}
          <details className="jd-fold" data-testid="job-settings">
            <summary>{t('processing.detail.settings')}</summary>
            {facts}
          </details>
          <details className="jd-fold" data-testid="job-log-fold">
            <summary>{t('processing.detail.log')}</summary>
            <LogTail lines={lines} />
          </details>
        </>
      ) : (
        <>
          <div className="jd-grid">
            {steps}
            <div className="jd-col">
              <h3 className="caps">Job</h3>
              {facts}
            </div>
          </div>
          <h3 className="caps jd-logh">Log</h3>
          <LogTail lines={lines} />
        </>
      )}
    </section>
  );
}
