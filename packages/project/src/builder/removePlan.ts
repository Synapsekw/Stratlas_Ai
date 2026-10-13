import {
  CHANGE_DIR,
  MEASUREMENTS_FILE,
  PHOTO_DIR,
  SURFACES_DIR,
  TILES_DIR,
  TILESETS_FILE,
  PhotoProduct,
  PhotoRun,
  PhotoRunId,
  emptyRemovalPlan,
  type AssetRef,
  type JobStatus,
  type KeptCapture,
  type Layer,
  type RemovalPlan,
  type RemoveTarget,
  type RemoveWhy,
} from '@aio/schema';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { readManifestFile } from './manifestFile';
import { pathBytes, TRASH_DIR } from './trash';
import { walkFolder } from './walkPaths';

/*
 * What a removal takes along (delete and start over, founder 13 Oct 2026; spec "Resolving
 * dependents"). Read from the project's own files, never from an index: the manifest, every
 * `photogrammetry/<run>/run.json`, `change/*.json`, `tilesets.json`, `survey/surfaces/<id>/tiles.json`,
 * `detections/*.json`, `issues.json`, `volumes.json`, `survey/qa/` and `survey/measurements.json`.
 * The set grows to a fixed point; issues, walk pins and measurements are kept and only counted.
 * Pure data: the dialog shows it and `removeItems` plans again from disk before it moves anything.
 */

/** A job of this project as the plan needs it (main hands in its job index). */
export interface PlanJob {
  id: string;
  pipeline: string;
  status: string;
  params: Record<string, unknown>;
}

export interface PlanOptions {
  /** This project's jobs from `userData/jobs.json`; none: no job is known. */
  jobs?: readonly PlanJob[];
  /** Set for a package: the plan is refused with this sentence. */
  readOnly?: string;
}

/** Products a run commits as `<run>-<product>` layers (`tiles` becomes a tileset, not a layer). */
export const RUN_PRODUCTS: readonly PhotoProduct[] = PhotoProduct.exclude(['tiles']).options;
/** A job that still runs: the job store's `ACTIVE` and the renderer's `isActive` rule. */
const LIVE: ReadonlySet<string> = new Set<JobStatus>(['starting', 'running', 'cancelling']);
const LAYER_KEYS = new Set(['layer', 'layerFrom', 'layerTo']);
/** What a person calls a job in a refusal. */
const JOB_WORDS: Readonly<Record<string, string>> = {
  'photo.align': 'Matching the photos',
  'photo.georef': 'Adjusting with ground control',
  'photo.products': 'Creating maps',
  'tiles.mesh': 'Making 3D tiles',
  'tiles.cloud': 'Making 3D tiles',
  'opf.export': 'Exporting as OPF',
};
/** Never moved, whatever names them. */
const NEVER = ['manifest.json', TRASH_DIR, 'assets', 'journal'];

type Json = Record<string, unknown>;
type RunStatus = RemovalPlan['runs'][number]['status'];
const asRecord = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const asStrings = (v: unknown): string[] =>
  asArray(v).filter((x): x is string => typeof x === 'string');
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '');
const abs = (root: string, rel: string) => join(root, ...rel.split('/'));
const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );
const isDir = (p: string) =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );
/** Windows paths are case-insensitive: `Photos/a.jpg` and `photos/a.jpg` are one file there. */
const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
/** One path is the other or inside it (case-folded on Windows). */
const overlaps = (x: string, y: string) => {
  const a = fold(x);
  const b = fold(y);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Every string found under one of `keys`, anywhere in `v`. */
export function valuesUnder(
  v: unknown,
  keys: ReadonlySet<string>,
  out = new Set<string>(),
): Set<string> {
  if (Array.isArray(v)) {
    for (const x of v as unknown[]) valuesUnder(x, keys, out);
    return out;
  }
  const r = asRecord(v);
  if (r)
    for (const [k, x] of Object.entries(r)) {
      if (keys.has(k) && typeof x === 'string') out.add(x);
      else valuesUnder(x, keys, out);
    }
  return out;
}

/** The first string anywhere in `v` that is in `ids`, or null. */
export function namesAny(v: unknown, ids: ReadonlySet<string>): string | null {
  if (typeof v === 'string') return ids.has(v) ? v : null;
  for (const x of Array.isArray(v) ? (v as unknown[]) : Object.values(asRecord(v) ?? {})) {
    const hit = namesAny(x, ids);
    if (hit !== null) return hit;
  }
  return null;
}

/** Project-relative paths of a layer's `{ path }` refs; mirrors `layerFiles` in `@aio/sync`. */
export function layerRefs(layer: Layer): string[] {
  const out: string[] = [];
  const add = (ref: AssetRef | undefined) => {
    if (!ref || !('path' in ref)) return;
    const p = norm(ref.path);
    if (!out.includes(p)) out.push(p);
  };
  switch (layer.kind) {
    case 'mesh':
    case 'pointcloud':
    case 'raster':
    case 'vector':
      add(layer.src);
      break;
    case 'video':
      add(layer.src);
      add(layer.poster);
      add(layer.flight.src);
      break;
    case 'walk':
      add(layer.record);
      add(layer.src);
      add(layer.poster);
      add(layer.path?.raw);
      add(layer.path?.orientation);
      add(layer.path?.orientationData);
      add(layer.path?.points);
      add(layer.flight?.src);
      break;
    case 'photos':
    case 'panoramas':
      for (const item of layer.items) add(item.src);
      break;
    case 'basemap':
    case 'legacy':
      break;
  }
  return out;
}

/** `photos/a.JPG` has its thumbnail at `photos/thumbs/a.jpg` (data-conventions section 2). */
function thumbOf(p: string): string {
  const i = p.lastIndexOf('/');
  const stem = p.slice(i + 1).replace(/\.[^.]+$/, '');
  return `${i < 0 ? '' : `${p.slice(0, i)}/`}thumbs/${stem}.jpg`;
}

/**
 * What a layer owns on disk: its folder when a ref sits at `<category>/<layer id>/<file>` or
 * deeper, else the files. Never a top-level folder: an undated raw import's photos layer is
 * named `photos` and its items sit at `photos/<file>`, beside files it does not own.
 */
export function ownedPaths(layer: Layer): string[] {
  const out = new Set<string>();
  if (layer.kind === 'walk') {
    // walk layers are `walk-<id>`: the folder comes from the record, not from the layer id
    const folder = 'path' in layer.record ? walkFolder(layer.record.path) : null;
    if (folder) out.add(folder);
    return [...out];
  }
  for (const p of layerRefs(layer)) {
    const parts = p.split('/');
    if (parts.length >= 3 && parts[parts.length - 2] === layer.id)
      out.add(parts.slice(0, -1).join('/'));
    else out.add(p);
    if (layer.kind === 'photos' || layer.kind === 'panoramas') out.add(thumbOf(p));
  }
  if (layer.kind === 'raster') out.add(`sources/${layer.id}.json`);
  return [...out];
}

interface RunFile {
  id: string;
  status: RunStatus;
  source: Json | null;
  layers: string[];
  tilesets: string[];
}
interface ChangeFile {
  id: string;
  from?: string | undefined;
  to?: string | undefined;
  layers: string[];
  names: Set<string>;
}
interface Project {
  runs: RunFile[];
  changes: ChangeFile[];
  tilesets: {
    id: string;
    src?: string | undefined;
    from?: string | undefined;
    run?: string | undefined;
  }[];
  surfaces: { id: string; layer?: string | undefined; of?: string | undefined }[];
  detections: { path: string; layer?: string | undefined }[];
  issues: unknown[];
}

async function readProject(root: string): Promise<Project> {
  const runs: RunFile[] = [];
  for (const id of await names(abs(root, PHOTO_DIR))) {
    if (!PhotoRunId.safeParse(id).success) continue;
    if (!(await isDir(join(abs(root, PHOTO_DIR), id)))) continue;
    const doc = asRecord(await readJson(join(abs(root, PHOTO_DIR), id, 'run.json')));
    const outputs = asRecord(doc?.outputs);
    const status = PhotoRun.shape.status.safeParse(doc?.status);
    runs.push({
      id,
      status: status.success ? status.data : null,
      source: asRecord(asRecord(doc?.photos)?.source),
      layers: asStrings(outputs?.layers),
      tilesets: asStrings(outputs?.tilesets),
    });
  }
  const changes: ChangeFile[] = [];
  for (const f of await names(abs(root, CHANGE_DIR))) {
    if (!f.endsWith('.json')) continue;
    const doc = asRecord(await readJson(join(abs(root, CHANGE_DIR), f)));
    if (!doc) continue;
    changes.push({
      id: f.slice(0, -'.json'.length),
      ...(str(doc.from) ? { from: str(doc.from) } : {}),
      ...(str(doc.to) ? { to: str(doc.to) } : {}),
      layers: asStrings(doc.layers),
      names: valuesUnder(doc.items, LAYER_KEYS),
    });
  }
  const tilesets = asArray(asRecord(await readJson(abs(root, TILESETS_FILE)))?.entries).flatMap(
    (e) => {
      const r = asRecord(e);
      const id = str(r?.id);
      return r && id ? [{ id, src: str(r.src), from: str(r.from), run: str(r.run) }] : [];
    },
  );
  const surfaces: Project['surfaces'] = [];
  for (const id of await names(abs(root, SURFACES_DIR))) {
    const src = asRecord(
      asRecord(await readJson(join(abs(root, SURFACES_DIR), id, 'tiles.json')))?.source,
    );
    surfaces.push({ id, layer: str(src?.layer), of: str(src?.of) });
  }
  const detections: Project['detections'] = [];
  for (const f of await names(join(root, 'detections'))) {
    if (!f.endsWith('.json')) continue;
    const doc = asRecord(await readJson(join(root, 'detections', f)));
    detections.push({ path: `detections/${f}`, layer: str(doc?.layer) });
  }
  const issues = asArray(asRecord(await readJson(join(root, 'issues.json')))?.issues);
  return { runs, changes, tilesets, surfaces, detections, issues };
}

async function captureKeptBy(root: string, id: string): Promise<KeptCapture['by'] | null> {
  if (valuesUnder(await readJson(join(root, 'volumes.json')), new Set(['captureId'])).has(id))
    return 'volume';
  if (await exists(join(root, 'survey', 'qa', `${id}.json`))) return 'qa';
  if (valuesUnder(await readJson(abs(root, MEASUREMENTS_FILE)), new Set(['capture'])).has(id))
    return 'measurement';
  return null;
}

/** True when `rel` is not a plain path inside the project, or resolves outside it (a link). */
async function leadsOutside(root: string, realRoot: string, rel: string): Promise<boolean> {
  if (rel.split('/').includes('..') || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return true;
  let real: string;
  try {
    real = await realpath(abs(root, rel));
  } catch {
    return false; // gone: nothing to move
  }
  const r = relative(fold(realRoot), fold(real));
  return r === '' || r.startsWith('..') || isAbsolute(r);
}

export async function planRemoval(
  root: string,
  targets: readonly RemoveTarget[],
  o: PlanOptions = {},
): Promise<RemovalPlan> {
  const refuse = (why: string): RemovalPlan => ({ ...emptyRemovalPlan(), refused: why });
  if (o.readOnly !== undefined) return refuse(o.readOnly);
  const m = await readManifestFile(root);
  const pf = await readProject(root);
  const byId = new Map(m.layers.map((l) => [l.id, l]));
  const layerWhy = new Map<string, RemoveWhy>();
  const runWhy = new Map<string, RemoveWhy>();
  const changeWhy = new Map<string, RemoveWhy>();
  const captures: string[] = [];
  const keptCaptures: KeptCapture[] = [];
  const take = (id: string, why: RemoveWhy) => {
    if (!byId.has(id) || layerWhy.has(id)) return false;
    layerWhy.set(id, why);
    return true;
  };

  for (const t of targets) {
    if ('layer' in t) {
      if (!byId.has(t.layer)) return refuse(`There is no dataset "${t.layer}" in this project.`);
      layerWhy.set(t.layer, 'asked');
    } else if ('run' in t) {
      // checked before anything is looked up: a run id is a plain folder name, never '..' or 'a/b'
      if (!PhotoRunId.safeParse(t.run).success || !pf.runs.some((r) => r.id === t.run))
        return refuse(`There is no run "${t.run}" in this project.`);
      runWhy.set(t.run, 'asked');
    } else {
      if (!m.captures.some((c) => c.id === t.capture))
        return refuse(`There is no survey date "${t.capture}" in this project.`);
      for (const l of m.layers) if (l.capture === t.capture) take(l.id, { filedUnder: t.capture });
      const by = await captureKeptBy(root, t.capture);
      if (by) keptCaptures.push({ id: t.capture, by });
      else captures.push(t.capture);
    }
  }

  for (let grew = true; grew;) {
    grew = false;
    for (const r of pf.runs) {
      const src = str(r.source?.layer);
      if (!runWhy.has(r.id) && src !== undefined && layerWhy.has(src)) {
        runWhy.set(r.id, { usedBy: src });
        grew = true;
      }
    }
    for (const id of [...runWhy.keys()]) {
      const listed = pf.runs.find((r) => r.id === id)?.layers ?? [];
      for (const l of [...listed, ...RUN_PRODUCTS.map((s) => `${id}-${s}`)])
        if (take(l, { madeBy: id })) grew = true;
    }
    for (const c of pf.changes) {
      if (changeWhy.has(c.id)) continue;
      const hit = [...c.names, ...c.layers].find((id) => layerWhy.has(id));
      if (hit !== undefined) {
        changeWhy.set(c.id, { usedBy: hit });
        grew = true;
      }
    }
    for (const c of pf.changes)
      if (changeWhy.has(c.id))
        for (const id of c.layers) if (take(id, { madeBy: c.id })) grew = true;
    for (const l of m.layers) {
      const d = l.derived;
      if (d?.changeId && changeWhy.has(d.changeId) && take(l.id, { madeBy: d.changeId }))
        grew = true;
      const src = d?.source?.find((s) => layerWhy.has(s));
      if (src !== undefined && take(l.id, { usedBy: src })) grew = true;
    }
  }

  const runIds = new Set(runWhy.keys());
  const layerIds = new Set(layerWhy.keys());
  for (const j of o.jobs ?? []) {
    if (!LIVE.has(j.status)) continue;
    const words = JOB_WORDS[j.pipeline] ?? `The ${j.pipeline} job`;
    const run = str(j.params.run);
    if (run !== undefined && runIds.has(run))
      return refuse(`${words} for run ${run} is still running. Cancel it first.`);
    const hit = namesAny(j.params, layerIds);
    if (hit !== null)
      return refuse(
        `${words} uses "${byId.get(hit)?.name ?? hit}" and is still running. Cancel it first.`,
      );
  }

  const runTilesets = new Set(pf.runs.filter((r) => runIds.has(r.id)).flatMap((r) => r.tilesets));
  const tilesets = pf.tilesets.filter(
    (t) =>
      (t.run !== undefined && runIds.has(t.run)) ||
      (t.from !== undefined && layerIds.has(t.from)) ||
      runTilesets.has(t.id),
  );
  const surfaceIds = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const s of pf.surfaces)
      if (
        !surfaceIds.has(s.id) &&
        ((s.layer !== undefined && layerIds.has(s.layer)) ||
          (s.of !== undefined && surfaceIds.has(s.of)))
      ) {
        surfaceIds.add(s.id);
        grew = true;
      }
  }
  const detections = pf.detections
    .filter((d) => d.layer !== undefined && layerIds.has(d.layer))
    .map((d) => d.path);
  const jobs = (o.jobs ?? []).filter((j) => {
    const run = str(j.params.run);
    return run !== undefined && runIds.has(run);
  });

  const removed = m.layers.filter((l) => layerIds.has(l.id));
  const kept = m.layers
    .filter((l) => !layerIds.has(l.id))
    .flatMap((l) => [...ownedPaths(l), ...layerRefs(l)]);
  const candidates = new Set<string>();
  for (const id of runIds) candidates.add(`${PHOTO_DIR}/${id}`);
  for (const l of removed) for (const p of ownedPaths(l)) candidates.add(p);
  for (const t of tilesets) {
    const folder = `${TILES_DIR}/${t.id}`;
    candidates.add(
      t.src !== undefined && !norm(t.src).startsWith(`${folder}/`) ? norm(t.src) : folder,
    );
  }
  for (const c of changeWhy.keys()) {
    candidates.add(`${CHANGE_DIR}/${c}.json`);
    candidates.add(`${CHANGE_DIR}/${c}`);
  }
  for (const s of surfaceIds) candidates.add(`${SURFACES_DIR}/${s}`);
  for (const d of detections) candidates.add(d);
  for (const j of jobs) candidates.add(`jobs/${j.id}`);

  const realRoot = await realpath(root);
  const files: string[] = [];
  // sorted: a folder comes before what is inside it, so nothing moves twice
  for (const rel of [...candidates].sort((a, b) =>
    fold(a) < fold(b) ? -1 : fold(a) > fold(b) ? 1 : 0,
  )) {
    if (rel === '' || NEVER.some((n) => overlaps(rel, n))) continue;
    if (kept.some((k) => overlaps(rel, k))) continue;
    if (files.some((f) => overlaps(rel, f))) continue;
    if (await leadsOutside(root, realRoot, rel))
      return refuse(
        `"${rel}" leads outside the project folder (a link or junction). Nothing was removed.`,
      );
    if (await exists(abs(root, rel))) files.push(rel);
  }
  let bytes = 0;
  for (const f of files) bytes += await pathBytes(abs(root, f));

  const walkPins = m.layers.reduce(
    (n, l) =>
      n +
      (l.kind === 'walk' && !layerIds.has(l.id)
        ? (l.place?.pins.filter((p) => layerIds.has(p.surface)).length ?? 0)
        : 0),
    0,
  );
  const issues = pf.issues.filter((i) =>
    asArray(asRecord(i)?.sightings).some((s) => {
      const id = str(asRecord(s)?.layer);
      return id !== undefined && layerIds.has(id);
    }),
  ).length;
  const dateOf = (id?: string) => m.captures.find((c) => c.id === id)?.date ?? id ?? '';
  return {
    ...emptyRemovalPlan(),
    layers: removed.map((l) => ({
      id: l.id,
      name: l.name,
      kind: l.kind,
      why: layerWhy.get(l.id) ?? 'asked',
    })),
    runs: [...runIds].map((id) => ({
      id,
      status: pf.runs.find((r) => r.id === id)?.status ?? null,
      why: runWhy.get(id) ?? 'asked',
    })),
    changes: pf.changes
      .filter((c) => changeWhy.has(c.id))
      .map((c) => ({
        id: c.id,
        name: `${dateOf(c.from)} to ${dateOf(c.to)}`,
        why: changeWhy.get(c.id) ?? 'asked',
      })),
    tilesets: tilesets.map((t) => t.id),
    surfaces: [...surfaceIds],
    detections,
    jobs: jobs.map((j) => j.id),
    captures,
    keptCaptures,
    keptOutside: pf.runs
      .filter((r) => runIds.has(r.id))
      .flatMap((r) => asStrings(r.source?.folders)),
    files,
    bytes,
    touches: { issues, walkPins },
  };
}
