/** One job as a row: its plain title, kind, status, times and progress. */
import type { JobRecord } from '@aio/schema';
import { t } from '@aio/ui';
import { Bar, clock, duration, StatusChip } from './JobParts';
import { jobKind, jobTitle, KIND_LABEL } from './pipelines';
import './processing.css';

export function JobRow({
  job,
  selected,
  now,
  project,
  onPick,
}: {
  job: JobRecord;
  selected: boolean;
  now: number;
  /** The project's name, where the list holds more than one project's jobs. */
  project?: string | undefined;
  onPick: () => void;
}) {
  const kind = jobKind(job.pipeline);
  return (
    <button
      type="button"
      role="listitem"
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
}
