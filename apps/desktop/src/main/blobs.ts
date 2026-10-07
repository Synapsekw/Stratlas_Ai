/**
 * Binaries by content (M9 stream T6): per-layer status, fetch policies, downloads and indexing
 * (`blobs:*`, event `blobs:progress`), and what `aio://` serves for a file this computer lacks
 * (`lookup`: the cached copy, a stream from the shared folder, or `MISSING_BLOB_HEADER`).
 *
 * A project that is never shared works as before: its files stay where they are, nothing is moved
 * or renamed, and hashing happens only when asked (`blobs:index`), cached by size, mtime and inode.
 * Downloads go to userData `blobs/`, verified by hash on arrival; nothing there is deleted except
 * by an explicit Free space, and then only blobs the hub or server also holds.
 */
import type { ZipArchive } from '@aio/project/package';
import {
  HUB_PATHS,
  TeamConfigFile,
  blobPath,
  ipcEvents,
  type BlobRef,
  type BlobState,
  type FetchPolicy,
  type IpcEvent,
  type LayerBlobStatus,
  type ProjectManifest,
  type ProjectTeamConfig,
} from '@aio/schema';
import {
  HashCache,
  aggregateState,
  blobRefFor,
  cachedHash,
  createBlobStore,
  createFetchQueue,
  fetchesWithoutClick,
  folderBlobFile,
  folderBlobSource,
  hashFromAssetPath,
  layerFiles,
  newRegistrations,
  normalisePath,
  policyFor,
  projectBlobIndex,
  projectCacheKey,
  stampOf,
  type BlobIndex,
  type BlobSource,
  type BlobStore,
  type BlobWant,
  type FetchJobResult,
  type LayerFile,
} from '@aio/sync/blobs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { readJson, writeJsonAtomic } from './fsutil';
import type { Handle } from './notYet';
import { readManifest } from './project';

/** What `aio://` serves for a project file that is not in the project folder. */
export type BlobLookup =
  | { kind: 'file'; path: string; streaming: boolean }
  | { kind: 'missing'; sha256: string; size: number };

export interface BlobServiceDeps {
  userData: string;
  /** Root folder of an opened folder project (packages carry their files and need nothing). */
  projectRoot(id: string): string | undefined;
  /** Bytes the download cache may hold (`Settings.team.blobCacheGb`). */
  capBytes(): number;
  /** Send `blobs:progress` to the renderer. */
  emit?(event: IpcEvent<'blobs:progress'>): void;
  /**
   * Record `blob.add` ops (T1's journal service). Until it is wired, registrations stay in this
   * machine's rebuildable cache (`journal-cache/<key>/blobs.json`).
   */
  register?(projectId: string, root: string, refs: BlobRef[]): Promise<void>;
  /** This machine's sharing setup of a project folder; default reads userData `team/projects.json`. */
  teamConfig?(root: string): Promise<ProjectTeamConfig | undefined>;
  /** Further sources for a project: an imported bundle, a team server transport (T5, T7). */
  sources?(projectId: string, root: string): Promise<BlobSource[]>;
  /** Download rate cap in bytes per second (none by default). */
  maxBytesPerSecond?: number;
  /** Read rate cap of background indexing, so playback stays smooth (100 MB/s by default). */
  indexBytesPerSecond?: number;
}

export interface BlobService {
  status(projectId: string): Promise<{ layers: LayerBlobStatus[]; cache: CacheUse } | null>;
  /** Download a layer's files (or one blob); resolves when the job ends. */
  fetch(req: {
    jobId: string;
    projectId: string;
    layer?: string;
    sha256?: string;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
  cancel(jobId: string): boolean;
  setPolicy(projectId: string, layer: string, policy: FetchPolicy): Promise<boolean>;
  /** Hash and register the project's layer files; resolves when the job ends. */
  index(jobId: string, projectId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  lookup(projectId: string, rel: string): Promise<BlobLookup | null>;
  /** Forget the cached index of a project (new ops arrived: T5 calls this after a sync). */
  invalidate(projectId: string): void;
  /**
   * Copy every registered blob of the project that `source` holds and this computer lacks: the
   * blob section of an imported bundle (T5). Progress on `blobs:progress` under `jobId`.
   */
  ingest(
    jobId: string,
    projectId: string,
    source: BlobSource,
  ): Promise<{ ok: true; fetched: number } | { ok: false; error: string }>;
  /**
   * Free space in the download cache on request: only blobs the hub or server also holds, never
   * one an open project uses. No channel yet (proposed `blobs:free`).
   */
  freeSpace(targetBytes?: number): Promise<{ removed: number; freed: number }>;
  readonly store: BlobStore;
}

interface CacheUse {
  bytes: number;
  capBytes: number;
}

interface LocalCache {
  hashes: HashCache;
  registered: BlobRef[];
}

const CACHE_SCHEMA = 'aio.blob-cache/1';

/** Progress events at most this often per job. */
const EVENT_MS = 150;

/** A download rate cap the e2e suite sets to watch progress, cancel and resume. */
function testRate(): number | undefined {
  const n = Number(process.env.QUADRION_E2E_BLOB_RATE);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function createBlobService(deps: BlobServiceDeps): BlobService {
  const store = createBlobStore(join(deps.userData, 'blobs'));
  const rate = deps.maxBytesPerSecond ?? testRate();
  const queue = createFetchQueue(store, rate ? { maxBytesPerSecond: rate } : {});
  const indexJobs = new Map<string, AbortController>();
  const indexes = new Map<string, { sig: string; index: BlobIndex }>();
  /** Projects opened this session: Free space keeps their blobs. */
  const seen = new Set<string>();
  const policiesFile = join(deps.userData, 'blobs', 'policies.json');

  const emit = (e: IpcEvent<'blobs:progress'>) => {
    const parsed = ipcEvents['blobs:progress'].safeParse(e);
    if (parsed.success) deps.emit?.(parsed.data);
  };

  function throttled(base: Omit<IpcEvent<'blobs:progress'>, 'done' | 'total' | 'state'>) {
    let last = 0;
    return (done: number, total: number, state: IpcEvent<'blobs:progress'>['state']) => {
      const now = Date.now();
      if (state === 'running' && now - last < EVENT_MS) return;
      last = now;
      emit({ ...base, done, total, state });
    };
  }

  // ---------------------------------------------------------------- per-project local files

  const cacheDir = (root: string) => join(deps.userData, 'journal-cache', projectCacheKey(root));

  async function readLocal(root: string): Promise<LocalCache> {
    try {
      const raw = (await readJson(join(cacheDir(root), 'blobs.json'))) as
        { schema?: string; hashes?: unknown; registered?: unknown } | undefined;
      if (raw?.schema === CACHE_SCHEMA) {
        const registered = Array.isArray(raw.registered) ? (raw.registered as BlobRef[]) : [];
        return { hashes: HashCache.from(raw.hashes), registered };
      }
    } catch {
      // a damaged cache is rebuilt
    }
    return { hashes: new HashCache(), registered: [] };
  }

  async function writeLocal(root: string, local: LocalCache): Promise<void> {
    await mkdir(cacheDir(root), { recursive: true });
    await writeJsonAtomic(join(cacheDir(root), 'blobs.json'), {
      schema: CACHE_SCHEMA,
      root,
      hashes: local.hashes.toJSON(),
      registered: local.registered,
    });
  }

  async function readPolicies(): Promise<Record<string, Record<string, FetchPolicy>>> {
    try {
      const raw = await readJson(policiesFile);
      return raw && typeof raw === 'object'
        ? (raw as Record<string, Record<string, FetchPolicy>>)
        : {};
    } catch {
      return {};
    }
  }

  async function teamConfig(root: string): Promise<ProjectTeamConfig | undefined> {
    if (deps.teamConfig) return deps.teamConfig(root);
    try {
      const parsed = TeamConfigFile.safeParse(
        await readJson(join(deps.userData, 'team', 'projects.json')),
      );
      if (!parsed.success) return undefined;
      const key = projectCacheKey(root);
      return parsed.data.projects.find((p) => projectCacheKey(p.root) === key);
    } catch {
      return undefined;
    }
  }

  /** The hub folder's blob directory for a project in hub mode. */
  function hubBlobDir(cfg: ProjectTeamConfig | undefined): string | null {
    if (!cfg?.hubPath || !cfg.teamProjectId) return null;
    return join(cfg.hubPath, HUB_PATHS.blobs(cfg.teamProjectId));
  }

  async function sourcesFor(projectId: string, root: string, cfg?: ProjectTeamConfig) {
    const out: BlobSource[] = [];
    const hub = hubBlobDir(cfg ?? (await teamConfig(root)));
    if (hub) out.push(folderBlobSource(hub, 'shared folder'));
    if (deps.sources) out.push(...(await deps.sources(projectId, root)));
    return out;
  }

  async function choices(root: string, cfg?: ProjectTeamConfig) {
    const mine = (await readPolicies())[projectCacheKey(root)] ?? {};
    return { ...(cfg?.fetch ?? {}), ...mine };
  }

  // -------------------------------------------------------------------------- the index

  /** Journal segment files, for a cheap "changed since" signature. */
  async function segments(root: string): Promise<{ file: string; sig: string }[]> {
    const opsDir = join(root, 'journal', 'ops');
    const out: { file: string; sig: string }[] = [];
    for (const chain of await readdir(opsDir).catch(() => [] as string[])) {
      for (const name of await readdir(join(opsDir, chain)).catch(() => [] as string[])) {
        if (!name.endsWith('.jsonl')) continue;
        const file = join(opsDir, chain, name);
        const s = await stat(file).catch(() => null);
        if (s?.isFile()) out.push({ file, sig: `${chain}/${name}:${s.size}:${s.mtimeMs}` });
      }
    }
    return out;
  }

  async function loadIndex(projectId: string, root: string): Promise<BlobIndex> {
    seen.add(projectId);
    const segs = await segments(root);
    const local = await readLocal(root);
    const sig = createHash('sha256')
      .update(segs.map((s) => s.sig).join('|'))
      .update(JSON.stringify(local.registered))
      .digest('hex');
    const memo = indexes.get(projectId);
    if (memo?.sig === sig) return memo.index;
    const ops: Record<string, unknown>[] = [];
    for (const s of segs) {
      const text = await readFile(s.file, 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        // only blob.add lines are parsed; the rest of the journal is T1's
        if (!line.includes('"blob.add"')) continue;
        try {
          const raw = JSON.parse(line) as unknown;
          if (raw && typeof raw === 'object') ops.push(raw as Record<string, unknown>);
        } catch {
          // a damaged line: Verify reports it
        }
      }
    }
    const index = projectBlobIndex(ops, local.registered);
    indexes.set(projectId, { sig, index });
    return index;
  }

  /** A layer file inside the project folder, or null when its path would leave it. */
  function localPath(root: string, rel: string): string | null {
    const p = normalisePath(rel);
    if (p === '' || isAbsolute(p) || /^[a-z]:/i.test(p) || p.split('/').includes('..')) return null;
    return join(root, ...p.split('/'));
  }

  async function project(projectId: string) {
    const root = deps.projectRoot(projectId);
    if (root === undefined) return null;
    const manifest = await readManifest(root);
    if (!manifest.ok) return null;
    return { root, manifest: manifest.value };
  }

  interface FileState {
    file: LayerFile;
    ref: BlobRef | undefined;
    state: BlobState;
    size: number;
    have: number;
  }

  async function fileStates(
    root: string,
    manifest: ProjectManifest,
    index: BlobIndex,
    local: LocalCache,
    cfg: ProjectTeamConfig | undefined,
    chosen: Record<string, FetchPolicy>,
  ): Promise<FileState[]> {
    const hub = hubBlobDir(cfg);
    const hubSource = hub ? folderBlobSource(hub) : null;
    const out: FileState[] = [];
    const sizes = new Map<string, number>();
    const files = layerFiles(manifest);
    const known = (f: LayerFile) =>
      index.byPath.get(f.path) ?? (f.sha256 ? index.bySha.get(f.sha256) : undefined);
    for (const f of files) sizes.set(f.layer, (sizes.get(f.layer) ?? 0) + (known(f)?.size ?? 0));
    for (const file of files) {
      const ref = known(file);
      const abs = localPath(root, file.path);
      const stamp = abs ? await stampOf(abs) : null;
      if (stamp) {
        const cached = local.hashes.get(file.path, stamp);
        const changed =
          ref !== undefined &&
          (ref.size !== stamp.size || (cached !== undefined && cached !== ref.sha256));
        out.push({
          file,
          ref,
          state: changed ? 'stale' : 'present',
          size: stamp.size,
          have: stamp.size,
        });
        continue;
      }
      if (!ref) {
        out.push({ file, ref, state: 'missing', size: 0, have: 0 });
        continue;
      }
      const check = await store.check(ref.sha256, ref.size);
      if (check === 'ok') {
        out.push({ file, ref, state: 'present', size: ref.size, have: ref.size });
        continue;
      }
      if (check === 'damaged') {
        out.push({ file, ref, state: 'stale', size: ref.size, have: 0 });
        continue;
      }
      const partial = await store.partialBytes(ref.sha256);
      const layerKind = manifest.layers.find((l) => l.id === file.layer);
      const policy = layerKind
        ? policyFor(layerKind, sizes.get(file.layer) ?? 0, chosen)
        : 'on-demand';
      const streams =
        policy === 'stream' && hubSource && (await hubSource.hasBlobs([ref.sha256])).size > 0;
      out.push({
        file,
        ref,
        state: partial > 0 ? 'partial' : streams ? 'streaming' : 'missing',
        size: ref.size,
        have: partial,
      });
    }
    return out;
  }

  async function snapshot(projectId: string) {
    const p = await project(projectId);
    if (!p) return null;
    const cfg = await teamConfig(p.root);
    const [index, local, chosen] = await Promise.all([
      loadIndex(projectId, p.root),
      readLocal(p.root),
      choices(p.root, cfg),
    ]);
    const files = await fileStates(p.root, p.manifest, index, local, cfg, chosen);
    const layers: LayerBlobStatus[] = [];
    for (const layer of p.manifest.layers) {
      const mine = files.filter((f) => f.file.layer === layer.id);
      if (mine.length === 0) continue;
      const bytes = mine.reduce((n, f) => n + f.size, 0);
      layers.push({
        layer: layer.id,
        state: aggregateState(mine.map((f) => f.state)),
        policy: policyFor(layer, bytes, chosen),
        files: mine.length,
        bytes,
        have: mine.reduce((n, f) => n + f.have, 0),
      });
    }
    return { ...p, cfg, index, files, layers };
  }

  /** Blobs to bring in for a layer: registered files that are not here or not intact. */
  function wantsOf(files: FileState[], layer?: string, sha256?: string): BlobWant[] {
    const out: BlobWant[] = [];
    for (const f of files) {
      if (!f.ref) continue;
      if (layer !== undefined && f.file.layer !== layer) continue;
      if (sha256 !== undefined && f.ref.sha256 !== sha256) continue;
      if (f.state === 'present') continue;
      // a project file that differs from its registration is the person's: never overwritten
      if (f.state === 'stale' && f.have > 0) continue;
      out.push({ sha256: f.ref.sha256, size: f.ref.size });
    }
    return out;
  }

  async function runFetch(
    jobId: string,
    projectId: string,
    layer: string | undefined,
    wants: BlobWant[],
    sources: BlobSource[],
  ): Promise<FetchJobResult> {
    const tick = throttled({ jobId, projectId, ...(layer ? { layer } : {}) });
    const total = wants.reduce((n, w) => n + w.size, 0);
    tick(0, total, 'running');
    const result = await queue.run(jobId, wants, sources, (p) => {
      tick(p.done, p.total, 'running');
    });
    indexes.delete(projectId);
    tick(result.state === 'done' ? total : 0, total, result.state);
    return result;
  }

  /** Start the copies a policy makes without a click (`always`, `on-open`), in the background. */
  async function autoFetch(projectId: string): Promise<void> {
    const snap = await snapshot(projectId);
    if (!snap) return;
    const sources = await sourcesFor(projectId, snap.root, snap.cfg);
    if (sources.length === 0) return;
    for (const l of snap.layers) {
      if (l.state === 'present' || !fetchesWithoutClick(l.policy, 'open')) continue;
      const wants = wantsOf(snap.files, l.layer);
      if (wants.length === 0) continue;
      const jobId = `auto-${createHash('sha256').update(`${projectId}\n${l.layer}`).digest('hex').slice(0, 24)}`;
      if (queue.running().includes(jobId)) continue;
      void runFetch(jobId, projectId, l.layer, wants, sources);
    }
  }

  async function cacheUse(): Promise<CacheUse> {
    return { bytes: await store.usage(), capBytes: Math.max(0, Math.floor(deps.capBytes())) };
  }

  return {
    store,

    async status(projectId) {
      const snap = await snapshot(projectId);
      if (!snap) {
        return deps.projectRoot(projectId) === undefined
          ? { layers: [], cache: await cacheUse() }
          : null;
      }
      void autoFetch(projectId).catch(() => undefined);
      return { layers: snap.layers, cache: await cacheUse() };
    },

    async fetch({ jobId, projectId, layer, sha256 }) {
      const snap = await snapshot(projectId);
      if (!snap) return { ok: false, error: 'Open the project on this computer first.' };
      if (layer !== undefined && !snap.layers.some((l) => l.layer === layer))
        return { ok: false, error: 'This layer has no files to download.' };
      const wants = wantsOf(snap.files, layer, sha256);
      if (wants.length === 0) return { ok: true };
      const sources = await sourcesFor(projectId, snap.root, snap.cfg);
      if (sources.length === 0)
        return {
          ok: false,
          error: 'This project has no shared folder or server to download from.',
        };
      const cache = await cacheUse();
      const need = wants.reduce((n, w) => n + w.size, 0);
      if (cache.bytes + need > cache.capBytes)
        return {
          ok: false,
          error: 'There is not enough room in the download cache. Free space or raise the limit.',
        };
      const result = await runFetch(jobId, projectId, layer, wants, sources);
      if (result.state === 'done') return { ok: true };
      return {
        ok: false,
        error: result.state === 'cancelled' ? 'Download cancelled.' : (result.error ?? 'Failed.'),
      };
    },

    cancel(jobId) {
      const ac = indexJobs.get(jobId);
      if (ac) {
        ac.abort();
        return true;
      }
      return queue.cancel(jobId);
    },

    async setPolicy(projectId, layer, policy) {
      const root = deps.projectRoot(projectId);
      if (root === undefined) return false;
      await mkdir(join(deps.userData, 'blobs'), { recursive: true });
      const all = await readPolicies();
      const key = projectCacheKey(root);
      all[key] = { ...(all[key] ?? {}), [layer]: policy };
      await writeJsonAtomic(policiesFile, all);
      void autoFetch(projectId).catch(() => undefined);
      return true;
    },

    async index(jobId, projectId) {
      const p = await project(projectId);
      if (!p) return { ok: false, error: 'Open the project on this computer first.' };
      if (indexJobs.has(jobId)) return { ok: false, error: 'This job is already running.' };
      const ac = new AbortController();
      indexJobs.set(jobId, ac);
      const tick = throttled({ jobId, projectId });
      try {
        const local = await readLocal(p.root);
        const files: { file: LayerFile; abs: string; size: number }[] = [];
        for (const file of layerFiles(p.manifest)) {
          const abs = localPath(p.root, file.path);
          const stamp = abs ? await stampOf(abs) : null;
          if (abs && stamp) files.push({ file, abs, size: stamp.size });
        }
        const total = files.reduce((n, f) => n + f.size, 0);
        let before = 0;
        let lastSave = Date.now();
        const refs: BlobRef[] = [];
        tick(0, total, 'running');
        for (const f of files) {
          const hashed = await cachedHash(local.hashes, f.file.path, f.abs, {
            signal: ac.signal,
            maxBytesPerSecond: deps.indexBytesPerSecond ?? 100 * 1024 * 1024,
            onProgress: (d) => {
              tick(before + d, total, 'running');
            },
          });
          refs.push(blobRefFor(f.file, hashed));
          before += f.size;
          tick(before, total, 'running');
          // resumable: what is hashed survives a cancel or a crash
          if (!hashed.cached && Date.now() - lastSave > 2000) {
            await writeLocal(p.root, local);
            lastSave = Date.now();
          }
        }
        local.hashes.retain(new Set(files.map((f) => f.file.path)));
        const index = await loadIndex(projectId, p.root);
        const fresh = newRegistrations(index, refs);
        if (fresh.length) {
          await deps.register?.(projectId, p.root, fresh);
          const byPath = new Map(local.registered.map((r) => [r.path, r]));
          for (const r of fresh) byPath.set(r.path, r);
          local.registered = [...byPath.values()];
        }
        await writeLocal(p.root, local);
        indexes.delete(projectId);
        tick(total, total, 'done');
        return { ok: true };
      } catch (e) {
        const cancelled = ac.signal.aborted;
        tick(0, 0, cancelled ? 'cancelled' : 'failed');
        return {
          ok: false,
          error: cancelled ? 'Indexing cancelled.' : e instanceof Error ? e.message : String(e),
        };
      } finally {
        indexJobs.delete(jobId);
      }
    },

    async lookup(projectId, rel) {
      const root = deps.projectRoot(projectId);
      if (root === undefined) return null;
      const path = normalisePath(rel);
      const index = await loadIndex(projectId, root);
      const hashed = hashFromAssetPath(path);
      const ref = index.byPath.get(path) ?? (hashed ? index.bySha.get(hashed) : undefined);
      const sha256 = ref?.sha256 ?? hashed;
      if (!sha256) return null;
      const size = ref?.size ?? 0;
      if (ref && (await store.check(sha256, size)) === 'ok') {
        void store.touch(sha256).catch(() => undefined);
        return { kind: 'file', path: store.path(sha256), streaming: false };
      }
      const cfg = await teamConfig(root);
      const hub = hubBlobDir(cfg);
      if (hub && ref) {
        let layer = ref.layer;
        if (layer === undefined) {
          const m = await readManifest(root);
          layer = m.ok ? layerFiles(m.value).find((f) => f.path === path)?.layer : undefined;
        }
        // streaming is only ever the person's choice (no default streams)
        if (layer !== undefined && (await choices(root, cfg))[layer] === 'stream') {
          const file = folderBlobFile(hub, sha256);
          const s = await stat(file).catch(() => null);
          if (s?.isFile() && s.size === ref.size)
            return { kind: 'file', path: file, streaming: true };
        }
      }
      return { kind: 'missing', sha256, size };
    },

    invalidate(projectId) {
      indexes.delete(projectId);
    },

    async ingest(jobId, projectId, source) {
      const snap = await snapshot(projectId);
      if (!snap) return { ok: false, error: 'Open the project on this computer first.' };
      const wants = wantsOf(snap.files);
      const held = await source.hasBlobs(wants.map((w) => w.sha256));
      const mine = wants.filter((w) => held.has(w.sha256));
      const result = await runFetch(jobId, projectId, undefined, mine, [source]);
      return result.state === 'done'
        ? { ok: true, fetched: result.fetched }
        : { ok: false, error: result.error ?? 'Cancelled.' };
    },

    async freeSpace(targetBytes) {
      const keep = new Set<string>();
      const sources: BlobSource[] = [];
      for (const projectId of seen) {
        const root = deps.projectRoot(projectId);
        if (root === undefined) continue;
        for (const sha of (await loadIndex(projectId, root)).bySha.keys()) keep.add(sha);
        sources.push(...(await sourcesFor(projectId, root)));
      }
      const result = await store.freeSpace({
        keep,
        ...(targetBytes !== undefined ? { targetBytes } : {}),
        async elsewhere(shas) {
          const held = new Set<string>();
          for (const s of sources) for (const h of await s.hasBlobs(shas)) held.add(h);
          return held;
        },
      });
      return { removed: result.removed.length, freed: result.freed };
    },
  };
}

/** The blob section of an exchange bundle (`blobs/<aa>/<sha256>` members), read in place. */
export function archiveBlobSource(archive: ZipArchive, label = 'exchange file'): BlobSource {
  return {
    label,
    hasBlobs: (shas) =>
      Promise.resolve(new Set(shas.filter((s) => archive.entries.has(blobPath(s))))),
    async getBlob(sha, range) {
      const name = blobPath(sha);
      const entry = archive.entries.get(name);
      if (!entry) return null;
      const start = range?.start ?? 0;
      const end = (range?.end ?? entry.size) - 1;
      if (end < start) return Readable.from([]);
      return archive.stream(name, start, end);
    },
  };
}

export interface BlobsIpcDeps {
  handle: Handle;
  /** The service shared with the `aio://` handler; absent in the T0 stub tests. */
  service?: BlobService;
}

export function registerBlobsIpc({ handle, service }: BlobsIpcDeps): void {
  const none = { ok: false as const, error: 'Files on demand are not available in this build.' };
  handle('blobs:status', async ({ projectId }) => {
    if (!service) return none;
    const s = await service.status(projectId);
    return s
      ? { ok: true, ...s }
      : { ok: false, error: 'Open the project on this computer first.' };
  });
  handle('blobs:fetch', (req) =>
    service
      ? service.fetch({
          jobId: req.jobId,
          projectId: req.projectId,
          ...(req.layer !== undefined ? { layer: req.layer } : {}),
          ...(req.sha256 !== undefined ? { sha256: req.sha256 } : {}),
        })
      : none,
  );
  handle('blobs:cancel', ({ jobId }) => ({ ok: service?.cancel(jobId) ?? false }));
  handle('blobs:policy', async ({ projectId, layer, policy }) => {
    if (!service) return none;
    return (await service.setPolicy(projectId, layer, policy))
      ? { ok: true }
      : { ok: false, error: 'Open the project on this computer first.' };
  });
  handle('blobs:index', ({ jobId, projectId }) =>
    service ? service.index(jobId, projectId) : none,
  );
}
