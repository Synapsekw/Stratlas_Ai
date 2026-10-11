/**
 * Settings, Processing tools, **Advanced: run a pipeline directly**: every pipeline of the
 * processing tools with its own form, and every job on this computer whichever project it
 * belongs to. For support and the automated tests; folded until asked for.
 */
import { t, useT } from '@aio/ui';
import { useEffect, useState } from 'react';
import { isActive } from '../jobs';
import { jobs, useJobs, useShell } from '../shell';
import { JobDetail } from './JobDetail';
import { JobRow } from './JobList';
import { useNow } from './JobParts';
import { projectLabel } from './model';
import { PipelineForm } from './PipelineForm';
import './processing.css';

export function AdvancedPipelines() {
  useT();
  const [open, setOpen] = useState(false);
  const list = useJobs((s) => s.jobs);
  const selected = useJobs((s) => s.selected);
  const library = useShell((s) => s.library);
  const now = useNow(open && list.some(isActive));
  const job = list.find((j) => j.id === selected);
  useEffect(() => {
    if (open) void jobs.getState().refresh();
  }, [open]);
  return (
    <details
      className="sblock proc-adv"
      data-testid="job-advanced"
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
      }}
    >
      <summary>{t('processing.advanced.title')}</summary>
      {open && (
        <>
          <p className="help">{t('processing.advanced.help')}</p>
          <PipelineForm />
          <h3 className="caps">{t('processing.advanced.all')}</h3>
          {list.length === 0 ? (
            <p className="help" data-testid="jobs-none">
              {t('processing.advanced.none')}
            </p>
          ) : (
            <div className="jobs-list" role="list" aria-label={t('processing.advanced.all')}>
              {list.map((j) => (
                <JobRow
                  key={j.id}
                  job={j}
                  selected={j.id === job?.id}
                  now={now}
                  project={projectLabel(j.project, library ?? [])}
                  onPick={() => {
                    void jobs.getState().select(j.id);
                  }}
                />
              ))}
            </div>
          )}
          {job && <JobDetail job={job} now={now} />}
        </>
      )}
    </details>
  );
}
