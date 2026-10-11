import { Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import { isActive, type JobDraft } from '../jobs';
import { PhotoRuns } from '../photogrammetry/PhotoRuns';
import { JobDetail } from '../processing/JobDetail';
import { JobRow } from '../processing/JobList';
import { useNow } from '../processing/JobParts';
import { PipelineForm } from '../processing/PipelineForm';
import { openProcessingTools } from '../processingTools';
import { jobs, useJobs, useShell } from '../shell';
import { openJobTask } from './jobTaskActions';
import {
  JOB_TASK_SECTIONS,
  PRIMARY_TASK,
  taskBlocked,
  tasksOf,
  type JobTask,
  type TaskContext,
} from './jobTasks';

const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? p;

// ---------------------------------------------------------------- new job

function TaskCard({
  task,
  blocked,
  onOpen,
}: {
  task: JobTask;
  blocked: string | null;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={`nj-task${task.id === PRIMARY_TASK ? ' primary' : ''}`}
      data-task={task.id}
      // stays focusable when it cannot open, so the reason is reachable by keyboard
      aria-disabled={blocked !== null}
      onClick={() => {
        if (blocked === null) onOpen();
      }}
    >
      <Icon name={task.icon} size={task.id === PRIMARY_TASK ? 20 : 16} />
      <b>{task.title}</b>
      <small>{task.hint}</small>
      {blocked && <small className="nj-need">{blocked}</small>}
    </button>
  );
}

/**
 * **New job**: a short list of tasks, each opening the guided screen that does it; the pipelines
 * themselves under **Advanced**. A draft from elsewhere (road setup) opens straight on its form.
 */
function NewJobPanel({ onClose, draft }: { onClose: () => void; draft: JobDraft | null }) {
  const project = useWorkspace((s) => s.project);
  const [tasks, setTasks] = useState(draft === null);
  const [advanced, setAdvanced] = useState(draft !== null);
  const ctx: TaskContext = {
    project: project !== null,
    surveyDates: project?.manifest.captures.length ?? 0,
  };
  const open = (task: JobTask) => {
    openJobTask(task.id);
    onClose();
  };
  return (
    <section className="job-new" aria-label="New job" data-testid="job-chooser">
      <header className="jn-h">
        <div>
          <h2>New job</h2>
          <p className="muted">
            {tasks
              ? 'Choose what you want to do. Each one opens the screen that guides you through it.'
              : 'Check the form, then start the job.'}
          </p>
        </div>
        <button type="button" className="btn ghost sm" onClick={onClose} aria-label="Close">
          <Icon name="x" size={14} />
        </button>
      </header>

      {tasks ? (
        JOB_TASK_SECTIONS.map((s) => (
          <div key={s.id} className="jn-sec" role="group" aria-label={s.label}>
            <h3 className="caps">{s.label}</h3>
            <div className="jn-tasks">
              {tasksOf(s.id).map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  blocked={taskBlocked(task, ctx)}
                  onOpen={() => {
                    open(task);
                  }}
                />
              ))}
            </div>
          </div>
        ))
      ) : (
        <div>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              setTasks(true);
            }}
          >
            <Icon name="back" size={14} />
            All tasks
          </button>
        </div>
      )}

      <details
        className="jn-adv"
        open={advanced}
        data-testid="job-advanced"
        onToggle={(e) => {
          setAdvanced(e.currentTarget.open);
        }}
      >
        <summary>Advanced: run a pipeline directly</summary>
        <p className="nj-help">
          Every pipeline of the processing tools with its own parameters, for when no guided screen
          fits.
        </p>
        <PipelineForm draft={draft} onClose={onClose} />
      </details>
    </section>
  );
}

// ---------------------------------------------------------------- screen

export function JobsScreen() {
  const list = useJobs((s) => s.jobs);
  const selected = useJobs((s) => s.selected);
  const runtime = useJobs((s) => s.runtime);
  const loadError = useJobs((s) => s.error);
  const hasProject = useWorkspace((s) => s.project !== null);
  const pkg = useShell((s) => s.pkg);
  // A form filled in elsewhere (road setup) opens on arrival; it is used once.
  const [draft] = useState(() => jobs.getState().draft);
  const [creating, setCreating] = useState(draft !== null);
  const closeNew = () => {
    setCreating(false);
  };
  const anyActive = list.some(isActive);
  const now = useNow(anyActive);
  const job = list.find((j) => j.id === selected) ?? list[0];

  useEffect(() => {
    void jobs.getState().refresh();
    jobs.getState().prepare(null);
  }, []);

  const active = list.filter(isActive);
  const finished = list.filter((j) => !isActive(j));

  return (
    <div className="screen jobs" role="region" aria-label="Jobs">
      <aside className="jobs-side">
        <header className="jobs-h">
          <div>
            <h1>Jobs</h1>
            <p className="muted">Processing that runs on this computer.</p>
          </div>
          {!creating && (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setCreating(true);
              }}
            >
              <Icon name="plus" size={14} />
              New job
            </button>
          )}
        </header>
        <div className="jobs-go">
          <button
            type="button"
            className="btn primary"
            data-testid="create-maps"
            disabled={!hasProject || pkg !== null}
            aria-describedby={hasProject ? undefined : 'jobs-go-need'}
            onClick={() => {
              openJobTask(PRIMARY_TASK);
            }}
          >
            <Icon name="photo" size={16} />
            Create maps from photos
          </button>
          {!hasProject && (
            <p className="nj-help" id="jobs-go-need">
              Open a project first. The maps are added to it.
            </p>
          )}
        </div>
        <div className={`jobs-rt${runtime?.found === false ? ' missing' : ''}`}>
          <Icon name={runtime?.found === false ? 'warn' : 'layers'} size={14} />
          {runtime === null ? (
            <span className="faint">Looking for the processing tools</span>
          ) : runtime.found ? (
            <span>
              Processing tools <b className="mono">{runtime.version}</b>
            </span>
          ) : (
            <div className="jobs-rt-fix">
              <span>Jobs cannot run yet: the processing tools are missing or need an update.</span>
              <button type="button" className="btn sm" onClick={openProcessingTools}>
                Update processing tools
              </button>
              <details>
                <summary>Details</summary>
                <span>{runtime.problem}</span>
              </details>
            </div>
          )}
        </div>
        {loadError && <p className="nj-err">{loadError}</p>}
        {/* a list only while it has jobs: an empty list role is announced as a broken list */}
        <div className="jobs-list" {...(list.length > 0 && { role: 'list', 'aria-label': 'Jobs' })}>
          {active.length > 0 && <div className="jl-h caps">Running</div>}
          {active.map((j) => (
            <JobRow
              key={j.id}
              job={j}
              selected={!creating && j.id === job?.id}
              now={now}
              project={baseName(j.project)}
              onPick={() => {
                closeNew();
                void jobs.getState().select(j.id);
              }}
            />
          ))}
          {finished.length > 0 && <div className="jl-h caps">Finished</div>}
          {finished.map((j) => (
            <JobRow
              key={j.id}
              job={j}
              selected={!creating && j.id === job?.id}
              now={now}
              project={baseName(j.project)}
              onPick={() => {
                closeNew();
                void jobs.getState().select(j.id);
              }}
            />
          ))}
          {list.length === 0 && (
            <div className="side-empty">
              <Icon name="clock" size={20} />
              <p>Nothing is running and nothing has finished yet.</p>
            </div>
          )}
        </div>
        <PhotoRuns selected={creating ? undefined : job} />
      </aside>
      {creating ? (
        <NewJobPanel draft={draft} onClose={closeNew} />
      ) : job ? (
        <JobDetail job={job} now={now} />
      ) : (
        <section className="job-detail empty">
          <div className="side-empty">
            <Icon name="clock" size={20} />
            <p>Progress, steps and the live log of a job show here.</p>
          </div>
        </section>
      )}
    </div>
  );
}
