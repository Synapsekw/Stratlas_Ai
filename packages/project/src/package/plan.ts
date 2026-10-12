import type { AssetRef, Layer, ProjectManifest } from '@aio/schema';

/** A file of the source project, path relative to its root with forward slashes. */
export interface SourceFile {
  path: string;
  size: number;
  mtimeMs?: number;
}

export interface LayerShare {
  id: string;
  name: string;
  kind: Layer['kind'];
  /** Bytes only this layer brings (files shared with other layers are not counted). */
  bytes: number;
  files: number;
}

export interface PackagePlanResult {
  /** The manifest the package carries: excluded layers removed. */
  manifest: ProjectManifest;
  /** Project files to copy (the manifest and package header are written by the exporter). */
  members: SourceFile[];
  /** One share per layer that can be packaged: a retired `legacy` layer has none. */
  layers: LayerShare[];
  /** Files no layer owns: issues, thumbnail, report, issue masks, stockpile grids. */
  baseBytes: number;
  totalBytes: number;
  totalFiles: number;
  /** Excluded layer ids that exist in the manifest. */
  excluded: string[];
}

/** Never packaged: backups, temp files, import notes, other packages, OS litter. */
const SKIP = [
  /^manifest\.json$/,
  /^aio-package\.json$/,
  /^IMPORT-REPORT\.md$/i,
  /\.(bak|tmp|part|partial|aio)$/i,
  // Copies kept aside by data fixes: `manifest.before-copc.json`, `video.before-1080/`, and
  // proxies being staged in `video.next-1080/`.
  /^[^/]+\.before-[^/]*\.json$/i,
  /^[^/]+\.(before|next)-[^/]+\//i,
  /(^|\/)(Thumbs\.db|desktop\.ini|\.DS_Store)$/i,
  // A 360 video being imported, or what an interrupted import left (`builder/walks.ts`): half a
  // playback copy, also under its final file name. Only a finished `walks/<id>/` travels.
  /^walks\/\.staging-[^/]*\//i,
];

/** Where importers put the delivered viewer until 11 Oct 2026, and the grids beside it. */
const RETIRED_DIR = 'legacy/';
const RETIRED_GRIDS = 'legacy/data/';

/** Inside a run folder only its records and reports travel (data-conventions section 21). */
const RUN_FILE = /^photogrammetry\/[^/]+\/(.+)$/;
const RUN_KEEP = /^(run\.json|gcp\.json|report\/.+)$/;
/** A folder prefix that is exactly a run folder, `photogrammetry/<run>/`. */
const RUN_DIR = /^photogrammetry\/[^/]+\/$/;
export function runFileTravels(path: string): boolean {
  const m = RUN_FILE.exec(path);
  return !m?.[1] || RUN_KEEP.test(m[1]);
}

const pathOf = (ref: AssetRef | undefined): string | null =>
  ref && 'path' in ref ? ref.path.replace(/\\/g, '/').replace(/^\.\//, '') : null;

const dirOf = (p: string) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

/**
 * Paths and folder prefixes a layer's files live under, and `kept`: folders inside those
 * prefixes that the layer does not own.
 */
function ownership(layer: Layer): { files: string[]; prefixes: string[]; kept: string[] } {
  const files: string[] = [];
  const prefixes: string[] = [];
  const kept: string[] = [];
  const add = (ref: AssetRef | undefined) => {
    const p = pathOf(ref);
    if (p) files.push(p);
  };
  /** Index formats keep their chunks or tiles in the folder beside the index. */
  const folderOf = (ref: AssetRef) => {
    const p = pathOf(ref);
    if (!p) return;
    files.push(p);
    const d = dirOf(p);
    if (d) prefixes.push(`${d}/`);
  };
  switch (layer.kind) {
    case 'mesh':
      add(layer.src);
      break;
    case 'pointcloud':
      if (layer.format === 'png-packed' || layer.format === 'potree2') folderOf(layer.src);
      else add(layer.src);
      break;
    case 'raster':
      if (layer.format === 'kit-pyramid') folderOf(layer.src);
      else add(layer.src);
      break;
    case 'video':
      add(layer.src);
      add(layer.poster);
      add(layer.flight.src);
      break;
    case 'photos':
      for (const item of layer.items) {
        const p = pathOf(item.src);
        if (!p) continue;
        files.push(p);
        const d = dirOf(p);
        files.push(`${d ? `${d}/` : ''}thumbs/${p.slice(d ? d.length + 1 : 0)}`);
      }
      break;
    case 'panoramas':
      for (const item of layer.items) add(item.src);
      break;
    case 'legacy': {
      // Retired: the viewer and its folder never travel. The grids beside a stockpile viewer
      // are what the volumes read, so they are not the layer's files.
      folderOf(layer.entry);
      const d = dirOf(pathOf(layer.entry) ?? '');
      if (layer.viewer === 'volumetric' && d) kept.push(`${d}/data/`);
      break;
    }
    case 'basemap':
      break;
  }
  return { files, prefixes, kept };
}

/**
 * Decide which files a package of `manifest` carries when the layers in `exclude` are left
 * out, and how many bytes each layer brings. A file shared by several layers (one flight file
 * for many clips) stays while any of them stays. Draft layers (`derived.draft`, a Model builder
 * preview nobody accepted) and retired `legacy` layers (the delivered viewer) are always left
 * out, and a `legacy` layer has no share; the rest of the project folder travels, so `change/`,
 * `models/` and `drawings/` go with it, and so does the `data/` folder beside a stockpile
 * viewer, which holds the grids of the volumes. `photogrammetry/<run>/` sends only its records
 * and reports (`run.json`, `gcp.json`, `report/`), never its work files, unless a layer owns them.
 */
export function planPackage(
  manifest: ProjectManifest,
  files: readonly SourceFile[],
  exclude: readonly string[],
): PackagePlanResult {
  const ids = new Set(manifest.layers.map((l) => l.id));
  const drafts = manifest.layers.filter((l) => l.derived?.draft === true).map((l) => l.id);
  const retired = manifest.layers.filter((l) => l.kind === 'legacy').map((l) => l.id);
  const excluded = [...new Set([...exclude, ...drafts, ...retired])].filter((id) => ids.has(id));
  const out = new Set(excluded);

  const owned = manifest.layers.map((l) => ({ layer: l, ...ownership(l) }));
  const exact = new Map<string, string[]>();
  for (const o of owned) {
    for (const f of o.files) exact.set(f, [...(exact.get(f) ?? []), o.layer.id]);
  }
  const ownersOf = (path: string): string[] => {
    const set = new Set(exact.get(path) ?? []);
    for (const o of owned) {
      if (o.kept.some((p) => path.startsWith(p))) continue;
      if (o.prefixes.some((p) => path.startsWith(p))) set.add(o.layer.id);
    }
    return [...set];
  };

  // A layer whose folder is the run folder itself (a pyramid beside its run.json) must not own
  // the run's work files; only an exact file or a folder deeper than the run folder counts.
  const ownedBeyondRun = (path: string): boolean =>
    exact.has(path) ||
    owned.some(
      (o) =>
        !o.kept.some((p) => path.startsWith(p)) &&
        o.prefixes.some((p) => !RUN_DIR.test(p) && path.startsWith(p)),
    );

  const shares = new Map<string, LayerShare>(
    manifest.layers
      .filter((l) => l.kind !== 'legacy')
      .map((l) => [l.id, { id: l.id, name: l.name, kind: l.kind, bytes: 0, files: 0 }]),
  );
  // A re-import writes a manifest without the retired layer and leaves the older viewer folder
  // on disk. No layer names it then, and it is not packed, except the grids a project with
  // volumes may still read from it.
  const orphanViewer = retired.length === 0;
  const hasVolumes = files.some((f) => f.path.replace(/\\/g, '/') === 'volumes.json');
  const members: SourceFile[] = [];
  let baseBytes = 0;
  for (const f of files) {
    const path = f.path.replace(/\\/g, '/');
    if (SKIP.some((re) => re.test(path))) continue;
    const owners = ownersOf(path);
    if (!runFileTravels(path) && !ownedBeyondRun(path)) continue;
    if (orphanViewer && owners.length === 0 && path.startsWith(RETIRED_DIR)) {
      if (!hasVolumes || !path.startsWith(RETIRED_GRIDS)) continue;
    }
    if (owners.length === 0) baseBytes += f.size;
    if (owners.length === 1) {
      const s = shares.get(owners[0] ?? '');
      if (s) {
        s.bytes += f.size;
        s.files++;
      }
    }
    if (owners.length > 0 && owners.every((id) => out.has(id))) continue;
    members.push({ ...f, path });
  }

  return {
    manifest: { ...manifest, layers: manifest.layers.filter((l) => !out.has(l.id)) },
    members,
    layers: [...shares.values()],
    baseBytes,
    totalBytes: members.reduce((n, m) => n + m.size, 0),
    totalFiles: members.length,
    excluded,
  };
}
