import type { CapturePatch } from '@aio/schema';
import { volumetric } from '@aio/volumetric';
import { planDateMove, workspace } from '@aio/workspace';
import { setLayersCapture } from '../change/SurveyDate';
import { bridge } from '../shell';
import { volumeHints } from '../workspace/compare';
import { priorCaptures, undoBatches, type MovedLayer } from './dateUndo';

export type { MovedLayer } from './dateUndo';

/**
 * The survey date folders of the Datasets list as things a person edits: file a dataset under
 * another date, rename a date, give its folder a colour or an icon. Everything here writes the
 * manifest only (`Layer.capture`, `captures[]`), through `builder:updateLayers` and
 * `builder:updateCapture`: no file of a layer is moved, renamed or rewritten.
 */

export interface DateMoveResult {
  /** Why nothing was saved; null when the move went through (or there was nothing to do). */
  error: string | null;
  /** Layers their name (or the volumes file) keeps on a date, by layer id: that capture's id. */
  stays: Record<string, string>;
  /** The layers the move wrote, with the `capture` each had before; empty when nothing was saved. */
  moved: MovedLayer[];
}

/**
 * File layers under `capture`, or under no date (null). A layer already there is left alone, so
 * dropping a dataset on its own folder writes nothing. Taking the date off cannot undo a date the
 * layer's name carries; those layers come back in `stays`.
 */
export async function moveLayersToDate(
  layerIds: readonly string[],
  capture: string | null,
): Promise<DateMoveResult> {
  const project = workspace.getState().project;
  if (!project) return { error: 'No project is open.', stays: {}, moved: [] };
  const plan = planDateMove(
    project.manifest,
    volumeHints(volumetric.getState()),
    layerIds,
    capture,
  );
  if (plan.write.length === 0) return { error: null, stays: plan.stays, moved: [] };
  const moved = priorCaptures(project.manifest, plan.write);
  const error = await setLayersCapture(plan.write, capture);
  return { error, stays: plan.stays, moved: error ? [] : moved };
}

/**
 * Put the layers of a date move back under the `capture` each had before it. Null when they are
 * back, else why not; a write that is refused stops there and the list shows the manifest as it is.
 */
export async function undoDateMove(moved: readonly MovedLayer[]): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return 'No project is open.';
  const known = new Set(project.manifest.layers.map((l) => l.id));
  for (const batch of undoBatches(moved, known)) {
    const error = await setLayersCapture(batch.layerIds, batch.capture);
    if (error) return error;
  }
  return null;
}

/** Rename a survey date or set its folder's colour and icon; null when saved, else why not. */
export async function updateCapture(
  captureId: string,
  patch: CapturePatch,
): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return 'No project is open.';
  const r = await bridge.call('builder:updateCapture', {
    projectId: project.id,
    captureId,
    patch,
  });
  if (!r.ok) return r.error;
  if (!r.value.ok) return r.value.error;
  workspace.getState().replaceManifest(r.value.manifest);
  return null;
}
