/**
 * Photo processing in the Jobs panel (G4): **Process photos**, the project's runs with their
 * status, preset, products and accuracy, and per run **Open run**, **Re-run products** and
 * **Delete run's work files** (only `work/`, to the recycle bin, after asking). A photo job
 * selected in the Jobs list opens its run.
 */
import type { JobRecord, PhotoRunSummary } from '@aio/schema';
import { Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import { bridge, useJobs, useShell } from '../shell';
import { startProducts } from './actions';
import { defaultProducts, formatBytes, PRESETS } from './estimate';
import { formatResidual } from './report';
import { photoUi, runOfJob, usePhotoUi } from './store';

const STATUS: Record<PhotoRunSummary['status'], string> = {
  aligning: 'Aligning',
  aligned: 'Aligned',
  adjusted: 'Adjusted',
  processing: 'Creating products',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const folderKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function PhotoRuns({ selected }: { selected?: JobRecord | undefined }) {
  const project = useWorkspace((s) => s.project);
  const pkg = useShell((s) => s.pkg);
  const version = usePhotoUi((s) => s.version);
  const jobsKey = useJobs((s) =>
    s.jobs
      .filter((j) => runOfJob(j))
      .map((j) => `${j.id}:${j.status}`)
      .join(','),
  );
  const [runs, setRuns] = useState<PhotoRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);

  const projectId = project?.id;
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    void bridge.call('photo:runs', { projectId }).then((r) => {
      if (!live) return;
      if (!r.ok) setError(r.error);
      else if (!r.value.ok) setError(r.value.error);
      else {
        setError(null);
        setRuns(r.value.runs);
      }
    });
    return () => {
      live = false;
    };
  }, [projectId, version, jobsKey]);

  if (!project) return null;
  const selectedRun =
    selected && folderKey(selected.project) === folderKey(project.root) ? runOfJob(selected) : null;

  const clean = async (run: string) => {
    setAsking(null);
    const r = await bridge.call('photo:cleanWork', { projectId: project.id, run });
    if (!r.ok) setError(r.error);
    else if (!r.value.ok) setError(r.value.error);
    else
      setNotice(
        r.value.freedBytes > 0
          ? `Moved ${formatBytes(r.value.freedBytes)} of work files of ${run} to the recycle bin.`
          : `Run ${run} has no work files.`,
      );
  };

  return (
    <section className="ph-runs" aria-label="Photo processing" data-testid="photo-runs">
      <header className="ph-runs-h">
        <h2 className="caps">Photo processing</h2>
        <button
          type="button"
          className="btn sm primary"
          disabled={pkg !== null}
          title={pkg ? 'A package is read only.' : undefined}
          onClick={() => {
            photoUi.getState().openWizard();
          }}
        >
          <Icon name="photo" size={14} />
          Process photos
        </button>
      </header>
      {selectedRun && (
        <button
          type="button"
          className="btn sm ph-open-job"
          onClick={() => {
            photoUi.getState().openRun(selectedRun);
          }}
        >
          <Icon name="link" size={14} />
          Open run {selectedRun}
        </button>
      )}
      {error && <p className="nj-err">{error}</p>}
      {notice && (
        <p className="small faint" role="status">
          {notice}
        </p>
      )}
      {runs?.length === 0 && (
        <p className="small faint">No photo runs in {project.manifest.name} yet.</p>
      )}
      {runs && runs.length > 0 && (
        <ul className="ph-run-list">
          {runs.map((r) => (
            <li key={r.id} data-run={r.id}>
              <div className="ph-run-top">
                <b className="mono">{r.id}</b>
                <span className="small">{STATUS[r.status]}</span>
              </div>
              <p className="small faint">
                {PRESETS.find((p) => p.id === r.preset)?.label} · {r.photos} photos
                {r.products.length ? ` · ${r.products.join(', ')}` : ''}
                {r.accuracy?.check
                  ? ` · checkpoints ${formatResidual(r.accuracy.check.horizontalM)}`
                  : ''}
              </p>
              <div className="ph-acts">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    photoUi.getState().openRun(r.id);
                  }}
                >
                  Open run
                </button>
                {!pkg && ['aligned', 'adjusted', 'done', 'failed'].includes(r.status) && (
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={() => {
                      void startProducts(r.id, {
                        root: project.root,
                        preset: r.preset,
                        products: r.products.length ? r.products : defaultProducts(r.preset),
                      }).then((err) => {
                        setError(err);
                        if (!err) photoUi.getState().openRun(r.id);
                      });
                    }}
                  >
                    Re-run products
                  </button>
                )}
                {!pkg &&
                  (asking === r.id ? (
                    <span className="ph-ask">
                      <span className="small">
                        Move this run&apos;s work files to the recycle bin? Its layers and reports
                        stay.
                      </span>
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => {
                          setAsking(null);
                        }}
                      >
                        Keep
                      </button>
                      <button
                        type="button"
                        className="btn sm danger"
                        onClick={() => void clean(r.id)}
                      >
                        Delete work files
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => {
                        setAsking(r.id);
                      }}
                    >
                      Delete work files
                    </button>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
