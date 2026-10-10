import {
  PIPELINES,
  type JobLogLine,
  type JobRecord,
  type JobStep,
  type PipelineName,
} from '@aio/schema';
import { Icon, t, type IconName } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { buildParams, canResume, FORMS, isActive, type Field, type JobDraft } from '../jobs';
import { PhotoRuns } from '../photogrammetry/PhotoRuns';
import { openProcessingTools } from '../photogrammetry/processingTools';
import { bridge, jobs, useJobs, useShell } from '../shell';
import { openJobTask } from './jobTaskActions';
import {
  groupedPipelines,
  JOB_TASK_SECTIONS,
  jobTitle,
  PRIMARY_TASK,
  taskBlocked,
  tasksOf,
  type JobTask,
  type TaskContext,
} from './jobTasks';

const STATUS: Record<JobRecord['status'], { label: string; tone: string }> = {
  starting: { label: 'Starting', tone: 'run' },
  running: { label: 'Running', tone: 'run' },
  cancelling: { label: 'Stopping', tone: 'warn' },
  done: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'idle' },
  interrupted: { label: 'Interrupted', tone: 'warn' },
};

const STEP_ICON: Record<JobStep['state'], IconName | null> = {
  pending: null,
  running: null,
  done: 'check',
  skipped: 'check',
  failed: 'x',
  cancelled: 'minus',
};

const titleOf = jobTitle;
const PIPELINE_AREAS = groupedPipelines(PIPELINES);
const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? p;
const pct = (f: number) => `${String(Math.round(f * 100))}%`;

function clock(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function duration(job: JobRecord, now: number): string {
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  const s = Math.max(0, Math.round((end - Date.parse(job.createdAt)) / 1000));
  if (s < 60) return `${String(s)} s`;
  const m = Math.floor(s / 60);
  return m < 60
    ? `${String(m)} min ${String(s % 60)} s`
    : `${String(Math.floor(m / 60))} h ${String(m % 60)} min`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, [active]);
  return now;
}

function StatusChip({ status }: { status: JobRecord['status'] }) {
  const s = STATUS[status];
  return (
    <span className={`job-state ${s.tone}`} data-status={status}>
      <i />
      {s.label}
    </span>
  );
}

function Bar({ job }: { job: JobRecord }) {
  return (
    <span
      className={`job-bar ${STATUS[job.status].tone}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(job.progress * 100)}
      aria-label={`${titleOf(job.pipeline)} progress`}
    >
      <i style={{ width: pct(job.progress) }} />
    </span>
  );
}

// ---------------------------------------------------------------- new job

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = `job-f-${field.key}`;
  if (field.kind === 'list') {
    const ticked = new Set(value.split(',').filter(Boolean));
    return (
      <div className="nj-field">
        <span id={`${id}-l`} className="nj-label">
          {field.label}
          {field.required && <span className="req"> required</span>}
        </span>
        <div className="nj-list" role="group" aria-labelledby={`${id}-l`}>
          {(field.options ?? []).map((o) => (
            <label key={o.value} className="nj-tick">
              <input
                type="checkbox"
                checked={ticked.has(o.value)}
                onChange={(e) => {
                  const next = new Set(ticked);
                  if (e.target.checked) next.add(o.value);
                  else next.delete(o.value);
                  // in the order of the choices
                  onChange(
                    (field.options ?? [])
                      .map((x) => x.value)
                      .filter((v) => next.has(v))
                      .join(','),
                  );
                }}
              />
              {o.label}
            </label>
          ))}
        </div>
        {field.help && <p className="nj-help">{field.help}</p>}
      </div>
    );
  }
  return (
    <div className="nj-field">
      <label htmlFor={id}>
        {field.label}
        {field.required && <span className="req"> required</span>}
      </label>
      {field.kind === 'select' ? (
        <select
          id={id}
          className="input"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        >
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <div className="nj-row">
          <input
            id={id}
            className={`input${field.kind === 'number' || field.kind === 'origin' ? '' : ' mono'}`}
            value={value}
            placeholder={field.placeholder}
            spellCheck={false}
            inputMode={field.kind === 'number' ? 'decimal' : undefined}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
          {field.kind === 'folder' && (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                void bridge.call('dialog:openFolder', { title: field.label }).then((r) => {
                  if (r.ok && r.value.path) onChange(r.value.path);
                });
              }}
            >
              Choose
            </button>
          )}
          {(field.kind === 'file' || field.kind === 'files') && (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                const multi = field.kind === 'files';
                void bridge
                  .call('dialog:openFiles', {
                    title: field.label,
                    ...(field.filters ? { filters: field.filters } : {}),
                    multi,
                  })
                  .then((r) => {
                    if (r.ok && r.value.paths.length) onChange(r.value.paths.join('; '));
                  });
              }}
            >
              {t('jobs.chooseFile')}
            </button>
          )}
        </div>
      )}
      {field.help && <p className="nj-help">{field.help}</p>}
    </div>
  );
}

/** The form of one pipeline, as the pack takes it: the Advanced way to start a job. */
function PipelineForm({ onClose, draft }: { onClose: () => void; draft?: JobDraft | null }) {
  const projectRoot = useWorkspace((s) => s.project?.root);
  const projectType = useWorkspace((s) => s.project?.manifest.type);
  const runtime = useJobs((s) => s.runtime);
  const [pipeline, setPipeline] = useState<PipelineName>(
    draft?.pipeline ?? (projectType === 'inspection' ? 'inspection.run' : 'aik.cameras'),
  );
  const [project, setProject] = useState(draft?.project ?? projectRoot ?? '');
  const [values, setValues] = useState<Record<string, string>>(draft?.values ?? {});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const info = PIPELINES.find((p) => p.name === pipeline);

  const submit = async () => {
    if (!project.trim()) {
      setError('Choose the project folder the job writes into.');
      return;
    }
    const built = buildParams(pipeline, values);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    const err = await jobs
      .getState()
      .start({ pipeline, project: project.trim(), params: built.params });
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <form
      className="new-job"
      aria-label="Run a pipeline"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="nj-field">
        <label htmlFor="job-pipeline">Pipeline</label>
        <select
          id="job-pipeline"
          className="input"
          value={pipeline}
          onChange={(e) => {
            setPipeline(e.target.value as PipelineName);
            setValues({});
            setError(null);
          }}
        >
          {PIPELINE_AREAS.map((g) => (
            <optgroup key={g.id} label={g.label}>
              {g.pipelines.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {info && <p className="nj-help">{info.description}</p>}
      </div>
      <FieldInput
        field={{
          key: 'project',
          label: 'Project folder',
          kind: 'folder',
          required: true,
          help: 'Outputs and the job folder (jobs\\<id>) are written here.',
        }}
        value={project}
        onChange={(v) => {
          setProject(v);
          setError(null);
        }}
      />
      {FORMS[pipeline].map((f) => (
        <FieldInput
          key={`${pipeline}-${f.key}`}
          field={f}
          value={values[f.key] ?? ''}
          onChange={(v) => {
            setValues({ ...values, [f.key]: v });
            setError(null);
          }}
        />
      ))}
      {error && (
        <p className="nj-err" role="alert">
          {error}
        </p>
      )}
      <div className="nj-acts">
        <button type="button" className="btn sm ghost" onClick={onClose}>
          Close
        </button>
        <button
          type="submit"
          className="btn sm primary"
          disabled={busy || runtime?.found === false}
          data-testid="job-start"
        >
          <Icon name="play" size={14} />
          {busy ? 'Starting' : 'Start job'}
        </button>
      </div>
    </form>
  );
}

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

// ---------------------------------------------------------------- list

function JobRow({
  job,
  selected,
  now,
  onPick,
}: {
  job: JobRecord;
  selected: boolean;
  now: number;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="listitem"
      className="job-row"
      aria-current={selected ? 'true' : undefined}
      data-job={job.id}
      onClick={() => {
        onPick();
        void jobs.getState().select(job.id);
      }}
    >
      <span className="jr-top">
        <b>{titleOf(job.pipeline)}</b>
        <StatusChip status={job.status} />
      </span>
      <span className="jr-sub">
        <span className="mono">{baseName(job.project)}</span>
        <span>
          {clock(job.createdAt)} · {duration(job, now)}
        </span>
      </span>
      <Bar job={job} />
    </button>
  );
}

// ---------------------------------------------------------------- detail

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

function Detail({ job, now }: { job: JobRecord; now: number }) {
  const lines = useJobs((s) => s.logs[job.id]) ?? [];
  const [actionError, setActionError] = useState<string | null>(null);
  const act = async (p: Promise<string | null>) => {
    setActionError(await p);
  };
  const outputs = job.artifacts.filter((a) => !a.path.startsWith('jobs/'));
  const params = Object.entries(job.params);

  return (
    <section className="job-detail" aria-label="Job details">
      <header className="jd-h">
        <div className="jd-t">
          <h2>{titleOf(job.pipeline)}</h2>
          <span className="mono faint">{job.id}</span>
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

      <div className="jd-grid">
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
                  <span className="ss">
                    {s.state === 'skipped' ? 'kept from last run' : s.state}
                  </span>
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
        <div className="jd-col">
          <h3 className="caps">Job</h3>
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
          </dl>
        </div>
      </div>

      <h3 className="caps jd-logh">Log</h3>
      <LogTail lines={lines} />
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
              onPick={closeNew}
            />
          ))}
          {finished.length > 0 && <div className="jl-h caps">Finished</div>}
          {finished.map((j) => (
            <JobRow
              key={j.id}
              job={j}
              selected={!creating && j.id === job?.id}
              now={now}
              onPick={closeNew}
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
        <Detail job={job} now={now} />
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
