import type { ImportItem, PipelinePackStatus, WalkFile, WalkProcessParams } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { builder } from '../builder/state';
import { sameFolder } from '../jobs';
import { processingTools } from '../processingTools';
import { bridge, jobs, shell } from '../shell';
import { PANE_KINDS } from '../workspace/splitModel';
import { stagePrefs } from '../workspace/stagePrefs';
import {
  autoStartParams,
  importAnswered,
  importedWalkRows,
  originalCheck,
  packOffersWalkProcess,
  splitWithWalk,
  walkForRow,
} from './walkModel';
import { createWalkStore, walkFolderId, type WalkState } from './walkStore';

/** The 360 walks of the open project, kept in step with its manifest. */
export const walks = createWalkStore((projectId) => bridge.call('walks:list', { projectId }));

export function useWalks<T>(selector: (s: WalkState) => T): T {
  return useStore(walks, selector);
}

/** Ask main for the walk records again (after an import added a walk). */
export function refreshWalks(): Promise<void> {
  return walks.getState().refresh();
}

let followedId: string | null | undefined;
let followedLayers: unknown;
const follow = () => {
  const project = workspace.getState().project;
  const id = project?.id ?? null;
  const layers = project?.manifest.layers ?? [];
  if (id === followedId && layers === followedLayers) return;
  followedId = id;
  followedLayers = layers;
  void walks.getState().sync(id, layers);
};
workspace.subscribe(follow);
follow();

// ---------------------------------------------------------------- walk.process

/** The pipeline pack as main last described it, asked for once when not known yet. */
async function packStatus(): Promise<PipelinePackStatus | null> {
  const known = processingTools.getState().status;
  if (known) return known;
  await processingTools.getState().load();
  return processingTools.getState().status;
}

/**
 * Start `walk.process` on a walk of the open project (`params.walk` is its folder id, the layer
 * is where a refusal is remembered): an error sentence, or null when it started.
 */
export async function processWalk(
  layerId: string,
  params: WalkProcessParams,
): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return t('walk.process.noProject');
  walks.getState().setStartError(layerId, null);
  const error = await jobs.getState().start({
    pipeline: 'walk.process',
    project: project.root,
    params,
  });
  if (error) walks.getState().setStartError(layerId, error);
  return error;
}

/**
 * **Locate...**: pick the original camera file of a walk, filtered to its extension. The path, an
 * error sentence when another file was picked, or null when the dialog was closed.
 */
export async function locateOriginal(
  walk: WalkFile,
): Promise<{ path: string } | { error: string } | null> {
  const ext = /\.([a-z0-9]+)$/i.exec(walk.source.file)?.[1];
  const pick = await bridge.call('dialog:openFiles', {
    title: t('walk.locate.title', { name: walk.name }),
    ...(ext ? { filters: [{ name: walk.source.file, extensions: [ext.toLowerCase()] }] } : {}),
  });
  if (!pick.ok) return { error: pick.error };
  const path = pick.value.paths[0];
  if (!path) return null;
  const wrong = originalCheck(path, walk.source.file);
  return wrong ? { error: wrong } : { path };
}

/** Rows of import answers already looked at (a drawing's page answer re-sets the result). */
const seen = new WeakSet<ImportItem>();

/**
 * After an import answered: every walk it added is processed at once, from the original the
 * import was given, when the pipeline pack has `walk.process` (decision 7). A low resolution
 * copy (`.lrv`) and a skipped row start nothing.
 */
async function autoStart(
  items: readonly ImportItem[],
  paths: readonly string[] | undefined,
): Promise<void> {
  const fresh = items.filter((i) => !seen.has(i));
  for (const i of fresh) seen.add(i);
  const rows = importedWalkRows(fresh, paths ?? []);
  const project = workspace.getState().project;
  if (rows.length === 0 || !project) return;
  await refreshWalks();
  if (workspace.getState().project?.id !== project.id) return;
  const offered = packOffersWalkProcess(await packStatus());
  const { records, walks: layers } = walks.getState();
  const listed = Object.values(records);
  for (const row of rows) {
    const walk = walkForRow(listed, row);
    const params = walk ? autoStartParams(row, walk, offered) : null;
    if (!params) continue;
    const layer = layers.find((l) => walkFolderId(l) === params.walk);
    await processWalk(layer?.id ?? `walk-${params.walk}`, params);
  }
}

// an import answered: a walk folder may have been written beside its new layer; the walks it
// added start processing
builder.subscribe((s, prev) => {
  if (importAnswered(prev, s)) void refreshWalks();
  // the rows name a file only: the paths the import was given find each walk's original
  const r = s.importResult;
  if (r && r !== prev.importResult) void autoStart(r.items, r.paths);
});

// a finished walk.process wrote process.json: the list reads it again (status, levelled copy)
jobs.subscribe((s, prev) => {
  if (s.jobs === prev.jobs) return;
  const root = workspace.getState().project?.root;
  if (!root) return;
  const finished = s.jobs.some(
    (j) =>
      j.pipeline === 'walk.process' &&
      j.status === 'done' &&
      sameFolder(j.project, root) &&
      prev.jobs.find((p) => p.id === j.id)?.status !== 'done',
  );
  if (finished) void refreshWalks();
});

/** Show a walk: the Scene screen in split view, the 360 video pane where it is or on the right. */
export function openWalk(layerId: string): void {
  const project = workspace.getState().project;
  if (!project) return;
  walks.getState().select(layerId);
  const sh = shell.getState();
  if (sh.screen !== 'scene') sh.go('scene');
  const saved = stagePrefs.getState().byProject[project.id]?.split;
  // every pane counts as offered here: the split itself drops what the project cannot fill
  stagePrefs.getState().update(project.id, { split: splitWithWalk(saved, PANE_KINDS) });
  if (sh.stageMode !== 'split') sh.setStageMode('split');
}

let placeHandler: ((layerId: string) => void) | null = null;

/** The Place walk flow registers itself here; the tree row's Place walk calls it. */
export function setPlaceWalkHandler(fn: ((layerId: string) => void) | null): void {
  placeHandler = fn;
}

/** Start placing a walk (the Place walk strip), when that flow is registered. */
export function placeWalk(layerId: string): void {
  placeHandler?.(layerId);
}

let removePlacementHandler: ((layerId: string) => Promise<string | null>) | null = null;

/** The Place walk flow registers its Remove placement here; the tree row calls it. */
export function setRemovePlacementHandler(
  fn: ((layerId: string) => Promise<string | null>) | null,
): void {
  removePlacementHandler = fn;
}

/** Remove a walk's placement (the walk stays): null when removed, else why not. */
export function removeWalkPlacement(layerId: string): Promise<string | null> {
  return removePlacementHandler
    ? removePlacementHandler(layerId)
    : Promise.resolve('Place walk is not ready.');
}
