import type { Capture, ProjectManifest, WalkFile, WalkLayer } from '@aio/schema';
import { WALKS_DIR } from '@aio/schema';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { uniqueId, updateManifestFile, withPose } from './create';
import { listWalks } from './walks';
import { walkIdOfRecord } from './walkPaths';
import { commitWalkPoses, discardWalkPoses, stageWalkPose, type StagedWalkPose } from './walkPose';

/*
 * Walks as layers (the walk layer and placing, "Migration on open"): a walk is a `walk` layer in
 * the manifest, id `walk-<walk id>`. A project that holds side-folder walks from before gets their
 * layers when it opens; a walk import writes its layer at once. The layer is found by its record
 * path, never by its id, so a renamed id or a second layer of the same walk is not added twice.
 *
 * Each walk is migrated once: once a walk has a layer, its folder gets the marker file `.layer`
 * (`WALK_LAYER_MARK`), and a marked walk is never given a layer again. A walk removed on another
 * copy of a hub project keeps its folder here (a merge rewrites the manifest, never deletes a
 * walk's files), and without the marker the next open would add it back and sync it out again.
 * A separate file, not a field in `walk.json`, so builds that read `aio.walk/1` strictly are not
 * affected.
 */

/** The marker file in `walks/<id>/` of a walk that has been a layer. */
export const WALK_LAYER_MARK = '.layer';
const MARK_TEXT =
  'This walk has been a layer. The app does not add it again when its layer is removed.\n';

/** Whether a walk's folder holds the marker. */
export async function walkLayerMarked(root: string, walkId: string): Promise<boolean> {
  return has(root, walkId, WALK_LAYER_MARK);
}

/**
 * Mark a walk's folder as made a layer. Best effort: when the marker cannot be written, the walk
 * is marked by the next open that finds its layer.
 */
export async function markWalkLayer(root: string, walkId: string): Promise<void> {
  await writeFile(join(root, WALKS_DIR, walkId, WALK_LAYER_MARK), MARK_TEXT).catch(() => undefined);
}

/** Which of a walk's files exist: `raw-path.json`, `orientation.json` (and `.bin`), `sparse.ply`. */
export interface WalkFiles {
  raw: boolean;
  orientation: boolean;
  /** `orientation.bin`, the header's data file. */
  orientationData?: boolean;
  points: boolean;
}

export const NO_WALK_FILES: WalkFiles = { raw: false, orientation: false, points: false };

const RAW = 'raw-path.json';
const ORIENTATION = 'orientation.json';
const ORIENTATION_DATA = 'orientation.bin';
const POINTS = 'sparse.ply';

const recordPath = (walkId: string) => `${WALKS_DIR}/${walkId}/walk.json`;

/** `walk-<id>`, or `walk-<id>-2`, `-3` ... the first one `taken` does not hold. */
export function walkLayerId(walkId: string, taken: ReadonlySet<string>): string {
  return uniqueId(`walk-${walkId}`, (x) => taken.has(x));
}

/**
 * The survey date a walk was filmed on: the one capture whose date is the date part of the walk's
 * `capturedAt`. Undefined when the walk has no time, no date matches or two do.
 */
export function walkCaptureFor(walk: WalkFile, captures: readonly Capture[]): string | undefined {
  const day = walk.source.capturedAt?.slice(0, 10);
  if (!day) return undefined;
  const hits = captures.filter((c) => c.date === day);
  return hits.length === 1 ? hits[0]?.id : undefined;
}

/** The `path` of a walk layer for the files found, or undefined when `raw-path.json` is absent. */
export function walkPathRefs(walkId: string, files: WalkFiles): WalkLayer['path'] {
  if (!files.raw) return undefined;
  const at = (name: string) => ({ path: `${WALKS_DIR}/${walkId}/${name}` });
  return {
    raw: at(RAW),
    ...(files.orientation ? { orientation: at(ORIENTATION) } : {}),
    ...(files.orientation && files.orientationData === true
      ? { orientationData: at(ORIENTATION_DATA) }
      : {}),
    ...(files.points ? { points: at(POINTS) } : {}),
  };
}

/** The layer of one walk in a project. Its id is not yet checked against the layers' ids. */
export function walkLayerFor(
  walk: WalkFile,
  m: Pick<ProjectManifest, 'layers' | 'captures'>,
  files: WalkFiles,
): WalkLayer {
  const capture = walkCaptureFor(walk, m.captures);
  const path = walkPathRefs(walk.id, files);
  return {
    kind: 'walk',
    id: walkLayerId(walk.id, new Set(m.layers.map((l) => l.id))),
    name: walk.name,
    visible: true,
    ...(capture !== undefined ? { capture } : {}),
    record: { path: recordPath(walk.id) },
    src: { path: walk.video.src },
    ...(walk.poster ? { poster: { path: walk.poster } } : {}),
    durationS: walk.video.durationS,
    ...(path ? { path } : {}),
  };
}

/** The walk layer whose record is this walk's `walk.json`, whatever its id. */
export function walkLayerOf(
  layers: readonly ProjectManifest['layers'][number][],
  walkId: string,
): WalkLayer | undefined {
  const record = recordPath(walkId);
  return layers.find(
    (l): l is WalkLayer => l.kind === 'walk' && 'path' in l.record && l.record.path === record,
  );
}

/** The layers the walks without one need, ids distinct from the manifest's and from each other. */
export function missingWalkLayers(
  walks: readonly WalkFile[],
  m: ProjectManifest,
  filesOf: (id: string) => WalkFiles,
): WalkLayer[] {
  const taken = new Set(m.layers.map((l) => l.id));
  const out: WalkLayer[] = [];
  for (const w of walks) {
    if (walkLayerOf(m.layers, w.id)) continue;
    const layer = { ...walkLayerFor(w, m, filesOf(w.id)), id: walkLayerId(w.id, taken) };
    taken.add(layer.id);
    out.push(layer);
  }
  return out;
}

async function has(root: string, walkId: string, name: string): Promise<boolean> {
  try {
    return (await stat(join(root, WALKS_DIR, walkId, name))).isFile();
  } catch {
    return false;
  }
}

/** Probe a walk's folder for the files a layer refers to. */
export async function walkFilesOn(root: string, walkId: string): Promise<WalkFiles> {
  const [raw, orientation, orientationData, points] = await Promise.all([
    has(root, walkId, RAW),
    has(root, walkId, ORIENTATION),
    has(root, walkId, ORIENTATION_DATA),
    has(root, walkId, POINTS),
  ]);
  return { raw, orientation, orientationData, points };
}

/** Injection point for tests: the save the migration uses. */
export interface MigrateOptions {
  update?: typeof updateManifestFile;
}

/**
 * Give every side-folder walk without a layer and without the marker one, and save the manifest
 * once when any was added (one read-and-save turn, backed up as every save). Every walk that has a
 * layer afterwards is marked (`WALK_LAYER_MARK`), so it is never added again. `added` lists the
 * layers either way: when the save fails, `saved` is false, `error` says why, the caller keeps
 * `added` in memory and nothing is marked (the next open tries again).
 */
export async function migrateWalks(
  root: string,
  o: MigrateOptions = {},
): Promise<{ added: WalkLayer[]; saved: boolean; error?: string }> {
  const walks: WalkFile[] = [];
  for (const w of await listWalks(root)) if (!(await walkLayerMarked(root, w.id))) walks.push(w);
  if (walks.length === 0) return { added: [], saved: false };
  const probed = new Map<string, WalkFiles>();
  for (const w of walks) probed.set(w.id, await walkFilesOn(root, w.id));
  const filesOf = (id: string) => probed.get(id) ?? NO_WALK_FILES;
  const update = o.update ?? updateManifestFile;
  try {
    const r = await update(root, (m) => {
      const added = missingWalkLayers(walks, m, filesOf);
      return {
        manifest: added.length > 0 ? { ...m, layers: [...m.layers, ...added] } : null,
        added,
      };
    });
    for (const w of walks)
      if (walkLayerOf(r.manifest.layers, w.id)) await markWalkLayer(root, w.id);
    return { added: r.added, saved: r.saved };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    try {
      const m = await updateManifestFile(root, (read) => ({ manifest: null, read }));
      return { added: missingWalkLayers(walks, m.read, filesOf), saved: false, error };
    } catch {
      return { added: [], saved: false, error };
    }
  }
}

/** How the file `name` of a walk's folder stands to its pose file: no pose yet, newer, or not. */
async function againstPose(
  root: string,
  walkId: string,
  name: string,
): Promise<'no-pose' | 'newer' | 'older'> {
  try {
    const file = (await stat(join(root, WALKS_DIR, walkId, name))).mtimeMs;
    const pose = await stat(join(root, WALKS_DIR, walkId, 'pose.json')).then(
      (s) => s.mtimeMs,
      () => undefined,
    );
    if (pose === undefined) return 'no-pose';
    return file > pose ? 'newer' : 'older';
  } catch {
    return 'older';
  }
}

/**
 * Fill `path` on walk layers whose files have appeared since (a `walk.process` job wrote them),
 * and save once. A placed walk whose raw path or orientation is new, or newer than its pose file,
 * has its pose rewritten from the fit in the same turn (put in place once the manifest is saved),
 * with `flight` and the quality saved on the layer (the walk was placed on its pins alone until its path came). Answers the ids that
 * changed; `onProblem` gets a line for each walk file that could not be used.
 */
export async function refreshWalkPaths(
  root: string,
  onProblem: (line: string) => void = () => undefined,
): Promise<string[]> {
  // no walks, nothing to link: the manifest is not taken for a turn
  if (!(await listWalks(root)).length) return [];
  const probe = new Map<string, WalkFiles>();
  // staged: the pose files are put in place only once the manifest is saved
  const staged: StagedWalkPose[] = [];
  const r = await updateManifestFile(root, async (m) => {
    const changed: string[] = [];
    let current = m;
    for (const l of m.layers) {
      const id = l.kind === 'walk' && 'path' in l.record ? walkIdOf(l.record.path) : undefined;
      if (l.kind !== 'walk' || id === undefined) continue;
      let files = probe.get(id);
      if (!files) {
        files = await walkFilesOn(root, id);
        probe.set(id, files);
      }
      const path = walkPathRefs(id, files) ?? l.path;
      const pathChanged = JSON.stringify(path) !== JSON.stringify(l.path);
      let next: ProjectManifest = pathChanged
        ? {
            ...current,
            layers: current.layers.map((x) => (x.id === l.id && path ? { ...l, path } : x)),
          }
        : current;
      let stale = false;
      let rewrote = false;
      if (l.place !== undefined && files.raw) {
        const states = [await againstPose(root, id, 'raw-path.json')];
        if (files.orientation) states.push(await againstPose(root, id, 'orientation.json'));
        stale = pathChanged || states.some((x) => x !== 'older');
        // a pose that is there and is older than its inputs is rewritten even if the layer reads
        // the same afterwards
        rewrote = states.includes('newer');
      }
      if (stale) {
        const pose = await stageWalkPose(root, next, l.id).catch(async (e: unknown) => {
          await discardWalkPoses(staged);
          throw e;
        });
        staged.push(pose);
        for (const line of pose.problems) onProblem(line);
        next = withPose(next, l.id, pose);
      }
      if (rewrote || JSON.stringify(next.layers) !== JSON.stringify(current.layers)) {
        changed.push(l.id);
        current = next;
      }
    }
    return {
      manifest: changed.length > 0 ? current : null,
      changed,
      afterSave: () => commitWalkPoses(staged),
      afterFail: () => discardWalkPoses(staged),
    };
  });
  return r.changed;
}

/** The walk id in `walks/<id>/walk.json` (a strict id, see `walkFolder`). */
function walkIdOf(record: string): string | undefined {
  if (!record.replaceAll('\\', '/').endsWith('/walk.json')) return undefined;
  return walkIdOfRecord(record) ?? undefined;
}
