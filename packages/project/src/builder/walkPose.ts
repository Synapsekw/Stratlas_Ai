import {
  fitWalk,
  surfaceFrameFromCorners,
  walkPoseSamples,
  walkQuality,
  type WalkSurfaces,
} from '@aio/geo';
import {
  readWalkOrientationData,
  WALK_ORIENT_SCHEMA,
  WALK_PATH_SCHEMA,
  WalkOrientation,
  WalkRawPath,
  type FlightRef,
  type LensModel,
  type ProjectManifest,
  type WalkLayer,
  type WalkQuality,
} from '@aio/schema';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { renameWhenFree } from '../import/rename';
import { drawingStemOf } from './drawingPlacement';

/*
 * The walk's pose file (the walk layer and placing, "The pose file"): `walks/<id>/pose.json`, a
 * normal `aio.flight/1` file written by main from the raw path, the orientation records, the
 * calibration and where every drawing a pin is on lies now. The fit is the same code the renderer
 * runs live (`@aio/geo` walk), so what the person saw is what is saved.
 */

/** The lens every 1.x reader accepts; the walk layer, not the lens, says the video is 360. */
export const WALK_POSE_LENS: LensModel = { model: 'pinhole', hfovDeg: 90, aspect: 2 };

const POSE = 'pose.json';
const RAW = 'raw-path.json';
const ORIENTATION = 'orientation.json';

/** What a drawing's placement file adds to its corners: the picture size and whether provisional. */
export interface DrawingSize {
  sizePx: [number, number];
  provisional: boolean;
}

/**
 * The surfaces of a project for the walk fit: a drawing (a plan raster layer id) through its
 * corners and the size of its picture (`placements`, by layer id), the base height from its
 * top-left corner. A drawing that is gone, has no corners or no placement file is null (its pins
 * are inactive).
 */
export function surfacesOf(
  m: ProjectManifest,
  placements: ReadonlyMap<string, DrawingSize>,
): WalkSurfaces {
  return {
    drawing(id) {
      const l = m.layers.find((x) => x.id === id);
      if (l?.kind !== 'raster' || !l.corners) return null;
      const p = placements.get(id);
      if (!p) return null;
      return surfaceFrameFromCorners(l.corners, p.sizePx, p.provisional);
    },
  };
}

/** The picture size and provisional flag of every drawing in `m` that has a placement file. */
export async function readDrawingSizes(
  root: string,
  m: ProjectManifest,
): Promise<Map<string, DrawingSize>> {
  const out = new Map<string, DrawingSize>();
  for (const l of m.layers) {
    const stem = drawingStemOf(l);
    if (stem === null) continue;
    try {
      const j = JSON.parse(
        await readFile(join(root, 'drawings', stem, 'placement.json'), 'utf8'),
      ) as { sizePx?: unknown; provisional?: unknown };
      const s = j.sizePx;
      if (
        Array.isArray(s) &&
        s.length === 2 &&
        typeof s[0] === 'number' &&
        typeof s[1] === 'number' &&
        s[0] > 0 &&
        s[1] > 0
      )
        out.set(l.id, { sizePx: [s[0], s[1]], provisional: j.provisional === true });
    } catch {
      // no placement file: its pins are inactive
    }
  }
  return out;
}

/** `walks/<id>` of a walk layer (the folder of its `walk.json`), or null for a hashed record. */
export function walkFolderOf(layer: WalkLayer): string | null {
  if (!('path' in layer.record)) return null;
  const dir = posix.dirname(layer.record.path.replace(/\\/g, '/'));
  return dir === '.' ? null : dir;
}

const isMissing = (e: unknown) => (e as { code?: unknown } | null)?.code === 'ENOENT';
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface WalkInputs {
  /** `raw-path.json`; null when missing, unreadable or a newer schema (pins-only placing). */
  raw: WalkRawPath | null;
  /** `orientation.json`; null when missing or refused (the stills' orientation is used). */
  orient: WalkOrientation | null;
  /** The header's records as `[t, qx, qy, qz, qw]` rows; null whenever `orient` is. */
  rows: Float64Array[] | null;
  /** One line per file that was there but could not be used, for the project log. */
  problems: string[];
}

/**
 * Read a walk's raw path and orientation. Never throws: a file that is missing reads as null, one
 * that is unreadable, corrupt or of a newer schema reads as null and is named in `problems`.
 */
export async function readWalkInputs(root: string, layer: WalkLayer): Promise<WalkInputs> {
  const problems: string[] = [];
  const dir = walkFolderOf(layer);
  if (dir === null) return { raw: null, orient: null, rows: null, problems };

  let raw: WalkRawPath | null = null;
  const rawName = `${dir}/${RAW}`;
  try {
    const j = JSON.parse(await readFile(join(root, rawName), 'utf8')) as { schema?: unknown };
    if (j.schema !== WALK_PATH_SCHEMA)
      problems.push(
        `${rawName} is ${typeof j.schema === 'string' ? j.schema : 'not a walk path'}, which this version does not read; the walk is placed by its pins only.`,
      );
    else {
      const p = WalkRawPath.safeParse(j);
      if (p.success) raw = p.data;
      else problems.push(`${rawName} is damaged; the walk is placed by its pins only.`);
    }
  } catch (e) {
    if (!isMissing(e))
      problems.push(
        `${rawName} could not be read (${why(e)}); the walk is placed by its pins only.`,
      );
  }

  let orient: WalkOrientation | null = null;
  let rows: Float64Array[] | null = null;
  const headName = `${dir}/${ORIENTATION}`;
  try {
    const j = JSON.parse(await readFile(join(root, headName), 'utf8')) as { schema?: unknown };
    const p = WalkOrientation.safeParse(j);
    if (j.schema !== WALK_ORIENT_SCHEMA)
      problems.push(
        `${headName} is ${typeof j.schema === 'string' ? j.schema : 'not a walk orientation'}, which this version does not read; the stills' orientation is used.`,
      );
    else if (!p.success) problems.push(`${headName} is damaged; the stills' orientation is used.`);
    else {
      const dataName = `${dir}/${p.data.data}`;
      try {
        const bytes = await readFile(join(root, dataName));
        const r = readWalkOrientationData(p.data, bytes);
        if (r === null)
          problems.push(
            `${dataName} does not hold the ${String(p.data.count)} records its header names; the stills' orientation is used.`,
          );
        else {
          orient = p.data;
          rows = r;
        }
      } catch (e) {
        problems.push(
          `${dataName} could not be read (${why(e)}); the stills' orientation is used.`,
        );
      }
    }
  } catch (e) {
    if (!isMissing(e))
      problems.push(`${headName} could not be read (${why(e)}); the stills' orientation is used.`);
  }
  return { raw, orient, rows, problems };
}

/** `capturedAt` (the camera's local time, no zone) read as UTC, ms; 0 when absent or unreadable. */
export function walkStartUtcMs(capturedAt: unknown): number {
  if (typeof capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(capturedAt))
    return 0;
  const ms = Date.parse(`${capturedAt}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

async function readStartUtcMs(root: string, layer: WalkLayer): Promise<number> {
  if (!('path' in layer.record)) return 0;
  try {
    const j = JSON.parse(await readFile(join(root, layer.record.path), 'utf8')) as {
      source?: { capturedAt?: unknown };
    };
    return walkStartUtcMs(j.source?.capturedAt);
  } catch {
    return 0;
  }
}

export interface WalkPoseResult {
  /** The pose file's reference for the layer; null when the walk is not placed (no file). */
  flight: FlightRef | null;
  /** The quality the fit gives, the one to save (the renderer's is a preview). */
  quality: WalkQuality;
  problems: string[];
}

/**
 * Write (or remove) `walks/<id>/pose.json` of the walk layer `layerId` from the manifest `m` as it
 * is about to be saved: placed (two active pins and a fit), the file is written through
 * `pose.json.tmp`; not placed, the file is removed. The caller puts `flight` and `quality` on the
 * layer. Placement files of the drawings are read from `root`, so write them first.
 */
export async function writeWalkPose(
  root: string,
  m: ProjectManifest,
  layerId: string,
): Promise<WalkPoseResult> {
  const layer = m.layers.find((l) => l.id === layerId);
  if (layer?.kind !== 'walk') throw new Error(`Walk "${layerId}" is not in this project.`);
  const dir = walkFolderOf(layer);
  if (dir === null) return { flight: null, quality: 'unplaced', problems: [] };
  const file = join(root, dir, POSE);
  const removePose = () => rm(file, { force: true });

  const cal = layer.place;
  if (!cal) {
    await removePose();
    return { flight: null, quality: 'unplaced', problems: [] };
  }
  const { raw, rows, problems } = await readWalkInputs(root, layer);
  const surfaces = surfacesOf(m, await readDrawingSizes(root, m));
  const fit = fitWalk(raw, cal, surfaces, layer.durationS);
  const quality = walkQuality(fit);
  const samples =
    quality === 'unplaced' ? [] : walkPoseSamples(fit, raw, rows, cal, layer.durationS);
  if (samples.length === 0) {
    await removePose();
    return { flight: null, quality, problems };
  }
  const startUtcMs = await readStartUtcMs(root, layer);
  const doc = {
    schema: 'aio.flight/1',
    name: layer.name,
    startUtcMs,
    lens: WALK_POSE_LENS,
    samples,
  };
  const tmp = `${file}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(doc)}\n`);
    await renameWhenFree(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  return { flight: { src: { path: `${dir}/${POSE}` }, startUtcMs }, quality, problems };
}
