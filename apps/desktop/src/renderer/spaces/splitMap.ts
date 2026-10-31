import type { Layer } from '@aio/schema';
import { useWorkspace, workspace } from '@aio/workspace';
import {
  DEFAULT_SPLIT,
  paneOptions,
  resolveSplit,
  sidesOf,
  type SplitPref,
} from '../workspace/splitModel';
import { stagePrefs, useStagePrefs } from '../workspace/stagePrefs';

/**
 * Whether the split the stage would draw has a map pane: the saved sides resolved the way the stage
 * resolves them (a pane whose layer is gone falls back to the default 3D and map), else the default.
 * Panes that depend on files, dates or walks the model cannot see here (report, frames, 360 video)
 * count as offered, and two equal sides compare two survey dates, so neither shows the map.
 */
export function splitShowsMap(
  pref: SplitPref | undefined,
  layers: readonly Pick<Layer, 'kind'>[],
): boolean {
  const want = pref ?? DEFAULT_SPLIT;
  const sides =
    want.left === want.right ? want : resolveSplit(want, paneOptions(layers, 1, 2, { walks: 1 }));
  return sidesOf(sides, 'map').length > 0;
}

/** The open project's split has a map pane (re-renders when it changes). */
export function useSplitShowsMap(): boolean {
  const project = useWorkspace((s) => s.project);
  const id = project?.id;
  const pref = useStagePrefs((s) => (id ? s.byProject[id]?.split : undefined));
  const layers = project?.manifest.layers;
  return splitShowsMap(pref, layers ?? []);
}

/** The same, read now (for a key handler). */
export function splitShowsMapNow(): boolean {
  const project = workspace.getState().project;
  if (!project) return true;
  return splitShowsMap(stagePrefs.getState().byProject[project.id]?.split, project.manifest.layers);
}
