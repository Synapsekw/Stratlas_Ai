/**
 * One processing run (G4): progress per stage with pause, resume and cancel; ground control; the
 * accuracy report; **Use refined poses**. The run's files are the truth (`run.json`, `gcp.json`,
 * `report/accuracy.json`); the jobs of the run give the live progress.
 */
import type { AccuracyReport, JobRecord, PhotoRun } from '@aio/schema';
import { Icon, useFocusTrap } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { isActive } from '../jobs';
import { bridge, shell, useJobs } from '../shell';
import { cancelRun, pauseJob, resumeJob, startProducts } from './actions';
import { AccuracyReportView } from './AccuracyReport';
import { defaultProducts, presetLabel } from './estimate';
import { GcpPanel } from './GcpTable';
import { RUN_STATUS, runView, type PhaseState } from './phases';
import { RefinedPoses } from './RefinedPoses';
import { jobsOfRun, photoUi, STAGE_WORDS, usePhotoUi, type RunTab } from './store';

const TABS: readonly { id: RunTab; label: string }[] = [
  { id: 'progress', label: 'Progress' },
  { id: 'gcp', label: 'Ground control' },
  { id: 'report', label: 'Accuracy' },
  { id: 'poses', label: 'Refined poses' },
];

const JOB_WORDS: Record<JobRecord['status'], string> = {
  starting: 'Starting',
  running: 'Running',
  cancelling: 'Stopping',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
};

const PHASE_WORDS: Record<PhaseState, string> = {
  pending: 'waiting',
  running: 'working',
  done: 'done',
  kept: 'kept from before',
  stopped: 'stopped',
  failed: 'failed',
};

export function RunPanel({ run, tab }: { run: string; tab: RunTab }) {
  const project = useWorkspace((s) => s.project);
  const version = usePhotoUi((s) => s.version);
  const allJobs = useJobs((s) => s.jobs);
  const dlg = useRef<HTMLDivElement>(null);
  const close = () => {
    photoUi.getState().close();
  };
  useFocusTrap(dlg, true, { onEscape: close });
  const [data, setData] = useState<{ run: PhotoRun; accuracy: AccuracyReport | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = project?.root ?? '';
  const runJobs = jobsOfRun(allJobs, root, run);
  // read the run again whenever one of its jobs changes state
  const jobsKey = runJobs.map((j) => `${j.id}:${j.status}`).join(',');

  useEffect(() => {
    if (!project) return;
    let live = true;
    void bridge.call('photo:readRun', { projectId: project.id, run }).then((r) => {
      if (!live) return;
      if (!r.ok) setError(r.error);
      else if (!r.value.ok) {
        // the run folder appears with the first stage of the alignment
        setError(runJobs.length ? null : r.value.error);
        setData(null);
      } else {
        setError(null);
        setData({ run: r.value.run, accuracy: r.value.accuracy });
      }
    });
    return () => {
      live = false;
    };
    // jobsKey stands for the run's jobs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, run, version, jobsKey]);

  if (!project) return null;
  const preset = data?.run.preset;
  return (
    <div
      ref={dlg}
      className="b-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={`Photo run ${run}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="ph-panel" data-testid="photo-run">
        <header className="ph-head" role="none">
          <div>
            <h2>Photo run {run}</h2>
            <p className="small faint">
              {data
                ? `${RUN_STATUS[data.run.status]} · ${preset ? presetLabel(preset) : ''} · ${String(data.run.photos.count)} photos`
                : 'Starting'}
            </p>
          </div>
          <button type="button" className="btn ghost sm" onClick={close} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className="ph-tabs" role="tablist" aria-label="Run">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`ph-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="ph-tabpanel"
              onClick={() => {
                photoUi.getState().setTab(t.id);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="ph-body" role="tabpanel" id="ph-tabpanel" aria-labelledby={`ph-tab-${tab}`}>
          {error && (
            <p className="notice danger small" role="alert">
              <Icon name="warn" size={14} />
              {error}
            </p>
          )}
          {tab === 'progress' && <Progress run={run} data={data?.run ?? null} jobs={runJobs} />}
          {tab === 'gcp' && <GcpPanel run={run} data={data?.run ?? null} />}
          {tab === 'report' && (
            <AccuracyReportView run={data?.run ?? null} report={data?.accuracy ?? null} />
          )}
          {tab === 'poses' && <RefinedPoses run={run} data={data?.run ?? null} />}
        </div>
      </div>
    </div>
  );
}

function Progress({ run, data, jobs }: { run: string; data: PhotoRun | null; jobs: JobRecord[] }) {
  const project = useWorkspace((s) => s.project);
  const pending = usePhotoUi((s) => s.pending[run]);
  const stopped = usePhotoUi((s) => s.stopped[run]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (p: Promise<string | null>) => {
    setBusy(true);
    setError(await p);
    setBusy(false);
  };
  if (!project) return null;
  // matching the photos and building the maps are two jobs: one run, one list of steps
  const view = runView(jobs, pending ? pending.products : null);
  const job = view.job;
  const active = job ? isActive(job) : false;
  const resumable = job ? ['failed', 'cancelled', 'interrupted'].includes(job.status) : false;
  const aligned = data ? ['aligned', 'adjusted', 'done'].includes(data.status) : false;
  const productsJob = jobs.find((j) => j.pipeline === 'photo.products');
  const layerNames = (data?.outputs.layers ?? []).map(
    (id) => project.manifest.layers.find((l) => l.id === id)?.name ?? id,
  );
  const ready = data?.status === 'done' && layerNames.length > 0 && !active && !view.between;
  // between the two jobs the run is still at work
  const status = job ? (view.between ? 'starting' : job.status) : 'starting';
  const statusWord = view.between
    ? 'Working'
    : job && stopped === 'paused' && job.status === 'cancelled'
      ? 'Paused'
      : job
        ? JOB_WORDS[job.status]
        : '';
  const show = (mode: 'map' | '3d') => {
    photoUi.getState().close();
    shell.getState().go('scene');
    shell.getState().setStageMode(mode);
  };

  return (
    <div className="ph-progress">
      {!job && !data && <p className="faint small">Getting ready.</p>}

      {ready && (
        <section className="ph-ready" aria-label="Results" data-testid="photo-results">
          <h3>
            <Icon name="check" size={16} />
            Your maps are ready
          </h3>
          <p className="small">Added to the project as new layers:</p>
          <ul>
            {layerNames.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <div className="ph-acts">
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                show('map');
              }}
            >
              <Icon name="map" size={14} />
              Show on map
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                show('3d');
              }}
            >
              <Icon name="scene" size={14} />
              Show in 3D
            </button>
          </div>
          <p className="small faint ph-improve">
            Need survey accuracy?{' '}
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                photoUi.getState().setTab('gcp');
              }}
            >
              <Icon name="target" size={14} />
              Improve accuracy with ground control points
            </button>
          </p>
        </section>
      )}

      {job && (
        <section aria-label="Progress of the run" className="ph-job" data-testid="photo-job">
          <div className="ph-job-h">
            <b>{view.headline ?? 'Finished'}</b>
            <span className={`ph-state ${status}`} data-status={status}>
              {statusWord}
            </span>
            <span className="mono faint">{view.percent}%</span>
          </div>
          <span
            className="job-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={view.percent}
            aria-label="Progress of the run"
          >
            <i style={{ width: `${String(view.percent)}%` }} />
          </span>
          <ol className="ph-phases" aria-label="Steps" data-testid="photo-phases">
            {view.phases.length === 0 && <li className="faint">Getting ready.</li>}
            {view.phases.map((p) => (
              <li key={p.id} data-phase={p.id} data-state={p.state}>
                <span className="si">
                  {p.state === 'done' || p.state === 'kept' ? (
                    <Icon name="check" size={12} />
                  ) : p.state === 'failed' ? (
                    <Icon name="x" size={12} />
                  ) : (
                    <i />
                  )}
                </span>
                <span>{p.label}</span>
                <span className="faint small">{PHASE_WORDS[p.state]}</span>
              </li>
            ))}
          </ol>
          {job.steps.length > 0 && (
            <details className="ph-detail">
              <summary>Every step</summary>
              {job.message && <p className="small faint">{job.message}</p>}
              <ol className="ph-stages" aria-label="Stages">
                {job.steps.map((s) => (
                  <li key={s.name} data-state={s.state}>
                    <span className="si">
                      {s.state === 'done' || s.state === 'skipped' ? (
                        <Icon name="check" size={12} />
                      ) : s.state === 'failed' ? (
                        <Icon name="x" size={12} />
                      ) : (
                        <i />
                      )}
                    </span>
                    <span>{STAGE_WORDS[s.name] ?? s.title ?? s.name}</span>
                    <span className="faint small">
                      {s.state === 'skipped' ? 'kept from before' : s.state}
                    </span>
                  </li>
                ))}
              </ol>
            </details>
          )}
          {job.error && (
            <p className="notice danger small" role="alert">
              <Icon name="warn" size={14} />
              {job.error}
            </p>
          )}
          <div className="ph-acts">
            {active && (
              <>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy || job.status === 'cancelling'}
                  onClick={() => void act(pauseJob(run, job.id))}
                >
                  <Icon name="pause" size={14} />
                  Pause
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={busy || job.status === 'cancelling'}
                  onClick={() => void act(cancelRun(run, job.id))}
                >
                  <Icon name="x" size={14} />
                  Cancel
                </button>
              </>
            )}
            {resumable && stopped !== 'cancelled' && (
              <button
                type="button"
                className="btn sm primary"
                disabled={busy}
                onClick={() => void act(resumeJob(run, job.id))}
              >
                <Icon name="refresh" size={14} />
                Resume
              </button>
            )}
            {resumable && stopped === 'cancelled' && (
              <p className="small faint">
                Cancelled. The work so far is kept;{' '}
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={busy}
                  onClick={() => void act(resumeJob(run, job.id))}
                >
                  resume it
                </button>{' '}
                to continue from the stage it stopped at.
              </p>
            )}
          </div>
        </section>
      )}

      {aligned && !pending && !productsJob && (
        <section className="ph-next" aria-label="Next steps">
          <p className="small">
            The photos are matched. Mark ground control points for survey accuracy, or create the
            maps now.
          </p>
          <div className="ph-acts">
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                photoUi.getState().setTab('gcp');
              }}
            >
              <Icon name="target" size={14} />
              Ground control points
            </button>
            <button
              type="button"
              className="btn sm primary"
              disabled={busy}
              onClick={() =>
                void act(
                  startProducts(run, {
                    root: project.root,
                    preset: data?.preset ?? 'standard',
                    products: defaultProducts(data?.preset ?? 'standard'),
                  }),
                )
              }
            >
              <Icon name="layers" size={14} />
              Create maps
            </button>
          </div>
        </section>
      )}

      {data?.warnings && data.warnings.length > 0 && (
        <ul className="ph-warn small" aria-label="Warnings">
          {data.warnings.slice(0, 20).map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {data?.photos.rejected && data.photos.rejected.length > 0 && (
        <details className="small">
          <summary>
            {data.photos.rejected.length} {data.photos.rejected.length === 1 ? 'photo' : 'photos'}{' '}
            left out
          </summary>
          <ul>
            {data.photos.rejected.map((r) => (
              <li key={r.name}>
                <span className="mono">{r.name}</span>: {r.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && (
        <p className="notice danger small" role="alert">
          <Icon name="warn" size={14} />
          {error}
        </p>
      )}
    </div>
  );
}
