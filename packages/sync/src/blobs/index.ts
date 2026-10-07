/**
 * Binaries by content (M9 T6, data-conventions section 20): which files each layer uses, the
 * project's blob index projected from `blob.add` ops, and the per-layer state. Hashing
 * (`hash.ts`), the local cache (`store.ts`) and transfers with fetch policies (`fetch.ts`) are
 * re-exported here.
 */
import {
  BlobAddPayload,
  type AssetRef,
  type BlobRef,
  type BlobState,
  type LayerKind,
  type ProjectManifest,
} from '@aio/schema';
import { createHash } from 'node:crypto';

export * from './fetch';
export * from './hash';
export * from './store';

/** Where a content-addressed `AssetRef` (`{ hash }`) lives in a folder project. */
export const HASH_ASSET_DIR = 'assets/sha256';

/** One file a layer reads. */
export interface LayerFile {
  layer: string;
  kind: LayerKind;
  /** Project-relative, forward slashes. */
  path: string;
  /** Known up front for `{ hash }` refs. */
  sha256?: string;
  role: BlobRef['role'];
}

/** A project-relative path with forward slashes and no leading slash. */
export function normalisePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

/** The project path of an asset reference (as `aio://` resolves it). */
export function assetPath(ref: AssetRef): { path: string; sha256?: string } {
  if ('hash' in ref) return { path: `${HASH_ASSET_DIR}/${ref.hash}`, sha256: ref.hash };
  return { path: normalisePath(ref.path) };
}

/** The sha256 a `assets/sha256/<hash>` path names, else undefined. */
export function hashFromAssetPath(path: string): string | undefined {
  const m = /^assets\/sha256\/([a-f0-9]{64})$/.exec(normalisePath(path));
  return m?.[1];
}

/**
 * Every file each layer reads: sources, posters, flight logs, photos and panoramas. Basemaps (map
 * packs live outside projects) and legacy viewers (small folders of their own) are left out.
 */
export function layerFiles(manifest: Pick<ProjectManifest, 'layers'>): LayerFile[] {
  const out: LayerFile[] = [];
  for (const layer of manifest.layers) {
    const role: BlobRef['role'] = layer.derived ? 'derived' : 'source';
    const add = (ref: AssetRef | undefined) => {
      if (!ref) return;
      const p = assetPath(ref);
      if (out.some((f) => f.layer === layer.id && f.path === p.path)) return;
      out.push({ layer: layer.id, kind: layer.kind, role, ...p });
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
      case 'photos':
      case 'panoramas':
        for (const item of layer.items) add(item.src);
        break;
      case 'basemap':
      case 'legacy':
        break;
    }
  }
  return out;
}

/** The project's registered blobs, by path and by hash. */
export interface BlobIndex {
  byPath: ReadonlyMap<string, BlobRef>;
  bySha: ReadonlyMap<string, BlobRef>;
}

const opOrder = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const ha = typeof a.hlc === 'string' ? a.hlc : '';
  const hb = typeof b.hlc === 'string' ? b.hlc : '';
  if (ha !== hb) return ha < hb ? -1 : 1;
  const ia = typeof a.id === 'string' ? a.id : '';
  const ib = typeof b.id === 'string' ? b.id : '';
  return ia < ib ? -1 : ia > ib ? 1 : 0;
};

/**
 * Project `blob.add` ops (raw JSON objects, any order) into the index: the last registration of a
 * path by clock wins, so every copy that has seen the same ops agrees. `local` holds this
 * machine's registrations not yet in the journal; journal ops win over them. Ops with a
 * malformed or redacted payload are skipped (Verify reports them).
 */
export function projectBlobIndex(
  ops: readonly Record<string, unknown>[],
  local: readonly BlobRef[] = [],
): BlobIndex {
  const byPath = new Map<string, BlobRef>();
  for (const ref of local) byPath.set(normalisePath(ref.path), ref);
  const adds = ops.filter((op) => op.kind === 'blob.add').sort(opOrder);
  for (const op of adds) {
    const parsed = BlobAddPayload.safeParse(op.payload);
    if (!parsed.success) continue;
    byPath.set(normalisePath(parsed.data.path), {
      ...parsed.data,
      path: normalisePath(parsed.data.path),
    });
  }
  const bySha = new Map<string, BlobRef>();
  for (const ref of byPath.values()) if (!bySha.has(ref.sha256)) bySha.set(ref.sha256, ref);
  return { byPath, bySha };
}

/** The registration of a hashed layer file. */
export function blobRefFor(file: LayerFile, hashed: { sha256: string; size: number }): BlobRef {
  return {
    sha256: hashed.sha256,
    size: hashed.size,
    path: file.path,
    role: file.role,
    layer: file.layer,
  };
}

/** Registrations the index lacks: a new path, or a path whose content changed. */
export function newRegistrations(index: BlobIndex, refs: readonly BlobRef[]): BlobRef[] {
  return refs.filter((r) => index.byPath.get(normalisePath(r.path))?.sha256 !== r.sha256);
}

/**
 * One state for a layer from its files' states: anything missing makes the layer missing (or
 * partial when a download has started), then stale, then streaming; else present.
 */
export function aggregateState(states: readonly BlobState[]): BlobState {
  const has = (s: BlobState) => states.includes(s);
  if (has('partial')) return 'partial';
  if (has('missing')) return 'missing';
  if (has('stale')) return 'stale';
  if (has('streaming')) return 'streaming';
  return 'present';
}

/** The key of a project's rebuildable cache folder (userData `journal-cache/<key>/`). */
export function projectCacheKey(root: string, platform: string = process.platform): string {
  let norm = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (platform === 'win32' || platform === 'darwin') norm = norm.toLowerCase();
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}
