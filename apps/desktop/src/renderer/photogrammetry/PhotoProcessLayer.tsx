/**
 * Maps from photos over the whole app (G4, mounted once by the Builder's import layer): the
 * **Create maps from photos** dialog and the run panel when open, a **Create maps from photos**
 * button beside **Import files** on an empty project, and the outputs the dialog queued once the
 * photos are matched. The layers processing
 * adds come in through the app's manifest reload (`MANIFEST_WRITERS` in `jobs.ts`).
 */
import { Icon } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { jobs, useShell } from '../shell';
import { startProducts } from './actions';
import { ProcessWizard } from './ProcessWizard';
import { RunPanel } from './RunPanel';
import { newlyDone, photoUi, runOfJob, usePhotoUi } from './store';
import './photo.css';

const folderKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function PhotoProcessLayer() {
  const view = usePhotoUi((s) => s.view);
  const projectId = useWorkspace((s) => s.project?.id ?? null);

  // a panel belongs to its project
  useEffect(() => {
    photoUi.getState().close();
  }, [projectId]);

  // queued products start when their alignment finishes; open run panels read their run again
  useEffect(() => {
    const since = new Date().toISOString();
    return jobs.subscribe((next, prev) => {
      if (next.jobs === prev.jobs) return;
      for (const job of newlyDone(prev.jobs, next.jobs, since)) {
        const run = runOfJob(job);
        if (!run) continue;
        const ui = photoUi.getState();
        const pending = ui.pending[run];
        if (
          job.pipeline === 'photo.align' &&
          pending &&
          folderKey(pending.root) === folderKey(job.project)
        )
          void startProducts(run, pending);
        const root = workspace.getState().project?.root;
        if (root && folderKey(root) === folderKey(job.project)) ui.bump();
      }
    });
  }, []);

  return (
    <>
      {projectId && view?.kind === 'wizard' && <ProcessWizard />}
      {projectId && view?.kind === 'run' && <RunPanel run={view.run} tab={view.tab} />}
      <EmptyProjectLauncher />
    </>
  );
}

/** **Create maps from photos** beside **Import files** while the project has no layers. */
function EmptyProjectLauncher() {
  const empty = useWorkspace((s) => s.project !== null && s.project.manifest.layers.length === 0);
  const pkg = useShell((s) => s.pkg);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const active = empty && !pkg;
  useEffect(() => {
    if (!active) return;
    const find = () => {
      setSlot(document.querySelector<HTMLElement>('[data-testid="empty-project"] > div'));
    };
    find();
    const mo = new MutationObserver(find);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
    };
  }, [active]);
  if (!active || !slot?.isConnected) return null;
  return createPortal(
    <button
      type="button"
      className="btn ph-launch"
      onClick={() => {
        photoUi.getState().openWizard();
      }}
    >
      <Icon name="photo" size={14} />
      Create maps from photos
    </button>,
    slot,
  );
}
