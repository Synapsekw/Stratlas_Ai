/**
 * The agent's photo tools on the app side (`AppHooks.processPhotos`, `AppHooks.photoRuns`):
 * `process_photos` starts a run as **Create maps from photos** does in its simple flow (the
 * estimate's disk check, a new run id, `photo.align`, the survey date picked from the photos, the
 * maps queued unless ground control comes first); `accuracy_summary` reads runs through main.
 * Like the dialog it refuses first on a computer that cannot process photos (`photo:probe`).
 * Refusals are thrown as ToolErrors with main's sentence.
 */
import {
  ToolError,
  type AppHooks,
  type ProcessPhotosRequest,
  type ProcessPhotosStarted,
} from '@aio/ai';
import { workspace } from '@aio/workspace';
import type { Res } from '../bridge';
import { bridge } from '../shell';
import { startAlign } from './actions';
import { diskNeed, formatMinutes, newRunId, productsFor } from './estimate';
import { processingLine } from './hardware';
import { photoUi } from './store';
import { daysOfItems, pickParams, pickSurveyDate } from './surveyDate';

/** The success answer of a call, or its refusal thrown as a ToolError with main's sentence. */
function value<T extends { ok: boolean }>(r: Res<T>): Extract<T, { ok: true }> {
  if (!r.ok) throw new ToolError(r.error);
  if (!r.value.ok) throw new ToolError((r.value as { error?: string }).error ?? 'Failed.');
  return r.value as Extract<T, { ok: true }>;
}

function openProject() {
  const p = workspace.getState().project;
  if (!p) throw new ToolError('No project is open.');
  return p;
}

export async function agentProcessPhotos(req: ProcessPhotosRequest): Promise<ProcessPhotosStarted> {
  const project = openProject();
  const layer = project.manifest.layers.find((l) => l.kind === 'photos' && l.id === req.layerId);
  if (layer?.kind !== 'photos')
    throw new ToolError(`The photos layer "${req.layerId}" is not in the open project.`);
  // whether this computer can do it at all comes first, as in the dialog (an unread probe does
  // not block, as there)
  const probe = await bridge.call('photo:probe', {});
  if (probe.ok && probe.value.ok) {
    const verdict = processingLine(probe.value.probe);
    if (!verdict.ok) throw new ToolError(`${verdict.title}. ${verdict.text}`);
  }
  const photos = { layer: layer.id };
  const { estimate } = value(
    await bridge.call('photo:estimate', {
      projectId: project.id,
      photos,
      preset: req.preset,
      products: productsFor(req.preset, req.products),
    }),
  );
  const disk = diskNeed(estimate);
  if (disk)
    throw new ToolError(
      `Not enough free disk space: this needs ${disk.needs} on the data drive, and it has ${disk.has}. Free some space, then try again.`,
    );
  if (estimate.minutes[1] === 0)
    throw new ToolError('There are no photos to process in this layer.');
  const { runs } = value(await bridge.call('photo:runs', { projectId: project.id }));
  // main lists a run only once photo.align has read its photos: the ids this session handed out
  // are taken too, and the new id is held at once, so two starts never share a run folder
  const ui = photoUi.getState();
  const run = newRunId(new Date(), [...runs.map((r) => r.id), ...ui.held]);
  ui.holdRun(run, true);
  const itemDays = daysOfItems(layer.items);
  const pick = pickSurveyDate(
    itemDays.length ? itemDays : (estimate.photoDays ?? []),
    project.manifest.captures,
    layer.capture,
  );
  const date = pickParams(pick);
  ui.setDate(run, date);
  const err = await startAlign({
    root: project.root,
    run,
    photos,
    preset: req.preset,
    gnss: req.gnss,
  });
  if (err) {
    ui.setDate(run, null);
    ui.holdRun(run, false);
    throw new ToolError(err);
  }
  if (!req.groundControlFirst)
    ui.setPending(run, { root: project.root, preset: req.preset, products: req.products, ...date });
  return {
    run,
    estimate: formatMinutes(estimate.minutes),
    surveyDate: pick.kind === 'none' ? null : pick.date,
  };
}

export const agentPhotoRuns: NonNullable<AppHooks['photoRuns']> = {
  list: async () => value(await bridge.call('photo:runs', { projectId: openProject().id })).runs,
  read: async (run) => {
    const projectId = openProject().id;
    const [r, g] = await Promise.all([
      bridge.call('photo:readRun', { projectId, run }),
      bridge.call('photo:readGcp', { projectId, run }),
    ]);
    const { run: file, accuracy } = value(r);
    return { run: file, accuracy, gcp: value(g).gcp };
  },
};
