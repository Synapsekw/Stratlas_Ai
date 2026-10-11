/**
 * What the Process photos panels do through main: start, pause, resume and cancel the photo jobs
 * (`jobs:start`, `jobs:cancel`), and reload the project's manifest when processing added layers.
 * Every function answers an error sentence, or null when it worked.
 */
import type { PhotoPreset, PhotoSource, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { bridge, jobs } from '../shell';
import { photoUi, type PendingProducts } from './store';

async function start(
  pipeline: 'photo.align' | 'photo.georef' | 'photo.products' | 'opf.export',
  project: string,
  params: Record<string, unknown>,
): Promise<string | null> {
  const r = await bridge.call('jobs:start', { pipeline, project, params });
  if (!r.ok) return r.error;
  if (!r.value.ok) return r.value.error;
  await jobs.getState().refresh();
  return null;
}

export interface AlignRequest {
  root: string;
  run: string;
  photos: PhotoSource;
  preset: PhotoPreset;
  gnss: 'auto' | 'rtk' | 'standard' | 'ignore';
  /** Only when it differs from the project CRS. */
  crs?: ProjectManifest['crs'];
}

export function startAlign(a: AlignRequest): Promise<string | null> {
  return start('photo.align', a.root, {
    photos: a.photos,
    run: a.run,
    preset: a.preset,
    gnss: a.gnss,
    ...(a.crs ? { crs: a.crs } : {}),
  });
}

/** **Adjust**: bundle adjustment with the marked control points (`photo.georef`). */
export function startGeoref(root: string, run: string): Promise<string | null> {
  return start('photo.georef', root, { run });
}

const folderKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * The capture id the maps go under: the one chosen, or the survey date of `captureDate`, found or
 * added now. Null when there is none or it cannot be made: the maps are then built without a date
 * rather than not at all.
 */
async function captureOf(p: PendingProducts): Promise<string | null> {
  if (p.capture) return p.capture;
  if (!p.captureDate) return null;
  const project = workspace.getState().project;
  if (!project || folderKey(project.root) !== folderKey(p.root)) return null;
  try {
    const r = await bridge.call('builder:ensureCapture', {
      projectId: project.id,
      date: p.captureDate,
    });
    if (!r.ok || !r.value.ok) return null;
    const ws = workspace.getState();
    if (ws.project?.id === project.id) ws.replaceManifest(r.value.manifest);
    return r.value.captureId;
  } catch {
    return null;
  }
}

async function requestProducts(run: string, p: PendingProducts): Promise<string | null> {
  if (!p.products.length) return 'Choose at least one product.';
  try {
    const capture = await captureOf(p);
    return await start('photo.products', p.root, {
      run,
      products: p.products,
      preset: p.preset,
      ...(capture ? { capture } : {}),
    });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Build the maps of a run (`photo.products`). Started or refused, the maps the dialog queued no
 * longer wait: a start that happens by itself when the photos are matched has nobody to answer
 * to, so the reason of a refusal is kept for the run panel, which then offers **Create maps**
 * again. The run's survey date stays until a start works, so that next try files the maps under it.
 */
export async function startProducts(run: string, p: PendingProducts): Promise<string | null> {
  const err = await requestProducts(run, p);
  const ui = photoUi.getState();
  ui.setPending(run, null);
  ui.setStartError(run, err);
  if (!err) ui.setDate(run, null);
  return err;
}

/** **Export as OPF**: the run's cameras, calibration and outputs as an OPF project in `out`. */
export function startOpfExport(root: string, run: string, out: string): Promise<string | null> {
  return start('opf.export', root, { run, out });
}

/** Pause: the job stops at its current stage; **Resume** continues from there. */
export async function pauseJob(run: string, jobId: string): Promise<string | null> {
  const err = await jobs.getState().cancel(jobId);
  if (!err) photoUi.getState().setStopped(run, 'paused');
  return err;
}

/** Cancel: the job stops and the products the wizard queued are dropped; the work is kept. */
export async function cancelRun(run: string, jobId: string | null): Promise<string | null> {
  const err = jobId ? await jobs.getState().cancel(jobId) : null;
  if (!err) {
    photoUi.getState().setPending(run, null);
    photoUi.getState().setStopped(run, 'cancelled');
  }
  return err;
}

export async function resumeJob(run: string, jobId: string): Promise<string | null> {
  const err = await jobs.getState().start({ resume: jobId });
  if (!err) photoUi.getState().setStopped(run, null);
  return err;
}

/** Read the open project's manifest again (processing added layers or moved cameras). */
export async function reloadManifest(): Promise<void> {
  const p = workspace.getState().project;
  if (!p) return;
  const r = await bridge.call('project:open', { path: p.root });
  const ws = workspace.getState();
  if (r.ok && r.value.ok && ws.project?.id === p.id) ws.replaceManifest(r.value.manifest);
}
