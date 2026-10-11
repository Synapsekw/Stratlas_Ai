import type {
  CameraOrientation,
  Capture,
  CapturePatch,
  LayerPatch,
  NewProjectRequest,
  ProjectManifest,
  SeverityTemplate,
  Vec3,
} from '@aio/schema';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { drawingStemOf, markDrawingPlaced, type PlacedDrawing } from './drawingPlacement';
import { updateManifestFile, writeManifestFile } from './manifestFile';
import { newProjectManifest } from './templates';

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
 * date) of any layer (`null` clears it), or the `corners` of a picture laid on the ground (placing
 * a drawing, which also shows it and marks its placement file as placed). Backs up and validates the manifest first. The manifest
 * is read and saved in one turn (`updateManifestFile`), so a save made at the same moment stays.
 */
export async function updateLayers(
  root: string,
  layerIds: readonly string[],
  patch: LayerPatch,
): Promise<{ manifest: ProjectManifest; backup: string }> {
  const r = await updateManifestFile(root, async (m) => {
    const { manifest, placed } = patchLayers(m, layerIds, patch);
    // a drawing this patch places: its placement file follows before the manifest is saved
    for (const d of placed) await markDrawingPlaced(root, d.stem, d.name, d.corners);
    return { manifest };
  });
  return { manifest: r.manifest, backup: r.backup };
}

/**
 * The manifest with `patch` applied to the layers `layerIds`, and the drawings the patch places;
 * throws what `updateLayers` refuses.
 */
function patchLayers(
  m: ProjectManifest,
  layerIds: readonly string[],
  patch: LayerPatch,
): { manifest: ProjectManifest; placed: PlacedDrawing[] } {
  const want = new Set(layerIds);
  for (const id of want)
    if (!m.layers.some((l) => l.id === id))
      throw new Error(`Layer "${id}" is not in this project.`);
  const placed: PlacedDrawing[] = [];
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  const layers = m.layers.map((l) => {
    if (!want.has(l.id)) return l;
    if ('capture' in patch) {
      if (patch.capture !== null && !m.captures.some((c) => c.id === patch.capture))
        throw new Error(`Capture "${patch.capture}" is not in this project.`);
      const next = { ...l };
      if (patch.capture === null) delete next.capture;
      else next.capture = patch.capture;
      return next;
    }
    if ('transform' in patch) {
      if (l.kind !== 'mesh')
        throw new Error(`"${l.name}" is not a model; only models take a transform.`);
      return { ...l, transform: [...patch.transform] };
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
    if (l.kind !== 'video')
      throw new Error(`"${l.name}" is not a video; time offset and lens belong to video layers.`);
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
