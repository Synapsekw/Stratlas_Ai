/**
 * The Jobs workbench (stage island D11): every running processing job in the one tab, each with
 * its progress ring, steps, the end of its log, Cancel and Open the job. The processing drawer
 * (and a run's panel) stay the full view of a job; this is the glance beside the stage.
 */
import type { JobLogLine, JobRecord, JobStep } from '@aio/schema';
import { Button, EmptyState, Icon, Row, useT, type IconName } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo, useState } from 'react';
import { isActive } from '../../../jobs';
import { duration, pct, StatusChip, useNow } from '../../../processing/JobParts';
import { projectJobs, projectLabel, runningElsewhere } from '../../../processing/model';
import { jobTitleFor } from '../../../processing/pipelines';
import { processing } from '../../../processing/store';
import { jobs, useJobs, useShell } from '../../../shell';
import './benches.css';

/** The lines of a job's log shown under it. */
const LOG_LINES = 3;

const STEP_ICON: Record<JobStep['state'], IconName | null> = {
  pending: null,
  running: null,
  done: 'check',
  skipped: 'check',
  failed: 'x',
  cancelled: 'minus',
};

const RING_R = 9;
const RING_C = 2 * Math.PI * RING_R;

/** A job's progress as a ring. */
function JobRing({ job }: { job: JobRecord }) {
  const t = useT();
  const done = Math.min(1, Math.max(0, job.progress));
  return (
    <svg
      className="jb-ring"
      viewBox="0 0 24 24"
      width={20}
      height={20}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(done * 100)}
      aria-label={t('bench.jobs.progress', { title: jobTitleFor(job) })}
    >
      <circle className="jb-ring-track" cx={12} cy={12} r={RING_R} />
      <circle
        className="jb-ring-fill"
        cx={12}
        cy={12}
        r={RING_R}
        strokeDasharray={RING_C}
        strokeDashoffset={RING_C * (1 - done)}
        transform="rotate(-90 12 12)"
      />
    </svg>
  );
}

function Steps({ steps }: { steps: readonly JobStep[] }) {
  const t = useT();
  return (
    <ol className="jb-steps" aria-label={t('bench.jobs.steps')}>
      {steps.map((s) => {
        const icon = STEP_ICON[s.state];
        return (
          <li key={s.name} data-state={s.state}>
            <span className="jb-step-mark">{icon ? <Icon name={icon} size={12} /> : <i />}</span>
            <span className="jb-step-name">{s.title ?? s.name}</span>
          </li>
        );
      })}
    </ol>
  );
}

function LogTail({ lines }: { lines: readonly JobLogLine[] }) {
  const t = useT();
  const tail = lines.slice(-LOG_LINES);
  return (
    <div className="jb-log mono" role="log" aria-label={t('bench.jobs.log')} aria-live="polite">
      {tail.length === 0 && <span className="jb-log-none">{t('bench.jobs.noLog')}</span>}
      {tail.map((l, i) => (
        <div key={`${l.time}-${String(i)}`} className={`jb-line ${l.level}`}>
          <span className="jb-time">{l.time.slice(11, 19)}</span>
          <span className="jb-msg">{l.message}</span>
        </div>
      ))}
    </div>
  );
}

function JobItem({
  job,
  now,
  project,
}: {
  job: JobRecord;
  now: number;
  /** The project's name, for a job running in another project. */
  project?: string | undefined;
}) {
  const t = useT();
  const lines = useJobs((s) => s.logs[job.id]) ?? [];
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="jb-job" data-job={job.id}>
      <Row
        kind="tree"
        label={
          <span className="jb-head">
            <JobRing job={job} />
            <span className="jb-title">{jobTitleFor(job)}</span>
          </span>
        }
        count={pct(job.progress)}
      />
      <div className="jb-body">
        <div className="jb-meta">
          <StatusChip status={job.status} />
          <span className="mono">{duration(job, now)}</span>
          {project !== undefined && <span className="jb-project">{project}</span>}
        </div>
        {job.steps.length > 0 && <Steps steps={job.steps} />}
        <LogTail lines={lines} />
        {error && (
          <p className="jb-err" role="alert">
            {error}
          </p>
        )}
        <div className="jb-acts">
          <Button
            variant="danger"
            icon="x"
            disabled={job.status === 'cancelling'}
            onClick={() => {
              void jobs.getState().cancel(job.id).then(setError);
            }}
          >
            {t('bench.jobs.cancel')}
          </Button>
          <Button
            icon="link"
            onClick={() => {
              processing.getState().openDrawer(job.id);
            }}
          >
            {t('bench.jobs.open')}
          </Button>
        </div>
      </div>
    </li>
  );
}

/** Oldest first, the order they started in. */
const byStart = (a: JobRecord, b: JobRecord) =>
  (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0);

export function JobsBench() {
  const t = useT();
  const all = useJobs((s) => s.jobs);
  const root = useWorkspace((s) => s.project?.root ?? null);
  const pkg = useShell((s) => s.pkg !== null);
  const library = useShell((s) => s.library);
  const own = pkg ? null : root;
  const mine = useMemo(
    () => projectJobs(all, own).running.filter(isActive).sort(byStart),
    [all, own],
  );
  const elsewhere = useMemo(() => [...runningElsewhere(all, own)].sort(byStart), [all, own]);
  const now = useNow(mine.length + elsewhere.length > 0);
  if (mine.length + elsewhere.length === 0) {
    return <EmptyState icon="clock" title={t('bench.jobs.none')} body={t('bench.jobs.noneBody')} />;
  }
  return (
    <ul className="jb wb-scroll" aria-label={t('wb.jobs')}>
      {mine.map((job) => (
        <JobItem key={job.id} job={job} now={now} />
      ))}
      {elsewhere.map((job) => (
        <JobItem
          key={job.id}
          job={job}
          now={now}
          project={projectLabel(job.project, library ?? [])}
        />
      ))}
    </ul>
  );
}
