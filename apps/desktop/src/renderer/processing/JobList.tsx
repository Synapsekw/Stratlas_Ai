/** One job as a row: its plain title, kind, status, times and progress. */
import type { JobRecord } from '@aio/schema';
import { Icon, t } from '@aio/ui';
import { Bar, clock, duration, StatusChip } from './JobParts';
import { jobKind, jobTitle, KIND_LABEL } from './pipelines';
import './processing.css';

export function JobRow({
  job,
  selected,
  now,
  project,
  onPick,
  onRemove,
}: {
  job: JobRecord;
  selected: boolean;
  now: number;
  /** The project's name, where the list holds more than one project's jobs. */
  project?: string | undefined;
  onPick: () => void;
  /** A finished job's **Remove from list** (only the list entry goes, never its outputs). */
  onRemove?: (() => void) | undefined;
}) {
  const kind = jobKind(job.pipeline);
  const row = (
    <button
      type="button"
      role={onRemove ? undefined : 'listitem'}
      className="job-row"
      aria-current={selected ? 'true' : undefined}
      data-job={job.id}
      data-kind={kind}
      onClick={onPick}
    >
      <span className="jr-top">
        <b>{jobTitle(job.pipeline)}</b>
        <StatusChip status={job.status} />
      </span>
      <span className="jr-sub">
        <span className="jr-kind">{t(KIND_LABEL[kind])}</span>
        {project !== undefined && <span className="mono">{project}</span>}
        <span>
          {clock(job.createdAt)} · {duration(job, now)}
        </span>
      </span>
      <Bar job={job} />
    </button>
  );
  if (!onRemove) return row;
  return (
    <div role="listitem" className="job-row-wrap">
      {row}
      <button
        type="button"
        className="btn ghost icon sm job-remove"
        aria-label={t('processing.remove')}
        title={t('processing.remove')}
        data-testid="job-remove"
        onClick={onRemove}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
