import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { Issue, type ImageGeom } from '@aio/schema';
import { imageSize } from './image';
import {
  type PhotoTurn,
  type QuarterTurns,
  type SightingChange,
  confidentMatch,
  matchTurn,
  orientationProbe,
  turnImage,
  turnIssueSightings,
  turnProbe,
} from './orientation';

/**
 * One-off repair of a project whose photo files are stored another way up than the camera saw
 * them (the HCl kit's thumbnails: EXIF Orientation dropped). Each photo is compared with its
 * camera original (EXIF Orientation applied); photos and grid thumbnails that are turned are
 * turned back, and every image sighting in `issues.json` on them is turned with them.
 */
export interface ReorientOptions {
  /** Project package folder. */
  project: string;
  /** Folders searched (recursively, read only) for the originals, matched by file name = photo id. */
  references: string[];
  /** Photo layers to check (default: all). */
  layers?: string[];
  /** Write the changes (default: only plan). */
  apply?: boolean;
  /** Where the files are copied before they change (default `<project>/photos.before-orientation-<stamp>`). */
  backupDir?: string;
  log?: (msg: string) => void;
}

export interface PlannedTurn {
  layer: string;
  id: string;
  /** Project-relative path. */
  path: string;
  turn: QuarterTurns;
  /** Correlation with the original at that turn, and the best other turn. */
  score: number;
  runnerUp: number;
  width: number;
  height: number;
}

export interface ReorientPlan {
  photosChecked: number;
  photos: PlannedTurn[];
  thumbs: { path: string; turn: QuarterTurns }[];
  /** Photos left alone: no original, or no confident match. */
  unmatched: { layer: string; id: string; reason: string }[];
  sightings: SightingChange[];
  masks: string[];
  /** Set when applied. */
  backupDir?: string;
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp']);

/** Original files by lower-case base name (without extension); names found twice are dropped. */
export function indexOriginals(folders: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  const twice = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (IMAGE_EXT.has(extname(e.name).toLowerCase())) {
        const k = basename(e.name, extname(e.name)).toLowerCase();
        if (found.has(k)) twice.add(k);
        else found.set(k, p);
      }
    }
  };
  for (const f of folders) if (existsSync(f)) walk(f);
  for (const k of twice) found.delete(k);
  return found;
}

/** `<dir>/thumbs/<name>` for `<dir>/<name>` (data conventions section 2). */
const thumbOf = (rel: string) => join(dirname(rel), 'thumbs', basename(rel)).replace(/\\/g, '/');

interface PhotoLayerLike {
  kind: string;
  id: string;
  items?: { id: string; src: { path?: string } }[];
}

/** Plan (and with `apply`, perform) the repair. */
export async function reorientPhotos(opts: ReorientOptions): Promise<ReorientPlan> {
  const log = opts.log ?? (() => undefined);
  const abs = (rel: string) => join(opts.project, rel);
  const manifest = JSON.parse(readFileSync(abs('manifest.json'), 'utf8')) as {
    layers: PhotoLayerLike[];
  };
  const originals = indexOriginals(opts.references);
  log(`${String(originals.size)} originals indexed`);
  const plan: ReorientPlan = {
    photosChecked: 0,
    photos: [],
    thumbs: [],
    unmatched: [],
    sightings: [],
    masks: [],
  };
  const layers = manifest.layers.filter(
    (l) => l.kind === 'photos' && (!opts.layers || opts.layers.includes(l.id)),
  );
  for (const layer of layers) {
    for (const item of layer.items ?? []) {
      const rel = item.src.path;
      if (!rel || !existsSync(abs(rel))) continue;
      plan.photosChecked++;
      const ref = originals.get(item.id.toLowerCase());
      if (!ref) {
        plan.unmatched.push({ layer: layer.id, id: item.id, reason: 'no original' });
        continue;
      }
      const probe = await orientationProbe(abs(rel));
      const m = matchTurn(probe, await orientationProbe(ref, true));
      if (!confidentMatch(m)) {
        plan.unmatched.push({
          layer: layer.id,
          id: item.id,
          reason: `no confident match (best turn ${String(90 * m.turn)} deg, ${m.score.toFixed(2)} vs ${m.runnerUp.toFixed(2)})`,
        });
        continue;
      }
      const size = imageSize(readFileSync(abs(rel)));
      if (!size) throw new Error(`Cannot read the size of ${rel}`);
      if (m.turn !== 0)
        plan.photos.push({
          layer: layer.id,
          id: item.id,
          path: rel,
          turn: m.turn,
          score: m.score,
          runnerUp: m.runnerUp,
          width: size.width,
          height: size.height,
        });
      // the grid thumbnail, against the photo as it will be
      const thumb = thumbOf(rel);
      if (existsSync(abs(thumb))) {
        const t = matchTurn(await orientationProbe(abs(thumb)), turnProbe(probe, m.turn));
        if (confidentMatch(t) && t.turn !== 0) plan.thumbs.push({ path: thumb, turn: t.turn });
      }
    }
  }

  // issues: every image sighting on a turned photo turns with it
  const issuesFile = abs('issues.json');
  const issuesDoc = existsSync(issuesFile)
    ? (JSON.parse(readFileSync(issuesFile, 'utf8')) as { schema: string; issues: unknown[] })
    : null;
  // the saved objects as they are (fields this version does not know stay); only checked
  const saved = issuesDoc?.issues ?? [];
  const invalid = saved.filter((raw) => !Issue.safeParse(raw).success).length;
  if (invalid)
    throw new Error(`issues.json has ${String(invalid)} invalid issues; nothing was changed.`);
  let issues = saved as Issue[];
  for (const layer of layers) {
    const turns = new Map<string, PhotoTurn>(
      plan.photos
        .filter((p) => p.layer === layer.id)
        .map((p) => [p.id, { turn: p.turn, width: p.width, height: p.height }]),
    );
    if (!turns.size) continue;
    const r = turnIssueSightings(issues, layer.id, turns);
    issues = r.issues;
    plan.sightings.push(...r.changes);
  }
  for (const c of plan.sightings) {
    const g: ImageGeom = c.before;
    if (g.type === 'mask' && 'path' in g.src) plan.masks.push(g.src.path);
  }

  // detection passes keep their own boxes; refuse rather than leave them the old way up
  const turnedIds = new Set(plan.photos.map((p) => p.id));
  if (existsSync(abs('detections')) && turnedIds.size) {
    for (const f of readdirSync(abs('detections')).filter((n) => n.endsWith('.json'))) {
      const text = readFileSync(abs(join('detections', f)), 'utf8');
      const hit = [...turnedIds].find((id) => text.includes(`"${id}"`));
      if (hit)
        throw new Error(
          `detections/${f} has boxes on ${hit}, which needs turning; turning detection passes is not supported, nothing was changed.`,
        );
    }
  }

  if (!opts.apply || (!plan.photos.length && !plan.thumbs.length)) return plan;

  // back up, then replace each file atomically (written beside it, then renamed)
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..*$/, '')
    .replace('T', '-');
  const backup = opts.backupDir ?? abs(`photos.before-orientation-${stamp}`);
  if (existsSync(backup)) throw new Error(`Backup folder ${backup} already exists`);
  const files: { rel: string; turn: QuarterTurns }[] = [
    ...plan.photos.map((p) => ({ rel: p.path, turn: p.turn })),
    ...plan.thumbs.map((t) => ({ rel: t.path, turn: t.turn })),
    ...plan.masks.map((rel) => {
      const c = plan.sightings.find(
        (s) => s.before.type === 'mask' && 'path' in s.before.src && s.before.src.path === rel,
      );
      return { rel, turn: plan.photos.find((x) => x.id === c?.photo)?.turn ?? 0 };
    }),
  ];
  const keep = (rel: string) => {
    const dst = join(backup, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(abs(rel), dst);
  };
  for (const f of files) keep(f.rel);
  if (plan.sightings.length) keep('issues.json');
  writeFileSync(
    join(backup, 'report.json'),
    JSON.stringify({ at: new Date().toISOString(), references: opts.references, ...plan }, null, 1),
  );
  const replace = (rel: string, data: Buffer | string) => {
    const tmp = `${abs(rel)}.partial`;
    writeFileSync(tmp, data);
    renameSync(tmp, abs(rel));
  };
  for (const f of files) if (f.turn) replace(f.rel, await turnImage(abs(f.rel), f.turn));
  if (plan.sightings.length && issuesDoc)
    replace('issues.json', JSON.stringify({ ...issuesDoc, issues }, null, 2) + '\n');
  plan.backupDir = backup;
  return plan;
}
