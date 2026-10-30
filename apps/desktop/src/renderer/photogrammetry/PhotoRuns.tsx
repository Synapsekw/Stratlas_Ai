/**
 * Maps from photos in the Jobs panel (G4): the project's runs with their status, quality, outputs
 * and accuracy, and per run **Open run**, **Create maps again** (`photo.products`) and
 * **Delete run's work files** (only `work/`, to the recycle bin, after asking) and **Export as OPF**
 * (`opf.export` into a folder the person picks), **Start over…** on a failed or cancelled run (the
 * wizard filled in from it) and, behind the run's **···** menu so it is never one slip away from
 * **Delete work files**, **Delete run** (to the project trash, after the confirm). A photo job
 * selected in the Jobs list opens its run.
 */
import type { JobRecord, PhotoRunSummary } from '@aio/schema';
import { useAnnotateReadOnly } from '@aio/annotate';
import { Button, IconButton, Menu } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isActive } from '../jobs';
import { bridge, useJobs, useShell } from '../shell';
import { askRemove, useRemoval } from '../shell/removal';
import { openStartOver, startOpfExport, startProducts } from './actions';
import { defaultProducts, formatBytes, PRESETS } from './estimate';
import { RUN_STATUS } from './phases';
import { formatResidual } from './report';
import { START_OVER } from './startOver';
import { photoUi, runOfJob, usePhotoUi } from './store';

const STATUS: Record<PhotoRunSummary['status'], string> = RUN_STATUS;

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
  const lookOnly = useAnnotateReadOnly();
  const canEdit = !pkg && !lookOnly;
  // a removal elsewhere (the Datasets tree, Start over) changes the list
  const removed = useRemoval((s) => s.removed);
  // runs with a job still at work: their Delete run waits until the job is cancelled, and Start
  // over is hidden (as in the run panel)
  const liveKey = useJobs((s) =>
    s.jobs
      .filter(
        (j) =>
          isActive(j) &&
          runOfJob(j) !== null &&
          folderKey(j.project) === folderKey(project?.root ?? ''),
      )
      .map((j) => runOfJob(j))
      .join(','),
  );
  const liveRuns = useMemo(() => new Set(liveKey.split(',').filter(Boolean)), [liveKey]);

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
  }, [projectId, version, jobsKey, removed]);

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
    <section className="ph-runs" aria-label="Maps from photos" data-testid="photo-runs">
      <header className="ph-runs-h">
        <h2 className="caps">Maps from photos</h2>
      </header>
      {selectedRun && (
        <Button
          className="ph-open-job"
          icon="link"
          onClick={() => {
            photoUi.getState().openRun(selectedRun);
          }}
        >
          Open run {selectedRun}
        </Button>
      )}
      {error && <p className="nj-err">{error}</p>}
      {notice && (
        <p className="small faint" role="status">
          {notice}
        </p>
      )}
      {runs?.length === 0 && (
        <p className="small faint">
          No maps have been made from photos in {project.manifest.name} yet.
        </p>
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
                <Button
                  onClick={() => {
                    photoUi.getState().openRun(r.id);
                  }}
                >
                  Open run
                </Button>
                {!pkg && ['aligned', 'adjusted', 'done', 'failed'].includes(r.status) && (
                  <Button
                    variant="quiet"
                    onClick={() => {
                      void startProducts(r.id, {
                        root: project.root,
                        preset: r.preset,
                        products: r.products.length ? r.products : defaultProducts(r.preset),
                        ...(photoUi.getState().dates[r.id] ?? {}),
                      }).then((err) => {
                        setError(err);
                        if (!err) photoUi.getState().openRun(r.id);
                      });
                    }}
                  >
                    Create maps again
                  </Button>
                )}
                {!pkg && ['aligned', 'adjusted', 'done'].includes(r.status) && (
                  <Button
                    variant="quiet"
                    onClick={() => {
                      void bridge
                        .call('dialog:openFolder', {
                          title: 'Export as OPF: choose an empty folder',
                        })
                        .then(async (d) => {
                          if (!d.ok || !d.value.path) return;
                          const out = d.value.path;
                          const err = await startOpfExport(project.root, r.id, out);
                          setError(err);
                          if (!err)
                            setNotice(
                              `Exporting run ${r.id} as OPF to ${out}. The job is in the list.`,
                            );
                        });
                    }}
                  >
                    Export as OPF
                  </Button>
                )}
                {!pkg &&
                  (asking === r.id ? (
                    <span className="ph-ask">
                      <span className="small">
                        Move this run&apos;s work files to the recycle bin? Its layers and reports
                        stay.
                      </span>
                      <Button
                        variant="quiet"
                        onClick={() => {
                          setAsking(null);
                        }}
                      >
                        Keep
                      </Button>
                      <Button variant="danger" onClick={() => void clean(r.id)}>
                        Delete work files
                      </Button>
                    </span>
                  ) : (
                    <Button
                      variant="quiet"
                      onClick={() => {
                        setAsking(r.id);
                      }}
                    >
                      Delete work files
                    </Button>
                  ))}
                {canEdit && START_OVER.has(r.status) && !liveRuns.has(r.id) && (
                  <Button
                    variant="quiet"
                    data-testid={`run-start-over-${r.id}`}
                    onClick={() => {
                      void openStartOver(project.id, r.id, project.manifest.layers).then(setError);
                    }}
                  >
                    Start over…
                  </Button>
                )}
                {canEdit && (
                  <RunMore
                    run={r.id}
                    busyReason={
                      liveRuns.has(r.id)
                        ? `A job of run ${r.id} is still running. Cancel it first.`
                        : undefined
                    }
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The run's **···** menu: **Delete run**, kept apart from **Delete work files** so the two are
 * never side by side. Choosing it asks first (the removal dialog); while a job of the run is at
 * work it stays in the menu, greyed, with the reason.
 */
function RunMore({ run, busyReason }: { run: string; busyReason: string | undefined }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={opener}
        icon="more"
        label={`More for run ${run}`}
        data-testid={`run-more-${run}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
        }}
      />
      <Menu
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        opener={opener}
        label={`Run ${run}`}
        testId={`run-menu-${run}`}
        items={[
          {
            id: 'delete',
            label: 'Delete run',
            icon: 'trash',
            danger: true,
            ...(busyReason ? { disabledReason: busyReason } : {}),
            onSelect: () => {
              askRemove([{ run }]);
            },
          },
        ]}
      />
    </>
  );
}
