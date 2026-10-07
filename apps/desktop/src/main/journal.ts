/**
 * The journal service (M9 stream T1, data-conventions section 17, ADR 0005).
 *
 * Every project write appends signed, hash-chained ops to this device's chain in
 * `<project>/journal/ops/<deviceId>.<replicaId>/` (fsync) before the state file is written
 * atomically; the JSON files stay the current state. Main diffs each write against the last known
 * content (a snapshot in `userData/journal-cache/<key>/`, rebuildable, never the truth):
 *
 * - writers (`project:writeIssues`, `change:write`, `detections:write`, `model:write`,
 *   `project:writeBoundaries`, `report:writeNarrative`) are wrapped: ops first, then the write;
 *   a write the handler refuses is undone by ops, never by editing the journal;
 * - `builder:updateLayers` is diffed after it writes (its result is computed in the handler);
 * - on open, a half-done write is finished (crash recovery) and any other difference is recorded
 *   as attributed ops (`via.external`, "changed outside Quadrion AI");
 * - around pipeline jobs, the difference is recorded with `via.pipeline`.
 *
 * Packages are read-only: their journal is never appended. Decision 8: the journal is on by
 * default; a private project may switch it off (the switch is recorded), a team project may not.
 *
 * M9 integration: this service is the only writer of `journal/`. Identity (T2), the review
 * workflow (T3), the merge inbox (T4), sync and exchange (T5) and binaries (T6) append through
 * `append`; ops from other copies arrive through `ingest`; merged state files are written with
 * `writeMerged`; `locked` runs a sequence of them as one step per project.
 */
import { createHash } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  auditEntries,
  createChainWriter,
  diffRecordFile,
  isJournaledFile,
  JOURNALED_DIRS,
  loadJournal,
  pageEntries,
  randomId,
  rolesFrom,
  opsOf,
  sealCheckpoint,
  sealDeviceRecord,
  stripPayload,
  tailOf,
  verifyJournalParallel,
  type ChainWriter,
  type DraftOp,
  type JournalFiles,
  type Signer,
} from '@aio/journal';
import {
  checkpointFileName,
  ipc,
  JOURNAL_CHECKPOINTS_DIR,
  JOURNAL_DEVICES_DIR,
  JOURNAL_DIR,
  JOURNAL_OPS_DIR,
  segmentFileName,
  type AuditEntry,
  type AuditFilter,
  type EditCommand,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type JobEvent,
  type JobRecord,
  type Op,
  type RecordRef,
  type VerifyReport,
  type Via,
} from '@aio/schema';
import { z } from 'zod';
import type { Handler } from './ipc';
import type { AuditSummary } from '@aio/project/export';
import { projectCacheKey } from '@aio/sync/blobs';
import { writeJsonAtomic } from './fsutil';
import { assertWritable } from './realDataGuard';
import { type Handle } from './notYet';
import { ISSUES_SCHEMA } from './project';
import { createJournalStore, type JournalStore } from './sync/journalStore';

/** Who signs the journal on this machine: T2's identity service (`identityPorts.ts`). */
export interface JournalIdentity {
  actor: string;
  name: string;
  initials: string;
  /** This device: its id and raw public key (base64url). */
  device: { id: string; publicKey: string };
  /** Null when the vault is not available: ops are written unsigned. */
  signer: Signer | null;
  app: { name: string; version: string };
}

/** A merged state file (project-relative path, `writeJsonAtomic` text). */
export interface MergedText {
  path: string;
  text: string;
}

/** One step of several journal actions on a project, run after every earlier step. */
export interface JournalTx {
  root: string;
  /** This copy's chain (`<device>.<replica>`), made on first need. */
  chain(): Promise<string>;
  append(drafts: readonly DraftOp[], via?: Via): Promise<Op[]>;
  /** Ops of other copies, appended to their own chains (planned by the caller: no gaps). */
  ingest(ops: readonly Op[]): Promise<number>;
  /** Write merged state files: atomic with `.bak`, taken as the new known state (no ops). */
  writeMerged(files: readonly MergedText[]): Promise<void>;
  read(rel: string): Promise<string | null>;
}

/** The registry slice the journal needs: project ids to folders, packages refused. */
export interface JournalProjects {
  root(id: string): string | undefined;
  package(id: string): unknown;
}

export interface JournalServiceDeps {
  userData: string;
  projects: JournalProjects;
  identity: () => Promise<JournalIdentity>;
  /** The replica id of a folder (`team/projects.json`, T5); absent: kept in the cache meta. */
  replicaOf?: (root: string) => Promise<string>;
  /** The journal reader shared with sync (one cache of segments). */
  store?: JournalStore;
  /** `journal:changed` to the renderer. */
  emitChanged?: (e: { projectId: string; records: RecordRef[] }) => void;
  now?: () => number;
  /** Test hook: runs after the ops are appended and before the state write (crash tests). */
  afterAppend?: (rel: string) => Promise<void> | void;
  /**
   * The op ids T4's merge engine holds in quarantine in a shared folder, so History and the Audit
   * trail show them as quarantined. Set later with `setQuarantined` when the engine is made after
   * the journal.
   */
  quarantined?: (root: string) => Promise<ReadonlySet<string>>;
}

/** Writers whose result is known from the request: ops first, then the write. */
const WRITERS: Partial<
  Record<
    IpcChannel,
    (req: never) => { projectId: string; rel: string; after: unknown; commands?: EditCommand[] }
  >
> = {
  'project:writeIssues': (r: IpcRequest<'project:writeIssues'>) => ({
    projectId: r.projectId,
    rel: 'issues.json',
    after: { schema: ISSUES_SCHEMA, issues: r.issues },
    ...(r.commands ? { commands: r.commands } : {}),
  }),
  'change:write': (r: IpcRequest<'change:write'>) => ({
    projectId: r.projectId,
    rel: `change/${r.set.id}.json`,
    after: r.set,
  }),
  'detections:write': (r: IpcRequest<'detections:write'>) => ({
    projectId: r.projectId,
    rel: `detections/${r.name}`,
    after: r.file,
  }),
  'model:write': (r: IpcRequest<'model:write'>) => ({
    projectId: r.projectId,
    rel: `models/${r.model.id}.procmodel.json`,
    after: r.model,
  }),
  'project:writeBoundaries': (r: IpcRequest<'project:writeBoundaries'>) => ({
    projectId: r.projectId,
    rel: 'edits/boundaries.json',
    after: r.file,
  }),
  'report:writeNarrative': (r: IpcRequest<'report:writeNarrative'>) => ({
    projectId: r.projectId,
    rel: 'report/narrative.json',
    after: r.file,
  }),
  // hand-set camera directions: one record.external op per save until a kind is agreed
  'orientation:write': (r: IpcRequest<'orientation:write'>) => ({
    projectId: r.projectId,
    rel: 'orientation.json',
    after: r.file,
  }),
};

/**
 * Channels that only read a project. Every other channel naming a `projectId` waits for the
 * folder's open check (recovery, outside edits) before its handler runs, so nothing it writes is
 * taken into the first baseline or recorded as changed outside the app.
 */
const READS: ReadonlySet<IpcChannel> = new Set<IpcChannel>([
  'project:readVolumes',
  'detections:read',
  'detections:maskAssistStatus',
  'report:list',
  'report:readNarrative',
  'orientation:read',
  'change:list',
  'change:read',
  'model:list',
  'model:read',
  'ai:project',
  'ai:status',
  'members:list',
  'collab:read',
  'team:status',
  'sync:conflicts',
  'sync:quarantine',
  'blobs:status',
  'thumbs:put',
]);

/** Does a request schema of the contract have a `projectId` (an object, or any union member)? */
function namesProject(schema: unknown): boolean {
  const s = schema as { shape?: Record<string, unknown>; options?: unknown[] } | undefined;
  if (s?.shape && 'projectId' in s.shape) return true;
  return Array.isArray(s?.options) && s.options.some(namesProject);
}

const Meta = z.object({
  schema: z.literal('aio.journal-cache/1'),
  root: z.string(),
  replicaId: z.string().regex(/^r_[a-z2-7]{16}$/),
  journal: z.enum(['on', 'off']).default('on'),
  /** SHA-256 of the text of each journaled file as last seen. */
  files: z.record(z.string(), z.string()).default({}),
});
type Meta = z.infer<typeof Meta>;

const Pending = z.object({
  rel: z.string(),
  /** Text hash of the file before the write (null: no file). */
  before: z.string().nullable(),
  after: z.unknown(),
  ops: z.array(z.string()),
});

interface ProjectState {
  root: string;
  dir: string;
  meta: Meta;
  writer: ChainWriter | null;
  /** Heads of the other chains, as last read. */
  others: Record<string, string>;
  /** Heads last written into an op's `deps`. */
  depsSent: string;
  entries: { stamp: string; list: AuditEntry[] } | null;
  /** The open segment of this device's chain (kept open: an append is one write and a sync). */
  handle: { file: string; fh: FileHandle } | null;
}

const textHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** The folder's key in `journal-cache/` (shared with sync and binaries: one folder per project). */
const keyOf = (root: string) => projectCacheKey(resolve(root));
const parse = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    return text;
  }
};

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  assertWritable(file, 'journal write');
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

/**
 * Append lines to this device's segment and fsync before returning. The segment stays open
 * between appends (opening it each time costs more than the 5 ms budget, T8 finding 4); a new
 * segment, a redaction or closing the project closes it.
 */
async function appendDurable(st: ProjectState, file: string, text: string): Promise<void> {
  assertWritable(file, 'journal append', { inPlace: true });
  if (st.handle?.file !== file) {
    await closeHandle(st);
    await mkdir(dirname(file), { recursive: true });
    st.handle = { file, fh: await open(file, 'a') };
  }
  try {
    await st.handle.fh.write(text, null, 'utf8');
    await st.handle.fh.sync();
  } catch (e) {
    await closeHandle(st);
    throw e;
  }
}

async function closeHandle(st: ProjectState): Promise<void> {
  const h = st.handle;
  st.handle = null;
  await h?.fh.close().catch(() => undefined);
}

/** Every journaled record file of a project folder (project-relative, forward slashes). */
export async function journaledFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const top of ['issues.json', 'manifest.json']) {
    if ((await readText(join(root, top))) !== null) out.push(top);
  }
  for (const dir of JOURNALED_DIRS) {
    let names: string[];
    try {
      names = await readdir(join(root, dir));
    } catch {
      continue;
    }
    for (const n of names) {
      const rel = `${dir}/${n}`;
      if (isJournaledFile(rel)) out.push(rel);
    }
  }
  return out.sort();
}

/** Every file of `<root>/journal/` as text, keyed by project-relative path. */
export async function readJournalFiles(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string) => {
    let names: { name: string; isDirectory(): boolean }[];
    try {
      names = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      const child = `${rel}/${d.name}`;
      if (d.isDirectory()) await walk(child);
      else if (/\.(jsonl|json)$/.test(d.name)) {
        const t = await readText(join(root, child));
        if (t !== null) out.set(child, t);
      }
    }
  };
  await walk(JOURNAL_DIR);
  return out;
}

const targetsOf = (ops: readonly DraftOp[]) => {
  const seen = new Map<string, RecordRef>();
  for (const o of ops) seen.set(`${o.target.rec}/${o.target.id}/${o.target.in ?? ''}`, o.target);
  return [...seen.values()];
};

export type JournalService = ReturnType<typeof createJournalService>;

export function createJournalService(deps: JournalServiceDeps) {
  const store = deps.store ?? createJournalStore();
  const states = new Map<string, Promise<ProjectState>>();
  /** Per folder: the last journal step queued (`serial`). */
  const queues = new Map<string, Promise<unknown>>();
  /** Per folder: its open check while it runs (`opened`). */
  const openChecks = new Map<string, Promise<void>>();
  const projectIds = new Map<string, string>();
  const jobs = new Map<string, { root: string; pipeline: string }>();
  const cacheRoot = join(deps.userData, 'journal-cache');

  /** The journal state of a folder, read once. */
  function load(root: string): Promise<ProjectState> {
    const key = keyOf(root);
    let st = states.get(key);
    if (!st) {
      st = (async () => {
        const dir = join(cacheRoot, key);
        const raw = parse(await readText(join(dir, 'meta.json')));
        const ok = Meta.safeParse(raw);
        // a meta for another folder (copied userData) starts a new replica
        const meta: Meta =
          ok.success && resolve(ok.data.root) === resolve(root)
            ? ok.data
            : {
                schema: 'aio.journal-cache/1',
                root: resolve(root),
                replicaId: randomId('r_', 16),
                journal: 'on',
                files: {},
              };
        let fresh = !ok.success;
        // one replica id per folder, from team/projects.json (a copied folder starts a new chain)
        const replica = deps.replicaOf ? await deps.replicaOf(root) : undefined;
        if (replica !== undefined && replica !== meta.replicaId) {
          meta.replicaId = replica;
          fresh = true;
        }
        const state: ProjectState = {
          root: resolve(root),
          dir,
          meta,
          writer: null,
          others: {},
          depsSent: '',
          entries: null,
          handle: null,
        };
        if (fresh) await saveMeta(state);
        return state;
      })();
      states.set(key, st);
      // a folder that could not be read is tried again next time
      const made = st;
      made.catch(() => {
        if (states.get(key) === made) states.delete(key);
      });
    }
    return st;
  }

  async function saveMeta(st: ProjectState) {
    await writeAtomic(join(st.dir, 'meta.json'), `${JSON.stringify(st.meta, null, 2)}\n`);
  }

  /** Run `fn` after every earlier journal step of the folder `key`. */
  function serialKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
    queues.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }

  /** Run `fn` after every earlier journal step of the same project. */
  function serial<T>(st: ProjectState, fn: () => Promise<T>): Promise<T> {
    return serialKey(keyOf(st.root), fn);
  }

  async function writerFor(st: ProjectState): Promise<{ w: ChainWriter; id: JournalIdentity }> {
    const id = await deps.identity();
    if (st.writer) return { w: st.writer, id };
    const chain = `${id.device.id}.${st.meta.replicaId}`;
    const chainDir = join(st.root, JOURNAL_OPS_DIR, chain);
    let tail = null;
    try {
      const segs = (await readdir(chainDir)).filter((n) => /^\d{6}\.jsonl$/.test(n)).sort();
      const last = segs[segs.length - 1];
      if (last)
        tail = tailOf(Number(last.slice(0, 6)), (await readText(join(chainDir, last))) ?? '');
    } catch {
      // a new chain
    }
    const w = createChainWriter({
      chain,
      actor: id.actor,
      signer: id.signer,
      tail,
      ...(deps.now ? { now: deps.now } : {}),
    });
    await readOthers(st, w);
    // the public half of this device, once per project
    const devFile = join(st.root, JOURNAL_DEVICES_DIR, `${id.device.id}.json`);
    if (id.signer && (await readText(devFile)) === null) {
      const rec = sealDeviceRecord(
        {
          schema: 'aio.device/1',
          id: id.device.id,
          alg: 'ed25519',
          key: id.device.publicKey,
          actor: id.actor,
          name: id.name,
          initials: id.initials,
          app: id.app,
          createdAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
          certs: [],
        },
        id.signer,
      );
      await writeAtomic(devFile, `${JSON.stringify(rec, null, 2)}\n`);
    }
    st.writer = w;
    return { w, id };
  }

  /** Heads of the other chains in the folder (their last segments only). */
  async function readOthers(st: ProjectState, w: ChainWriter) {
    let chains: string[];
    try {
      chains = await readdir(join(st.root, JOURNAL_OPS_DIR));
    } catch {
      return;
    }
    for (const c of chains) {
      if (c === w.chain) continue;
      try {
        const segs = (await readdir(join(st.root, JOURNAL_OPS_DIR, c)))
          .filter((n) => /^\d{6}\.jsonl$/.test(n))
          .sort();
        const last = segs[segs.length - 1];
        if (!last) continue;
        const t = tailOf(
          Number(last.slice(0, 6)),
          (await readText(join(st.root, JOURNAL_OPS_DIR, c, last))) ?? '',
        );
        if (t) {
          st.others[c] = t.id;
          w.observe(t.hlc);
        }
      } catch {
        // unreadable chains are Verify's business
      }
    }
  }

  /** Seal and append ops (fsync). Returns their ids. */
  async function append(
    st: ProjectState,
    drafts: readonly DraftOp[],
    via?: Via,
  ): Promise<string[]> {
    return (await appendOps(st, drafts, via)).map((o) => o.id);
  }

  /** Seal and append ops (fsync). Returns the ops as written. */
  async function appendOps(st: ProjectState, drafts: readonly DraftOp[], via?: Via): Promise<Op[]> {
    if (drafts.length === 0) return [];
    const { w, id } = await writerFor(st);
    const bySegment = new Map<number, string>();
    const ids: Op[] = [];
    for (const d of drafts) {
      const depsKey = JSON.stringify(st.others);
      const sendDeps = depsKey !== st.depsSent && Object.keys(st.others).length > 0;
      const r = w.next(d, {
        ...(via ? { via } : {}),
        ...(sendDeps ? { deps: { ...st.others } } : {}),
      });
      if (sendDeps) st.depsSent = depsKey;
      bySegment.set(r.segment, (bySegment.get(r.segment) ?? '') + r.line);
      ids.push(r.op);
    }
    for (const [n, text] of bySegment) {
      await appendDurable(st, join(st.root, JOURNAL_OPS_DIR, w.chain, segmentFileName(n)), text);
    }
    st.entries = null;
    if (w.checkpointDue()) await checkpoint(st, w, id);
    return ids;
  }

  async function checkpoint(st: ProjectState, w: ChainWriter, id: JournalIdentity) {
    const tail = w.tail;
    if (!tail) return;
    await readOthers(st, w);
    const heads: Record<string, { seq: number; id: string }> = { [w.chain]: tail };
    let count = tail.seq;
    for (const [c, head] of Object.entries(st.others)) {
      // the other chains' seqs: from their last segment
      const segs = (await readdir(join(st.root, JOURNAL_OPS_DIR, c)))
        .filter((n) => /^\d{6}\.jsonl$/.test(n))
        .sort();
      const last = segs[segs.length - 1];
      const t = last
        ? tailOf(
            Number(last.slice(0, 6)),
            (await readText(join(st.root, JOURNAL_OPS_DIR, c, last))) ?? '',
          )
        : null;
      if (t?.id === head) {
        heads[c] = { seq: t.seq, id: head };
        count += t.seq;
      }
    }
    const hlc = tail.hlc;
    const cp = sealCheckpoint(
      { chain: w.chain, act: id.actor, hlc, seq: tail.seq, heads, count },
      id.signer ?? undefined,
    );
    const file = checkpointFileName(hlc, w.chain);
    await writeAtomic(
      join(st.root, JOURNAL_CHECKPOINTS_DIR, file),
      `${JSON.stringify(cp, null, 2)}\n`,
    );
    const r = w.next({
      kind: 'checkpoint',
      target: { rec: 'project', id: st.meta.replicaId },
      payload: { file, root: cp.root, count: cp.count },
    });
    await appendDurable(
      st,
      join(st.root, JOURNAL_OPS_DIR, w.chain, segmentFileName(r.segment)),
      r.line,
    );
  }

  /** Remember a file's content as the last known state. */
  async function snapshot(st: ProjectState, rel: string, text: string | null) {
    const file = join(st.dir, 'snapshot', ...rel.split('/'));
    if (text === null) {
      await rm(file, { force: true });
      Reflect.deleteProperty(st.meta.files, rel);
    } else {
      await writeAtomic(file, text);
      st.meta.files[rel] = textHash(text);
    }
  }

  const snapText = (st: ProjectState, rel: string) =>
    readText(join(st.dir, 'snapshot', ...rel.split('/')));

  /** Record what changed in `rels` since the last snapshot, attributed by `via`. */
  async function reconcile(
    st: ProjectState,
    rels: readonly string[] | null,
    via: Via | undefined,
  ): Promise<RecordRef[]> {
    const disk = rels ?? [
      ...new Set([...(await journaledFiles(st.root)), ...Object.keys(st.meta.files)]),
    ];
    const touched: RecordRef[] = [];
    let changedMeta = false;
    // the first look at a folder only takes the baseline: nothing before it is known
    const baseline = rels === null && Object.keys(st.meta.files).length === 0;
    for (const rel of disk) {
      const now = await readText(join(st.root, ...rel.split('/')));
      const known = st.meta.files[rel];
      const nowHash = now === null ? undefined : textHash(now);
      if (nowHash === known) continue;
      changedMeta = true;
      const before = known === undefined ? null : await snapText(st, rel);
      if (!baseline) {
        const drafts = diffRecordFile(rel, parse(before), parse(now));
        await append(st, drafts, via);
        touched.push(...targetsOf(drafts));
      }
      await snapshot(st, rel, now);
    }
    if (changedMeta) await saveMeta(st);
    return touched;
  }

  /** Finish a write that was journaled but not written (crash between op and state write). */
  async function recover(st: ProjectState) {
    const pending = Pending.safeParse(parse(await readText(join(st.dir, 'pending.json'))));
    if (!pending.success) return;
    const p = pending.data;
    const file = join(st.root, ...p.rel.split('/'));
    const now = await readText(file);
    const nowHash = now === null ? null : textHash(now);
    const journal = await readJournalFiles(st.root);
    const appended = p.ops.every((id) => [...journal.values()].some((t) => t.includes(id)));
    if (appended && nowHash === p.before) {
      const text = `${JSON.stringify(p.after, null, 2)}\n`;
      await writeAtomic(file, text);
      await snapshot(st, p.rel, text);
      await saveMeta(st);
    }
    await rm(join(st.dir, 'pending.json'), { force: true });
  }

  function emit(root: string, records: RecordRef[]) {
    const projectId = projectIds.get(keyOf(root));
    if (projectId && records.length) deps.emitChanged?.({ projectId, records });
  }

  /**
   * A folder project opened: recover a half-done write, then record what changed outside the app.
   * It runs after the project is shown (the first look at a folder copies a baseline of every
   * record file, and the replica id is looked up in userData), as the folder's next journal step:
   * queued before the open answers, so recovery and outside edits come before any later write.
   * Never rejects: the journal never blocks opening a project.
   */
  function opened(projectId: string, root: string): Promise<void> {
    const key = keyOf(root);
    projectIds.set(key, projectId);
    const check = serialKey(key, async () => {
      const st = await load(root);
      if (st.meta.journal === 'off') return [];
      await recover(st);
      return reconcile(st, null, { external: { found: 'open' } });
    }).then(
      (touched) => {
        emit(root, touched);
      },
      (e: unknown) => {
        console.warn(`Journal: could not check ${root} on open (${String(e)}).`);
      },
    );
    openChecks.set(key, check);
    void check.then(() => {
      if (openChecks.get(key) === check) openChecks.delete(key);
    });
    return check;
  }

  /** Wait for the open check of the folder a request names (`projectId`), if one is running. */
  async function afterOpenCheck(req: unknown): Promise<void> {
    const id = (req as { projectId?: unknown } | null)?.projectId;
    if (typeof id !== 'string' || openChecks.size === 0) return;
    const root = deps.projects.root(id);
    if (root !== undefined) await openChecks.get(keyOf(root));
  }

  /** Close a folder's kept segment after its pending steps (an append in flight finishes first). */
  async function release(st: Promise<ProjectState>): Promise<void> {
    try {
      const s = await st;
      await serial(s, () => closeHandle(s));
    } catch {
      // a folder that could not be read has nothing open
    }
  }

  /** A write through a channel whose result is known: ops, then the handler's write. */
  async function journaledWrite<R extends { ok: boolean; error?: string }>(
    root: string,
    rel: string,
    after: unknown,
    commands: EditCommand[] | undefined,
    write: () => Promise<R>,
  ): Promise<R> {
    const st = await load(root);
    if (st.meta.journal === 'off') return write();
    return serial(st, async () => {
      // something else changed the file since we last saw it: record that first
      const outside = await reconcile(st, [rel], { external: { found: 'open' } });
      // compare-before-write (shared folders): said only after a saved write, since a renderer that
      // reloads on it mid-write would make main take its stale save as current
      const saved = async () => {
        const r = await write();
        if (r.ok) emit(root, outside);
        return r;
      };
      const beforeText = await snapText(st, rel);
      const before = st.meta.files[rel] === undefined ? null : parse(beforeText);
      const drafts = diffRecordFile(rel, before, after, commands);
      if (drafts.length === 0) {
        const r = await saved();
        if (r.ok) await settle(st, rel);
        return r;
      }
      await writeAtomic(
        join(st.dir, 'pending.json'),
        JSON.stringify({ rel, before: st.meta.files[rel] ?? null, after, ops: [] }),
      );
      const ids = await append(st, drafts);
      await writeAtomic(
        join(st.dir, 'pending.json'),
        JSON.stringify({ rel, before: st.meta.files[rel] ?? null, after, ops: ids }),
      );
      await deps.afterAppend?.(rel);
      let r: R;
      try {
        r = await saved();
      } catch (e) {
        r = { ok: false, error: String(e) } as R;
      }
      if (!r.ok) {
        // the write was refused: undo the ops with ops (history is never rewritten)
        const undo = diffRecordFile(rel, after, before).map((d) => ({
          ...d,
          label: 'Not saved, change undone',
        }));
        await append(st, undo);
      } else {
        // what the handler wrote may differ slightly from the request (defaults): record it
        await settle(st, rel, after);
      }
      await rm(join(st.dir, 'pending.json'), { force: true });
      return r;
    });
  }

  /** After a successful write: the disk is the new snapshot; record any difference to `after`. */
  async function settle(st: ProjectState, rel: string, expected?: unknown) {
    const text = await readText(join(st.root, ...rel.split('/')));
    if (expected !== undefined && text !== null) {
      const extra = diffRecordFile(rel, expected, parse(text));
      if (extra.length) await append(st, extra);
    }
    await snapshot(st, rel, text);
    await saveMeta(st);
  }

  /** Wrap a channel's handler (main's `handle` does this for every channel). */
  function wrap<C extends IpcChannel>(channel: C, handler: Handler<C>): Handler<C> {
    const journaled = journalHandler(channel, handler);
    if (READS.has(channel) || !namesProject(ipc[channel].request)) return journaled;
    return async (req) => {
      await afterOpenCheck(req);
      return journaled(req);
    };
  }

  function journalHandler<C extends IpcChannel>(channel: C, handler: Handler<C>): Handler<C> {
    const writer = WRITERS[channel] as
      | ((req: IpcRequest<C>) => {
          projectId: string;
          rel: string;
          after: unknown;
          commands?: EditCommand[];
        })
      | undefined;
    if (writer) {
      return async (req) => {
        const w = writer(req);
        const root = deps.projects.root(w.projectId);
        if (root === undefined || deps.projects.package(w.projectId)) return handler(req);
        projectIds.set(keyOf(root), w.projectId);
        return journaledWrite(
          root,
          w.rel,
          w.after,
          w.commands,
          async () => (await handler(req)) as IpcResponse<C> & { ok: boolean; error?: string },
        );
      };
    }
    if (channel === 'builder:updateLayers') {
      return async (req) => {
        const r = await handler(req);
        const { projectId } = req as IpcRequest<'builder:updateLayers'>;
        const root = deps.projects.root(projectId);
        if ((r as { ok: boolean }).ok && root !== undefined) {
          const st = await load(root);
          if (st.meta.journal === 'on') {
            await serial(st, () => reconcile(st, ['manifest.json'], undefined));
          }
        }
        return r;
      };
    }
    if (channel === 'change:compute') {
      // change sets made by the in-app comparison: recorded as that run's work right away, so
      // the next review of an item is not taken for a change made outside the app
      return async (req) => {
        const r = await handler(req);
        const { projectId, jobId } = req as IpcRequest<'change:compute'>;
        const root = deps.projects.root(projectId);
        const done = r as IpcResponse<'change:compute'>;
        if (done.ok && root !== undefined && !deps.projects.package(projectId)) {
          try {
            const st = await load(root);
            if (st.meta.journal === 'on') {
              await serial(st, () =>
                reconcile(
                  st,
                  done.ids.map((id) => `change/${id}.json`),
                  { pipeline: { name: 'change', jobId } },
                ),
              );
            }
          } catch (e) {
            console.warn(`Journal: could not record the change sets of ${jobId} (${String(e)}).`);
          }
        }
        return r;
      };
    }
    if (channel === 'project:open') {
      return async (req) => {
        const r = (await handler(req)) as IpcResponse<'project:open'>;
        if (r.ok && !r.package) {
          // shown first: the open check runs after, and writes to the folder wait for it
          void opened(r.id, r.root);
          // one project is open at a time: the segments kept open for the others are closed
          const key = keyOf(r.root);
          for (const [k, st] of states) if (k !== key) void release(st);
        }
        return r as IpcResponse<C>;
      };
    }
    if (channel === 'jobs:start') {
      return async (req) => {
        const start = req as IpcRequest<'jobs:start'>;
        if ('project' in start) await beforeJob(start.project);
        const r = (await handler(req)) as IpcResponse<'jobs:start'>;
        if (r.ok) jobs.set(r.job.id, { root: r.job.project, pipeline: r.job.pipeline });
        return r as IpcResponse<C>;
      };
    }
    return handler;
  }

  async function beforeJob(root: string) {
    try {
      const st = await load(root);
      if (st.meta.journal === 'off') return;
      const touched = await serial(st, () => reconcile(st, null, { external: { found: 'job' } }));
      emit(root, touched);
    } catch (e) {
      console.warn(`Journal: could not check ${root} before a job (${String(e)}).`);
    }
  }

  /** A `jobs:event`: when a tracked job ends, record its changes as the pipeline's. */
  async function jobEvent(e: JobEvent): Promise<void> {
    if (e.type !== 'update') return;
    const job: JobRecord = e.job;
    if (job.status === 'starting' || job.status === 'running' || job.status === 'cancelling') {
      if (!jobs.has(job.id)) jobs.set(job.id, { root: job.project, pipeline: job.pipeline });
      return;
    }
    const tracked = jobs.get(job.id);
    if (!tracked) return;
    jobs.delete(job.id);
    try {
      const st = await load(tracked.root);
      if (st.meta.journal === 'off') return;
      const via: Via = {
        pipeline: {
          name: tracked.pipeline,
          jobId: job.id,
          ...(job.packVersion ? { packVersion: job.packVersion } : {}),
        },
      };
      const touched = await serial(st, () => reconcile(st, null, via));
      emit(tracked.root, touched);
    } catch (err) {
      console.warn(`Journal: could not record the changes of job ${job.id} (${String(err)}).`);
    }
  }

  async function filesOf(projectId: string): Promise<{ root: string; files: JournalFiles } | null> {
    const root = deps.projects.root(projectId);
    if (root === undefined) return null;
    return { root, files: await readJournalFiles(root) };
  }

  let quarantinedOf = deps.quarantined;

  async function entries(projectId: string): Promise<AuditEntry[] | null> {
    const f = await filesOf(projectId);
    if (!f) return null;
    const st = await load(f.root);
    const stamp = textHash([...f.files].map(([p, t]) => `${p}:${String(t.length)}`).join('|'));
    if (st.entries?.stamp === stamp) return st.entries.list;
    // held ops of a shared folder (a release appends an op, so the stamp changes with it)
    const held =
      quarantinedOf && (await readText(join(f.root, 'team.json'))) !== null
        ? await quarantinedOf(f.root).catch(() => undefined)
        : undefined;
    const list = auditEntries(loadJournal(f.files), held ? { quarantined: held } : {});
    st.entries = { stamp, list };
    return list;
  }

  async function history(
    req: IpcRequest<'journal:history'>,
  ): Promise<IpcResponse<'journal:history'>> {
    if (deps.projects.package(req.projectId)) {
      return { ok: true, entries: [], cursor: null };
    }
    const all = await entries(req.projectId);
    if (!all) return { ok: false, error: `Project "${req.projectId}" is not open.` };
    const root = deps.projects.root(req.projectId) ?? '';
    const st = await load(root);
    const page = pageEntries(all, req.filter, req.limit ?? 200, req.cursor);
    return { ok: true, ...page, ...(st.meta.journal === 'off' ? { off: true } : {}) };
  }

  async function verify(projectId: string): Promise<IpcResponse<'journal:verify'>> {
    const f = await filesOf(projectId);
    if (!f) {
      return deps.projects.package(projectId)
        ? { ok: false, error: 'Verify for packages comes with the package history.' }
        : { ok: false, error: `Project "${projectId}" is not open.` };
    }
    const report: VerifyReport = await verifyJournalParallel(f.files, {
      ...(deps.now ? { now: new Date(deps.now()) } : {}),
    });
    return { ok: true, report };
  }

  async function redact(req: IpcRequest<'journal:redact'>): Promise<IpcResponse<'journal:redact'>> {
    if (deps.projects.package(req.projectId)) {
      return {
        ok: false,
        error: 'This project is a read-only package. Its history cannot change.',
      };
    }
    const f = await filesOf(req.projectId);
    if (!f) return { ok: false, error: `Project "${req.projectId}" is not open.` };
    const st = await load(f.root);
    const id = await deps.identity();
    const ops = opsOf(loadJournal(f.files));
    const hit = ops.find((o) => o.raw.id === req.op);
    if (!hit) return { ok: false, error: 'There is no such entry in this history.' };
    if (!('payload' in hit.raw)) return { ok: false, error: 'This entry is already redacted.' };
    const shared = (await readText(join(f.root, 'team.json'))) !== null;
    if (shared && rolesFrom(ops).get(id.actor) !== 'owner') {
      return { ok: false, error: 'Only an owner of this team project can redact its history.' };
    }
    return serial(st, async () => {
      await append(st, [
        {
          kind: 'op.redact',
          target: { rec: 'op', id: req.op },
          payload: {
            op: req.op,
            chain: hit.raw.chain,
            seq: hit.raw.seq,
            ...(req.reason ? { reason: req.reason } : {}),
          },
        },
      ]);
      await closeHandle(st);
      const file = join(f.root, ...hit.file.split('/'));
      const text = await readText(file);
      const stripped = text === null ? null : stripPayload(text, req.op);
      if (stripped !== null) await writeAtomic(file, stripped);
      st.entries = null;
      return { ok: true };
    });
  }

  /**
   * Decision 8: switch the journal of a private project off or on. The switch is recorded:
   * `journal.off` is the last op before the pause, `journal.on` the first after it. A shared
   * project (`team.json`) keeps its journal on.
   */
  async function setJournal(
    projectId: string,
    on: boolean,
    reason?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const root = deps.projects.root(projectId);
    if (root === undefined || deps.projects.package(projectId)) {
      return { ok: false, error: 'Open the project folder first.' };
    }
    const st = await load(root);
    if (!on && (await readText(join(root, 'team.json'))) !== null) {
      return { ok: false, error: 'The history of a team project cannot be switched off.' };
    }
    if ((st.meta.journal === 'on') === on) return { ok: true };
    return serial(st, async () => {
      const draft: DraftOp = {
        kind: on ? 'journal.on' : 'journal.off',
        target: { rec: 'project', id: st.meta.replicaId },
        payload: reason ? { reason } : {},
      };
      if (on) {
        // what changed while it was off is not attributed: start again from the disk
        st.meta.journal = 'on';
        for (const rel of await journaledFiles(root)) {
          await snapshot(st, rel, await readText(join(root, ...rel.split('/'))));
        }
        await append(st, [draft]);
      } else {
        await reconcile(st, null, { external: { found: 'open' } });
        await append(st, [draft]);
        st.meta.journal = 'off';
      }
      await saveMeta(st);
      return { ok: true };
    });
  }

  /**
   * What a house report prints of the audit trail: the head, the count, whether Verify found the
   * history intact, and the latest changes of the report's issues (up to `cap` rows).
   */
  async function reportAudit(
    projectId: string,
    issueIds?: readonly string[],
    cap = 300,
  ): Promise<AuditSummary | null> {
    const root = deps.projects.root(projectId);
    if (root === undefined || deps.projects.package(projectId)) return null;
    const v = await verify(projectId);
    if (!v.ok || !v.report.head) return null;
    const all = (await entries(projectId)) ?? [];
    const codes = new Map<string, string>();
    const issues = parse(await readText(join(root, 'issues.json')));
    if (
      issues &&
      typeof issues === 'object' &&
      Array.isArray((issues as { issues?: unknown }).issues)
    ) {
      for (const i of (issues as { issues: { id?: unknown; code?: unknown }[] }).issues) {
        if (typeof i.id === 'string' && typeof i.code === 'string') codes.set(i.id, i.code);
      }
    }
    const wanted = issueIds ? new Set(issueIds) : null;
    const issueRows = all.filter(
      (e) => e.target.rec === 'issue' && (!wanted || wanted.has(e.target.id)),
    );
    const rows = issueRows.slice(0, cap).map((e) => ({
      code: codes.get(e.target.id) ?? e.target.id,
      at: `${e.at.slice(0, 10)} ${e.at.slice(11, 16)}`,
      who: e.actor.name ?? e.actor.initials ?? 'Unknown author',
      change: e.label ?? describeChange(e),
    }));
    return {
      root: v.report.head.root,
      count: v.report.head.count,
      verified: v.report.ok,
      rows,
      more: Math.max(0, issueRows.length - rows.length),
    };
  }

  /** A signed checkpoint now (exports and syncs), so what leaves the machine is anchored. */
  async function checkpointNow(projectId: string): Promise<void> {
    const root = deps.projects.root(projectId);
    if (root === undefined) return;
    const st = await load(root);
    if (st.meta.journal === 'off') return;
    await serial(st, async () => {
      const { w, id } = await writerFor(st);
      if (w.tail) await checkpoint(st, w, id);
    });
  }

  /** Ops of other copies to their own chains (never this device's chain). */
  async function ingestOps(st: ProjectState, ops: readonly Op[]): Promise<number> {
    const { w } = await writerFor(st);
    const foreign = ops.filter((o) => o.chain !== w.chain);
    if (foreign.length === 0) return 0;
    await store.append(st.root, foreign);
    // the clock moves past what arrived; the next own op names the new heads in `deps`
    for (const o of foreign) w.observe(o.hlc);
    await readOthers(st, w);
    st.entries = null;
    return foreign.length;
  }

  /** Merged state written by the merge engine: atomic with `.bak`, the new known state. */
  async function writeMergedFiles(st: ProjectState, files: readonly MergedText[]) {
    for (const f of files) {
      const file = join(st.root, ...f.path.split('/'));
      await mkdir(dirname(file), { recursive: true });
      // `writeJsonAtomic` writes `JSON.stringify(data, null, 2)` and a newline: the merge's text
      await writeJsonAtomic(file, JSON.parse(f.text) as unknown, { backup: true });
      await snapshot(st, f.path, await readText(file));
    }
    if (files.length > 0) await saveMeta(st);
  }

  function tx(st: ProjectState): JournalTx {
    return {
      root: st.root,
      // made on first need: a read-only step (conflicts, quarantine) leaves a private folder alone
      chain: async () => (await writerFor(st)).w.chain,
      append: (drafts, via) => appendOps(st, drafts, via),
      ingest: (ops) => ingestOps(st, ops),
      writeMerged: (files) => writeMergedFiles(st, files),
      read: (rel) => readText(join(st.root, ...rel.split('/'))),
    };
  }

  /**
   * Run `fn` as one step of the project's journal (after every earlier step, before any later
   * one): sync and the merge inbox ingest, project and write without a save in between.
   */
  async function locked<T>(root: string, fn: (t: JournalTx) => Promise<T>): Promise<T> {
    const st = await load(root);
    return serial(st, () => fn(tx(st)));
  }

  return {
    /** The journal reader shared with sync. */
    store,
    locked,
    /** Where History and the Audit trail learn which ops are quarantined (the merge engine). */
    setQuarantined(fn: (root: string) => Promise<ReadonlySet<string>>) {
      quarantinedOf = fn;
    },
    /** Append event ops by this person and device (team, review, sync, binaries). */
    append: (root: string, drafts: readonly DraftOp[], via?: Via) =>
      locked(root, (t) => t.append(drafts, via)),
    /** Wait for every pending journal step of a folder. */
    flush: async (root: string) => {
      const st = await load(root);
      await serial(st, () => Promise.resolve());
    },
    /**
     * Before ops leave the machine (sync, exchange): record what changed in the files since the
     * journal last saw them (`record.external`, found at sync), so nothing is sent without it.
     */
    catchUp: async (root: string) => {
      const st = await load(root);
      if (st.meta.journal === 'off') return;
      const touched = await serial(st, () => reconcile(st, null, { external: { found: 'sync' } }));
      emit(st.root, touched);
    },
    /** This copy's chain id, made on first need (the device record is published with it). */
    chainOf: (root: string) => locked(root, (t) => t.chain()),
    /** Remove the payloads of these ops from their segments (`comment.redact` already appended). */
    redactPayloads: (root: string, opIds: readonly string[]) =>
      locked(root, async () => {
        const st = await load(root);
        await closeHandle(st);
        let removed = 0;
        for (const [rel, text] of await readJournalFiles(st.root)) {
          if (!rel.endsWith('.jsonl')) continue;
          let next = text;
          for (const id of opIds) {
            if (!next.includes(id)) continue;
            const stripped = stripPayload(next, id);
            if (stripped !== null && stripped !== next) {
              next = stripped;
              removed++;
            }
          }
          if (next !== text) await writeAtomic(join(st.root, ...rel.split('/')), next);
        }
        st.entries = null;
        return removed;
      }),
    /** Close the kept segment of a folder (project closed), after its pending steps. */
    close: async (root: string) => {
      const st = states.get(keyOf(root));
      if (st) await release(st);
    },
    /** Close every kept segment (app quitting, tests), after the pending steps of each folder. */
    closeAll: async () => {
      await Promise.all([...states.values()].map(release));
    },
    wrap,
    opened,
    jobEvent,
    history,
    verify,
    redact,
    setJournal,
    checkpointNow,
    reportAudit,
    entries,
    files: filesOf,
    /** For tests: the replica and switch of a folder. */
    meta: async (root: string) => (await load(root)).meta,
  };
}

export interface JournalIpcDeps {
  handle: Handle;
  journal: JournalService;
  /** `audit:export`: CSV or signed JSON through a save dialog (`exports/audit.ts`). */
  exportAudit: (req: IpcRequest<'audit:export'>) => Promise<IpcResponse<'audit:export'>>;
}

export function registerJournalIpc({ handle, journal, exportAudit }: JournalIpcDeps): void {
  handle('journal:history', (req) => journal.history(req));
  handle('journal:verify', ({ projectId }) => journal.verify(projectId));
  handle('journal:redact', (req) => journal.redact(req));
  handle('audit:export', (req) => exportAudit(req));
}

export type { AuditFilter };

/** A short line for a change without an editor label ("severity 3 to 4"). */
function describeChange(e: AuditEntry): string {
  const show = (v: unknown) =>
    v === undefined ? 'none' : typeof v === 'string' ? v : JSON.stringify(v).slice(0, 40);
  const parts = (e.changes ?? []).map((c) => `${c.field} ${show(c.before)} to ${show(c.after)}`);
  const what = e.kind.replace(/^issue\./, '').replace(/\./g, ' ');
  return parts.length ? parts.join(', ') : what;
}
