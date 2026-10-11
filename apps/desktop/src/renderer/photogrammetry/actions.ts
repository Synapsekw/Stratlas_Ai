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
 * added now. When the date wanted cannot be saved the maps are built without a date rather than
 * not at all, and `dateFailed` says so, so the person is told. `dateFailed` is false when no date
 * was wanted.
 */
async function captureOf(
  p: PendingProducts,
): Promise<{ capture: string | null; dateFailed: boolean }> {
  if (p.capture) return { capture: p.capture, dateFailed: false };
  if (!p.captureDate) return { capture: null, dateFailed: false };
  const failed = { capture: null, dateFailed: true };
  const project = workspace.getState().project;
  if (!project || folderKey(project.root) !== folderKey(p.root)) return failed;
  try {
    const r = await bridge.call('builder:ensureCapture', {
      projectId: project.id,
      date: p.captureDate,
    });
    if (!r.ok || !r.value.ok) return failed;
    const ws = workspace.getState();
    if (ws.project?.id === project.id) ws.replaceManifest(r.value.manifest);
    return { capture: r.value.captureId, dateFailed: false };
  } catch {
    return failed;
  }
}

async function requestProducts(
  run: string,
  p: PendingProducts,
): Promise<{ err: string | null; dateFailed: boolean }> {
  if (!p.products.length) return { err: 'Choose at least one product.', dateFailed: false };
  let dateFailed = false;
  try {
    const c = await captureOf(p);
    dateFailed = c.dateFailed;
    const err = await start('photo.products', p.root, {
      run,
      products: p.products,
      preset: p.preset,
      ...(c.capture ? { capture: c.capture } : {}),
    });
    return { err, dateFailed };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e), dateFailed };
  }
}

/**
 * Build the maps of a run (`photo.products`). Started or refused, the maps the dialog queued no
 * longer wait: a start that happens by itself when the photos are matched has nobody to answer
 * to, so the reason of a refusal is kept for the run panel, which then offers **Create maps**
 * again. The run's survey date stays until a start works with it, so that next try files the maps
 * under it. A start that works without the survey date wanted (it could not be saved) is kept for
 * the run (`dateWarnings`, with the day) so the panel tells the person, and the run keeps its date
 * too, so **Create maps again** tries to save it again and **File them under** can use it; a
 * refused start leaves all of that as it was.
 */
export async function startProducts(run: string, p: PendingProducts): Promise<string | null> {
  const { err, dateFailed } = await requestProducts(run, p);
  const ui = photoUi.getState();
  ui.setPending(run, null);
  ui.setStartError(run, err);
  if (!err) {
    if (dateFailed && p.captureDate) {
      ui.setDate(run, { captureDate: p.captureDate });
      ui.setDateWarning(run, { date: p.captureDate, root: p.root });
    } else {
      ui.setDate(run, null);
      ui.setDateWarning(run, null);
    }
  }
  return err;
}

/**
 * **File them under <date>** on a run's survey date warning: save the date that could not be saved
 * (`builder:ensureCapture`, which finds it when it exists) and put the run's layers that are under
 * no date into it (`builder:updateLayers`). The run's layers are the ones its `run.json` lists
 * (`outputs.layers`, as the run panel reads them); a layer the person already filed under a date
 * stays where it is. With no layers yet, or layers the project has not been reloaded with, nothing
 * is saved and a reason is answered, so the warning never goes while maps are left without a date. On any failure the warning stays (after the date
 * was saved a second try finds it and files the layers). Answers a reason, or null when it worked.
 */
export async function fileUnderDate(run: string): Promise<string | null> {
  const ui = photoUi.getState();
  const warning = ui.dateWarnings[run];
  if (!warning) return 'There is no survey date to file these maps under.';
  const project = workspace.getState().project;
  if (!project || folderKey(project.root) !== folderKey(warning.root))
    return 'Open the project these maps belong to, then try again.';
  const sameProject = () => workspace.getState().project?.id === project.id;
  try {
    const read = await bridge.call('photo:readRun', { projectId: project.id, run });
    if (!read.ok) return read.error;
    if (!read.value.ok) return read.value.error;
    const outputs = read.value.run.outputs.layers;
    if (outputs.length === 0) return 'The maps are not ready yet. Try again when they are.';
    if (!sameProject()) return 'Open the project these maps belong to, then try again.';
    // run.json can list layers before the project is reloaded with them: nothing to file yet
    const layers = workspace.getState().project?.manifest.layers ?? [];
    if (outputs.some((id) => !layers.some((l) => l.id === id)))
      return 'The maps are not loaded yet. Try again in a moment.';
    const undated = layers.filter((l) => outputs.includes(l.id) && !l.capture).map((l) => l.id);
    if (undated.length > 0) {
      const saved = await bridge.call('builder:ensureCapture', {
        projectId: project.id,
        date: warning.date,
      });
      if (!saved.ok) return saved.error;
      if (!saved.value.ok) return saved.value.error;
      // the date is saved: a second try, in the run's project, files the layers
      if (!sameProject()) return 'Open the project these maps belong to, then try again.';
      workspace.getState().replaceManifest(saved.value.manifest);
      const filed = await bridge.call('builder:updateLayers', {
        projectId: project.id,
        layerIds: undated,
        patch: { capture: saved.value.captureId },
      });
      if (!filed.ok) return filed.error;
      if (!filed.value.ok) return filed.value.error;
      if (sameProject()) workspace.getState().replaceManifest(filed.value.manifest);
    }
    // a start for the same run, meanwhile, may have replaced the warning: leave that one alone
    if (photoUi.getState().dateWarnings[run] === warning) {
      ui.setDateWarning(run, null);
      ui.setDate(run, null);
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
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
