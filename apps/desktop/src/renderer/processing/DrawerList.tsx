/**
 * The list view of the Processing drawer, from props only: the one start button, the tools
 * notice, the open project's running and finished jobs, its maps from photos (the slot) and what
 * runs in other projects. With no project of its own, only the last part.
 */
import type { JobRecord } from '@aio/schema';
import { Icon, t } from '@aio/ui';
import { useState, type ReactNode } from 'react';
import { JobRow } from './JobList';
import './processing.css';

/** Finished jobs shown before **Show older**. */
export const FINISHED_SHOWN = 20;

export interface DrawerListProps {
  /** The open project's name; null with no project of its own (none open, or a package). */
  projectName: string | null;
  /** A read-only package is open: no project of its own, and it says so. */
  readOnlyPackage?: boolean;
  running: readonly JobRecord[];
  finished: readonly JobRecord[];
  elsewhere: readonly { job: JobRecord; project: string }[];
  toolsMissing: boolean;
  /** Why the job list could not be read (`jobs:list` failed), or null. */
  error?: string | null;
  now: number;
  onPick: (id: string) => void;
  onCreateMaps: () => void;
  onUpdateTools: () => void;
  /**
   * Take finished jobs off the list (a row's remove, or **Clear finished**). Without it, finished
   * rows have no remove.
   */
  onRemove?: (ids: string[]) => void;
  /** The project's maps from photos (`PhotoRuns`), shown under Finished. */
  children?: ReactNode;
}

export function DrawerList({
  projectName,
  readOnlyPackage = false,
  running,
  finished,
  elsewhere,
  toolsMissing,
  error = null,
  now,
  onPick,
  onCreateMaps,
  onUpdateTools,
  onRemove,
  children,
}: DrawerListProps) {
  const [older, setOlder] = useState(false);
  const own = projectName !== null;
  const shown = older ? finished : finished.slice(0, FINISHED_SHOWN);
  // Clear finished leaves interrupted jobs: they wait for Resume (each keeps its own remove)
  const clearable = finished.filter((j) => j.status !== 'interrupted').map((j) => j.id);
  const row = (job: JobRecord, project?: string, removable = false) => (
    <JobRow
      key={job.id}
      job={job}
      selected={false}
      now={now}
      project={project}
      onPick={() => {
        onPick(job.id);
      }}
      onRemove={
        removable && onRemove
          ? () => {
              onRemove([job.id]);
            }
          : undefined
      }
    />
  );
  return (
    <div className="proc-list">
      {own && (
        // without the tools it cannot run: it opens the dialog that says so, and the update below
        // is the primary instead
        <button
          type="button"
          className={toolsMissing ? 'btn proc-go' : 'btn primary proc-go'}
          data-testid="create-maps"
          onClick={onCreateMaps}
        >
          <Icon name="photo" size={16} />
          {t('processing.createMaps')}
        </button>
      )}
      {own && toolsMissing && (
        <div className="proc-tools" data-testid="proc-tools">
          <Icon name="warn" size={14} />
          <span>{t('processing.toolsMissing')}</span>
          <button type="button" className="btn sm primary" onClick={onUpdateTools}>
            {t('processing.toolsUpdate')}
          </button>
        </div>
      )}
      {error && (
        <p className="nj-err" role="alert" data-testid="proc-error">
          {error}
        </p>
      )}
      {own && running.length > 0 && (
        <section data-testid="proc-running">
          <h3 className="caps">{t('processing.running')}</h3>
          <div role="list" aria-label={t('processing.running')}>
            {running.map((j) => row(j))}
          </div>
        </section>
      )}
      {own && finished.length > 0 && (
        <section data-testid="proc-finished">
          <div className="proc-sh">
            <h3 className="caps">{t('processing.finished')}</h3>
            {onRemove && clearable.length > 0 && (
              <button
                type="button"
                className="btn sm ghost"
                data-testid="proc-clear"
                onClick={() => {
                  onRemove(clearable);
                }}
              >
                {t('processing.clearFinished')}
              </button>
            )}
          </div>
          <div role="list" aria-label={t('processing.finished')}>
            {shown.map((j) => row(j, undefined, true))}
          </div>
          {!older && finished.length > FINISHED_SHOWN && (
            <button
              type="button"
              className="btn sm ghost"
              data-testid="proc-older"
              onClick={() => {
                setOlder(true);
              }}
            >
              {t('processing.older')}
            </button>
          )}
        </section>
      )}
      {own && !error && running.length === 0 && finished.length === 0 && (
        <p className="proc-empty faint" data-testid="proc-empty">
          {t('processing.empty', { name: projectName })}
        </p>
      )}
      {own && children}
      {elsewhere.length > 0 && (
        <section data-testid="proc-elsewhere">
          <h3 className="caps">{t('processing.elsewhere')}</h3>
          <div role="list" aria-label={t('processing.elsewhere')}>
            {elsewhere.map((e) => row(e.job, e.project))}
          </div>
        </section>
      )}
      {!own && !error && elsewhere.length === 0 && (
        <p className="proc-empty faint" data-testid="proc-none">
          {t(readOnlyPackage ? 'processing.noPackage' : 'processing.noProject')}
        </p>
      )}
    </div>
  );
}
