import type {
  CameraOrientation,
  Capture,
  CapturePatch,
  LayerPatchInput,
  NewProjectRequest,
  ProjectManifest,
  SeverityTemplate,
  Vec3,
} from '@aio/schema';
import { WalkCalibration } from '@aio/schema';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { drawingStemOf, markDrawingPlaced, type PlacedDrawing } from './drawingPlacement';
import { updateManifestFile, writeManifestFile } from './manifestFile';
import { applyMediaPin } from './mediaPin';
import { newProjectManifest } from './templates';
import {
  commitWalkPoses,
  discardWalkPoses,
  stageWalkPose,
  type StagedWalkPose,
  type WalkPoseResult,
} from './walkPose';

// the manifest file itself (read, save in turn) lives in manifestFile.ts
export {
  readManifestFile,
  updateManifestFile,
  withManifest,
  writeManifestFile,
  type ManifestChange,
  type ManifestUpdate,
} from './manifestFile';

/** Folders of a native project package (data-conventions section 2). */
export const PACKAGE_DIRS = [
  'models',
  'video',
  'posters',
  'flights',
  'clouds',
  'rasters',
  'photos/thumbs',
  'panoramas',
  'report',
  'walks',
];

/** Lower-case, file-safe id. */
export function slug(s: string, fallback = 'item'): string {
  const v = s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return v || fallback;
}

/** `base`, or `base-2`, `base-3` ... the first one `taken` does not hold. */
export function uniqueId(base: string, taken: (id: string) => boolean): string {
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${String(n)}`;
  return id;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Create `<dataRoot>/projects/<id>/` for a new project; never reuses an existing folder. */
export async function createProject(
  dataRoot: string,
  req: NewProjectRequest,
  template: SeverityTemplate | null = null,
): Promise<{ root: string; manifest: ProjectManifest }> {
  const projects = join(dataRoot, 'projects');
  await mkdir(projects, { recursive: true });
  const base = slug(req.name, 'project');
  let chosen = base;
  for (let n = 2; await exists(join(projects, chosen)); n++) chosen = `${base}-${String(n)}`;
  const root = join(projects, chosen);
  await mkdir(root);
  for (const d of PACKAGE_DIRS) await mkdir(join(root, d), { recursive: true });
  const manifest = newProjectManifest(chosen, req, template);
  await writeManifestFile(root, manifest);
  await writeFile(
    join(root, 'issues.json'),
    `${JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2)}\n`,
  );
  return { root, manifest };
}

/** Orientation bias to a thousandth of a degree (well below a pixel on any frame). */
function roundOrientation(o: CameraOrientation): CameraOrientation {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { yawDeg: r(o.yawDeg), pitchDeg: r(o.pitchDeg), rollDeg: r(o.rollDeg) };
}

/**
 * Apply an alignment to layers and save: a `transform` to mesh layers (georeference), `offsetMs`,
 * `lens`, `orientation` and `positionOffsetM` to video layers (calibration), the `capture` (survey
 * date) of any layer (`null` clears it), the `corners` of a picture laid on the ground (placing a
 * drawing, which also shows it and marks its placement file as placed), or the `walk` placement of
 * a walk layer (`null` clears it), or the `heightOffsetM` of a COPC or png-packed point cloud
 * (millimetres; `0` or `null` removes it). A walk patch, and new corners of a drawing a walk has pins on,
 * rewrite that walk's pose file (`walks/<id>/pose.json`, put in place only once the manifest is
 * saved, so a refused save leaves the old one) and set its `flight` and its quality as
 * the fit gives it here (the renderer's quality is a preview). Lines for the project log about walk
 * files that could not be used come back in `problems`. Backs up and validates the manifest first.
 * The manifest is read and saved in one turn (`updateManifestFile`), so a save made at the same
 * moment stays.
 */
export async function updateLayers(
  root: string,
  layerIds: readonly string[],
  patch: LayerPatchInput,
): Promise<{ manifest: ProjectManifest; backup: string; problems: string[] }> {
  const r = await updateManifestFile(root, async (m) => {
    const patched = patchLayers(m, layerIds, patch);
    // a drawing this patch places: its placement file follows before the manifest is saved
    for (const d of patched.placed) await markDrawingPlaced(root, d.stem, d.name, d.corners);
    let manifest = patched.manifest;
    const problems: string[] = [];
    // staged: the pose files are put in place only once the manifest is saved
    const staged: StagedWalkPose[] = [];
    try {
      for (const id of walksToPose(manifest, layerIds, patch)) {
        const pose = await stageWalkPose(root, manifest, id);
        staged.push(pose);
        problems.push(...pose.problems);
        manifest = withPose(manifest, id, pose);
      }
    } catch (e) {
      await discardWalkPoses(staged);
      throw e;
    }
    return {
      manifest,
      problems,
      afterSave: () => commitWalkPoses(staged),
      afterFail: () => discardWalkPoses(staged),
    };
  });
  return { manifest: r.manifest, backup: r.backup, problems: r.problems };
}

/**
 * The walk layers whose pose file a patch changes: the walks it places, and the walks with a pin on
 * a drawing it moves.
 */
function walksToPose(
  m: ProjectManifest,
  layerIds: readonly string[],
  patch: LayerPatchInput,
): string[] {
  const want = new Set(layerIds);
  if ('walk' in patch) return m.layers.filter((l) => want.has(l.id)).map((l) => l.id);
  if (!('corners' in patch)) return [];
  return m.layers
    .filter((l) => l.kind === 'walk' && l.place?.pins.some((p) => want.has(p.surface)))
    .map((l) => l.id);
}

/** The manifest with a walk's pose result on its layer: `flight` set or removed, the quality saved. */
export function withPose(m: ProjectManifest, id: string, pose: WalkPoseResult): ProjectManifest {
  const layers = m.layers.map((l) => {
    if (l.id !== id || l.kind !== 'walk') return l;
    const next = { ...l };
    if (pose.flight) next.flight = pose.flight;
    else delete next.flight;
    if (next.place) next.place = { ...next.place, quality: pose.quality };
    return next;
  });
  return { ...m, layers };
}

/**
 * The manifest with `patch` applied to the layers `layerIds`, and the drawings the patch places;
 * throws what `updateLayers` refuses.
 */
function patchLayers(
  m: ProjectManifest,
  layerIds: readonly string[],
  patch: LayerPatchInput,
): { manifest: ProjectManifest; placed: PlacedDrawing[] } {
  const want = new Set(layerIds);
  for (const id of want)
    if (!m.layers.some((l) => l.id === id))
      throw new Error(`Layer "${id}" is not in this project.`);
  if ('mediaPin' in patch && want.size > 1) throw new Error('Pin one item at a time.');
  const placed: PlacedDrawing[] = [];
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  const layers = m.layers.map((l) => {
    if (!want.has(l.id)) return l;
    if ('name' in patch) return { ...l, name: patch.name.trim() };
    if ('capture' in patch) {
      if (patch.capture !== null && !m.captures.some((c) => c.id === patch.capture))
        throw new Error(`Capture "${patch.capture}" is not in this project.`);
      const next = { ...l };
      if (patch.capture === null) delete next.capture;
      else next.capture = patch.capture;
      return next;
    }
    if ('photoPositions' in patch) {
      if (l.kind !== 'photos')
        throw new Error(`"${l.name}" is not photos; only photos have GPS places.`);
      return {
        ...l,
        items: l.items.map((p) => {
          const next = { ...p };
          delete next.pos;
          delete next.q;
          return next;
        }),
      };
    }
    // a ground placement, with the transform it goes with when given: one write for all three
    if ('georef' in patch || 'placement' in patch) {
      if (l.kind !== 'mesh')
        throw new Error(`"${l.name}" is not a model; only models take a ground placement.`);
      return {
        ...l,
        ...(patch.transform !== undefined ? { transform: [...patch.transform] } : {}),
        ...(patch.georef !== undefined ? { georef: patch.georef } : {}),
        ...(patch.placement !== undefined ? { placement: patch.placement } : {}),
      };
    }
    if ('transform' in patch) {
      if (l.kind !== 'mesh')
        throw new Error(`"${l.name}" is not a model; only models take a transform.`);
      return patch.transform ? { ...l, transform: [...patch.transform] } : l;
    }
    if ('corners' in patch) {
      if (l.kind !== 'raster' || l.format !== 'image')
        throw new Error(
          `"${l.name}" is not a picture; only a picture laid on the ground takes corners.`,
        );
      const round = (p: Vec3): Vec3 => [r6(p[0]), r6(p[1]), r6(p[2])];
      const { tl, tr, bl } = patch.corners;
      const side = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      // corners fitted from points that coincide: a picture with no width or no height
      if (!(side(tl, tr) > 1e-6) || !(side(tl, bl) > 1e-6))
        throw new Error(
          `"${l.name}" would have no size there. Pick points further apart, then place it again.`,
        );
      const corners = { tl: round(tl), tr: round(tr), bl: round(bl) };
      // a drawing that is placed shows (it was saved hidden while it had no place)
      const stem = drawingStemOf(l);
      if (stem === null) return { ...l, corners };
      placed.push({ stem, name: l.name, corners });
      return { ...l, corners, visible: true };
    }
    if ('walk' in patch) {
      if (l.kind !== 'walk')
        throw new Error(`"${l.name}" is not a 360 walk; only walks take a placement.`);
      const next = { ...l };
      if (patch.walk === null) {
        delete next.place;
        delete next.flight;
      } else {
        // pins sorted by time (stable, so pins at the same moment keep their order)
        const place = WalkCalibration.parse(patch.walk);
        next.place = { ...place, pins: [...place.pins].sort((a, b) => a.t - b.t) };
      }
      return next;
    }
    if ('mediaPin' in patch) return applyMediaPin(l, patch.mediaPin);
    if ('heightOffsetM' in patch) {
      if (l.kind !== 'pointcloud')
        throw new Error(
          `"${l.name}" is not a point cloud; only point clouds take a height offset.`,
        );
      if (l.format === 'kit-packed')
        throw new Error(`"${l.name}" is a kit-packed cloud, which cannot be moved.`);
      const next = { ...l };
      const off = patch.heightOffsetM === null ? 0 : Math.round(patch.heightOffsetM * 1000) / 1000;
      if (off === 0) delete next.heightOffsetM;
      else next.heightOffsetM = off;
      return next;
    }
    if (l.kind !== 'video')
      throw new Error(`"${l.name}" is not a video; time offset and lens belong to video layers.`);
    // the placement patch returned above; this narrows the rest to the video patch
    if (!(
      'offsetMs' in patch ||
      'lens' in patch ||
      'orientation' in patch ||
      'positionOffsetM' in patch
    ))
      return l;
    const next = {
      ...l,
      ...(patch.offsetMs !== undefined ? { offsetMs: Math.round(patch.offsetMs) } : {}),
      ...(patch.lens ? { lens: patch.lens } : {}),
      ...(patch.orientation ? { orientation: roundOrientation(patch.orientation) } : {}),
      ...(patch.positionOffsetM
        ? { positionOffsetM: patch.positionOffsetM.map((v) => Math.round(v * 1000) / 1000) as Vec3 }
        : {}),
    };
    if (patch.orientation === null) delete next.orientation;
    if (patch.positionOffsetM === null) delete next.positionOffsetM;
    return next;
  });
  return { manifest: { ...m, layers }, placed };
}

/**
 * Rename a survey date or set the colour and icon of its folder (`null` goes back to the automatic
 * one) and save. Only the `captures` entry changes: the date, the layers and every file stay as
 * they are. Backs up and validates the manifest first, read and saved in one turn.
 */
export async function updateCapture(
  root: string,
  captureId: string,
  patch: CapturePatch,
): Promise<{ manifest: ProjectManifest; backup: string }> {
  const r = await updateManifestFile(root, (m) => {
    if (!m.captures.some((c) => c.id === captureId))
      throw new Error(`Capture "${captureId}" is not in this project.`);
    const captures = m.captures.map((c) => {
      if (c.id !== captureId) return c;
      const next = { ...c };
      if (patch.label !== undefined) next.label = patch.label.trim();
      if (patch.colour === null) delete next.colour;
      else if (patch.colour !== undefined) next.colour = patch.colour;
      if (patch.icon === null) delete next.icon;
      else if (patch.icon !== undefined) next.icon = patch.icon;
      return next;
    });
    return { manifest: { ...m, captures } };
  });
  return { manifest: r.manifest, backup: r.backup };
}

/**
 * Remove a survey date no layer names and save. Only the `captures` entry goes: no layer and no
 * file changes. Refuses an unknown id and a date a layer still names (`Layer.capture`). Backs up and
 * validates the manifest first, read and saved in one turn.
 */
export async function removeCapture(
  root: string,
  captureId: string,
): Promise<{ manifest: ProjectManifest; backup: string }> {
  const r = await updateManifestFile(root, (m) => {
    if (!m.captures.some((c) => c.id === captureId))
      throw new Error(`There is no survey date "${captureId}" in this project.`);
    const named = m.layers.filter((l) => l.capture === captureId).length;
    if (named === 1) throw new Error('1 dataset is filed under this date. Move it first.');
    if (named > 1) throw new Error(`${named} datasets are filed under this date. Move them first.`);
    return { manifest: { ...m, captures: m.captures.filter((c) => c.id !== captureId) } };
  });
  return { manifest: r.manifest, backup: r.backup };
}

/** Survey dates in date order. The sort is stable: dates of one day stay in the order they had. */
export const byDate = (a: Capture, b: Capture): number => a.date.localeCompare(b.date);

/**
 * The survey date of a day in a manifest: the capture with that date (the first in the list), or
 * a new one, `capture-<date>` named "Survey", added in date order. Pure: nothing is saved.
 */
export function captureForDate(
  m: ProjectManifest,
  date: string,
): { manifest: ProjectManifest; captureId: string; created: boolean } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${date}" is not a date (YYYY-MM-DD).`);
  const found = m.captures.find((c) => c.date === date);
  if (found) return { manifest: m, captureId: found.id, created: false };
  const c: Capture = {
    id: uniqueId(`capture-${date}`, (x) => m.captures.some((k) => k.id === x)),
    label: 'Survey',
    date,
  };
  const captures = [...m.captures, c].sort(byDate);
  return { manifest: { ...m, captures }, captureId: c.id, created: true };
}

/**
 * Find the survey date of a day or add it, and save. A date that exists writes nothing; a new one
 * backs up and validates the manifest first. No layer and no file changes. Looked up and saved in
 * one turn, so two days asked for at the same moment are both added.
 */
export async function ensureCapture(
  root: string,
  date: string,
): Promise<{ manifest: ProjectManifest; captureId: string; created: boolean }> {
  const r = await updateManifestFile(root, (m) => {
    const c = captureForDate(m, date);
    return { manifest: c.created ? c.manifest : null, captureId: c.captureId, created: c.created };
  });
  return { manifest: r.manifest, captureId: r.captureId, created: r.created };
}
