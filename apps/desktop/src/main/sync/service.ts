import { mkdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { checkOp, randomId } from '@aio/journal';
import {
  TEAM_FILE,
  TEAM_SCHEMA,
  TeamProject,
  type AppStamp,
  type DeviceRecord,
  type ExchangePreview,
  type Heads,
  type IpcEvent,
  type IpcRequest,
  type Op,
  type TeamSettings,
  type TeamStatus,
} from '@aio/schema';
import {
  ExchangeError,
  formatBytes,
  headsOf,
  mergeHeads,
  openExchange,
  opsSince,
  planFor,
  planIngest,
  previewExchange,
  writeExchange,
  type BundleBlob,
  type LocalView,
  type OpenedExchange,
} from '@aio/sync/exchange';
import { createHubTransport, HubUnreachable, type HubFs, type HubTransport } from '@aio/sync/hub';
import { readJson, writeJsonAtomic } from '../fsutil';
import { createTeamConfigStore, type TeamConfigStore } from './config';
import { createJournalStore, type JournalStore } from './journalStore';
import type { DevicePort, JournalPort, MergePort, ProjectCtx } from './ports';

type Emitted = 'sync:progress' | 'exchange:progress' | 'journal:changed';

export interface SyncServiceDeps {
  userData: string;
  /** Folder of an open folder project; undefined for packages and unknown ids. */
  projectRoot(projectId: string): string | undefined;
  /** An open read-only package (never written). */
  isPackage(projectId: string): boolean;
  teamSettings(): Promise<TeamSettings | undefined>;
  device: DevicePort;
  journal: JournalPort;
  merge: MergePort;
  store?: JournalStore;
  emit<E extends Emitted>(event: E, payload: IpcEvent<E>): void;
  /** Ask where to save an exchange file; null when cancelled. */
  saveDialog(defaultName: string): Promise<string | null>;
  app: AppStamp;
  hubFs?: HubFs;
  hubTimeoutMs?: number;
  now?: () => Date;
}

interface Fail {
  ok: false;
  error: string;
  code?: 'not-implemented' | 'read-only';
}

/** Per copy, rebuildable sync state in `journal-cache/<replica>/sync.json`. */
interface SyncState {
  held: Op[];
  imported: string[];
  hubHeads: Heads;
  reachable?: boolean;
}

export class SyncError extends Error {
  override name = 'SyncError';
}

const offlineMessage =
  'The shared folder cannot be reached. Your work is kept on this computer and syncs when the folder is back.';

/**
 * Sharing, hub sync and exchange files for open folder projects. The service only ever touches
 * the project folder, userData and the hub folder: no network, ever (server mode is T7).
 */
export function createSyncService(d: SyncServiceDeps) {
  const store = d.store ?? createJournalStore();
  const config: TeamConfigStore = createTeamConfigStore(join(d.userData, 'team', 'projects.json'));
  const now = d.now ?? (() => new Date());
  const inflight = new Map<string, Promise<SyncResult>>();
  const active = new Set<string>();

  async function ctxFor(projectId: string): Promise<ProjectCtx> {
    if (d.isPackage(projectId)) {
      throw new SyncError('Packages are read-only. Extract the project to edit it, then share it.');
    }
    const root = d.projectRoot(projectId);
    if (!root) throw new SyncError('Open the project first.');
    const signer = await d.device.signer();
    if (!signer) {
      throw new SyncError(
        'This computer has no device key, so changes cannot be signed. Check that the system key store is available.',
      );
    }
    const cfg = await config.get(root);
    return {
      projectId,
      root,
      replicaId: cfg.replicaId,
      chain: `${signer.device}.${cfg.replicaId}`,
      device: signer.device,
      cacheDir: join(d.userData, 'journal-cache', cfg.replicaId),
    };
  }

  async function readTeam(root: string): Promise<TeamProject | null> {
    const raw = await readJson(join(root, TEAM_FILE)).catch(() => undefined);
    const p = TeamProject.safeParse(raw);
    return p.success ? p.data : null;
  }

  async function projectName(root: string): Promise<string> {
    const raw = await readJson(join(root, 'manifest.json')).catch(() => undefined);
    const name = (raw as { name?: unknown } | undefined)?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : basename(root);
  }

  const stateFile = (ctx: ProjectCtx) => join(ctx.cacheDir, 'sync.json');
  async function loadState(ctx: ProjectCtx): Promise<SyncState> {
    const raw = (await readJson(stateFile(ctx)).catch(() => undefined)) as
      Partial<SyncState> | undefined;
    return {
      held: raw?.held ?? [],
      imported: raw?.imported ?? [],
      hubHeads: raw?.hubHeads ?? {},
      ...(raw?.reachable !== undefined ? { reachable: raw.reachable } : {}),
    };
  }
  async function saveState(ctx: ProjectCtx, s: SyncState): Promise<void> {
    await mkdir(ctx.cacheDir, { recursive: true });
    await writeJsonAtomic(stateFile(ctx), s);
  }

  async function ownRecord(ctx: ProjectCtx): Promise<DeviceRecord> {
    const rec = await d.device.record();
    if (!rec) throw new SyncError('This computer has no device key, so changes cannot be signed.');
    await store.addDevices(ctx.root, [rec]);
    return rec;
  }

  /** Check each op against its device key: its own hashes and, when signed, the signature. */
  function verified(
    ops: readonly Op[],
    devices: readonly DeviceRecord[],
  ): { good: Op[]; bad: number } {
    const keys = new Map(devices.map((r) => [r.id, r.key]));
    const good: Op[] = [];
    let bad = 0;
    for (const op of ops) {
      const c = checkOp(op, keys.get(op.dev));
      if (c.id && c.payload !== false && c.signature !== false) good.push(op);
      else bad++;
    }
    return { good, bad };
  }

  /** Ingest ops from another copy: plan with the held ones, append, merge, announce. */
  async function ingest(ctx: ProjectCtx, incoming: readonly Op[]) {
    const state = await loadState(ctx);
    const heads = await store.heads(ctx.root);
    const idAt = new Map((await store.ops(ctx.root)).map((o) => [`${o.chain}#${o.seq}`, o.id]));
    const plan = planIngest({ heads, idAt: (chain, seq) => idAt.get(`${chain}#${seq}`) }, [
      ...state.held,
      ...incoming,
    ]);
    await store.append(ctx.root, plan.apply);
    await saveState(ctx, { ...state, held: plan.held });
    const merged = plan.apply.length > 0 ? await d.merge.apply(ctx, plan.apply) : null;
    if (merged && merged.records.length > 0) {
      d.emit('journal:changed', { projectId: ctx.projectId, records: merged.records });
    }
    const counts = merged ? { conflicts: merged.conflicts } : await d.merge.counts(ctx);
    return { plan, conflicts: counts.conflicts };
  }

  function hubFor(ctx: ProjectCtx, hubPath: string, team: string): HubTransport {
    return createHubTransport({
      root: hubPath,
      team,
      device: ctx.device,
      ...(d.hubFs ? { fs: d.hubFs } : {}),
      ...(d.hubTimeoutMs ? { timeoutMs: d.hubTimeoutMs } : {}),
    });
  }

  interface SyncResult {
    pulled: number;
    pushed: number;
    conflicts: number;
  }

  async function runHubSync(ctx: ProjectCtx): Promise<SyncResult> {
    const cfg = await config.get(ctx.root);
    const team = await readTeam(ctx.root);
    if (cfg.mode !== 'hub' || !cfg.hubPath || !team) {
      throw new SyncError('This project does not sync through a shared folder.');
    }
    const progress = (phase: IpcEvent<'sync:progress'>['phase'], done = 0, total = 0) => {
      d.emit('sync:progress', { projectId: ctx.projectId, phase, done, total });
    };
    progress('pull');
    await d.journal.flush(ctx);
    const hub = hubFor(ctx, cfg.hubPath, team.teamProjectId);
    const state = await loadState(ctx);
    try {
      if (!(await hub.check())) await hub.ensure(team, now());
      const mine = await ownRecord(ctx);
      await hub.putDevice(mine);
      await store.addDevices(ctx.root, await hub.devices());
      const devices = await store.devices(ctx.root);
      const pulled = await hub.pull(await store.heads(ctx.root));
      const { good } = verified(pulled.ops, devices);
      progress('merge', 0, good.length);
      const { plan, conflicts } = await ingest(ctx, good);
      progress('push');
      const local = await store.ops(ctx.root);
      const pushed = await hub.pushOps(local);
      const me = await d.device.me();
      await hub.putPresence({
        schema: 'aio.presence/1',
        device: ctx.device,
        actor: me.actor,
        name: me.name,
        initials: me.initials,
        at: now().toISOString(),
      });
      await hub.sweep().catch(() => 0);
      const after = await loadState(ctx);
      await saveState(ctx, { ...after, hubHeads: headsOf(local), reachable: true });
      await config.update(ctx.root, { lastSync: now().toISOString() });
      progress('done', plan.apply.length, plan.apply.length);
      return { pulled: plan.apply.length, pushed: pushed.accepted.length, conflicts };
    } catch (e) {
      if (e instanceof HubUnreachable) {
        await saveState(ctx, { ...state, reachable: false });
        progress('offline');
        throw new SyncError(offlineMessage);
      }
      throw e;
    }
  }

  async function status(ctx: ProjectCtx): Promise<TeamStatus> {
    const cfg = await config.get(ctx.root);
    const team = await readTeam(ctx.root);
    const state = await loadState(ctx);
    const own = (await store.ops(ctx.root)).filter((o) => o.chain === ctx.chain);
    const head = own.at(-1)?.seq ?? 0;
    const sent =
      cfg.mode === 'hub'
        ? (state.hubHeads[ctx.chain]?.seq ?? 0)
        : Math.max(0, ...Object.values(cfg.peers).map((h) => h[ctx.chain]?.seq ?? 0));
    const counts = team ? await d.merge.counts(ctx) : { conflicts: 0, quarantined: 0 };
    return {
      mode: team ? cfg.mode : 'off',
      ...(team ? { teamProjectId: team.teamProjectId, name: team.name } : {}),
      ...(cfg.lastSync ? { lastSync: cfg.lastSync } : {}),
      pending: team && cfg.mode !== 'off' ? Math.max(0, head - sent) : 0,
      conflicts: counts.conflicts,
      quarantined: counts.quarantined,
      unread: 0,
      ...(cfg.mode === 'hub' && state.reachable !== undefined
        ? { reachable: state.reachable }
        : {}),
    };
  }

  const fail = (e: unknown): Fail => {
    if (e instanceof SyncError || e instanceof ExchangeError)
      return { ok: false, error: e.message };
    return { ok: false, error: `Sync failed: ${e instanceof Error ? e.message : String(e)}` };
  };

  async function localView(ctx: ProjectCtx, opened?: OpenedExchange): Promise<LocalView> {
    const ops = await store.ops(ctx.root);
    const state = await loadState(ctx);
    const idAt = new Map(ops.map((o) => [`${o.chain}#${o.seq}`, o.id]));
    const blobPaths = blobPathsOf([...ops, ...(opened?.ops ?? [])]);
    const present = new Set<string>();
    for (const [sha, path] of blobPaths) {
      const file = safeJoin(ctx.root, path);
      if (file && (await stat(file).catch(() => null))) present.add(sha);
    }
    return {
      heads: headsOf(ops),
      idAt: (chain, seq) => idAt.get(`${chain}#${seq}`),
      held: state.held,
      ops,
      hasBlob: (sha) => present.has(sha),
      imported: new Set(state.imported),
    };
  }

  async function openFor(
    ctx: ProjectCtx,
    path: string,
    passphrase?: string,
  ): Promise<OpenedExchange> {
    const tmpDir = join(ctx.cacheDir, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const known = await store.devices(ctx.root);
    return openExchange(path, {
      tmpDir,
      ...(passphrase !== undefined ? { passphrase } : {}),
      knownDevices: (id) => known.find((r) => r.id === id),
    });
  }

  function teamCheck(local: TeamProject | null, opened: OpenedExchange): string | null {
    if (local && local.teamProjectId !== opened.header.teamProjectId) {
      return 'This exchange file is for another team project. Open the project it was exported from.';
    }
    return null;
  }

  async function joinFrom(ctx: ProjectCtx, opened: OpenedExchange): Promise<void> {
    const share = opened.ops.find((o) => o.kind === 'project.share');
    const name =
      (share?.payload as { name?: string } | undefined)?.name ?? (await projectName(ctx.root));
    const team: TeamProject = {
      schema: TEAM_SCHEMA,
      teamProjectId: opened.header.teamProjectId,
      name,
      createdAt: opened.header.createdAt,
      createdBy: opened.header.from.actor,
    };
    await writeJsonAtomic(join(ctx.root, TEAM_FILE), team);
    const cfg = await config.get(ctx.root);
    if (cfg.mode === 'off')
      await config.update(ctx.root, { mode: 'exchange', teamProjectId: team.teamProjectId });
  }

  async function syncNow(projectId: string) {
    try {
      const ctx = await ctxFor(projectId);
      let run = inflight.get(ctx.root);
      if (!run) {
        run = runHubSync(ctx).finally(() => inflight.delete(ctx.root));
        inflight.set(ctx.root, run);
      }
      return { ok: true as const, ...(await run) };
    } catch (e) {
      return fail(e);
    }
  }

  return {
    config,
    store,
    /** Projects whose status the renderer asked for (the scheduler syncs these). */
    active,

    async share(req: IpcRequest<'team:share'>) {
      if (req.mode === 'server') {
        return {
          ok: false as const,
          error: 'Team server sharing is not available yet in this build.',
          code: 'not-implemented' as const,
        };
      }
      try {
        const ctx = await ctxFor(req.projectId);
        if (req.mode === 'hub' && !req.hubPath) throw new SyncError('Choose a shared folder.');
        const me = await d.device.me();
        let team = await readTeam(ctx.root);
        await d.journal.flush(ctx);
        if (!team) {
          team = {
            schema: TEAM_SCHEMA,
            teamProjectId: randomId('t_', 26),
            name: req.name?.trim() ? req.name.trim() : await projectName(ctx.root),
            createdAt: now().toISOString(),
            createdBy: me.actor,
          };
          await writeJsonAtomic(join(ctx.root, TEAM_FILE), team);
          await d.journal.record(
            ctx,
            'project.share',
            { rec: 'project', id: team.teamProjectId },
            {
              teamProjectId: team.teamProjectId,
              name: team.name,
            },
          );
        }
        await ownRecord(ctx);
        if (req.mode === 'hub' && req.hubPath) {
          const hub = hubFor(ctx, req.hubPath, team.teamProjectId);
          try {
            await hub.check();
            await hub.ensure(team, now());
          } catch (e) {
            if (e instanceof HubUnreachable)
              throw new SyncError(`The shared folder cannot be reached: ${req.hubPath}`);
            throw e;
          }
          await config.update(ctx.root, {
            mode: 'hub',
            teamProjectId: team.teamProjectId,
            hubPath: req.hubPath,
          });
          active.add(req.projectId);
          await syncNow(req.projectId);
        } else {
          await config.update(ctx.root, {
            mode: 'exchange',
            teamProjectId: team.teamProjectId,
            hubPath: undefined,
          });
        }
        return { ok: true as const, status: await status(ctx) };
      } catch (e) {
        return fail(e);
      }
    },

    async status(projectId: string) {
      try {
        const ctx = await ctxFor(projectId);
        active.add(projectId);
        return { ok: true as const, status: await status(ctx) };
      } catch (e) {
        return fail(e);
      }
    },

    async leave(projectId: string) {
      try {
        const ctx = await ctxFor(projectId);
        await config.update(ctx.root, { mode: 'off', hubPath: undefined });
        active.delete(projectId);
        return { ok: true as const };
      } catch (e) {
        return fail(e);
      }
    },

    syncNow,

    /** Should the scheduler sync this project now (hub mode, auto-sync on, interval passed)? */
    async due(projectId: string, force = false): Promise<boolean> {
      const root = d.projectRoot(projectId);
      if (!root || d.isPackage(projectId)) return false;
      const cfg = await config.get(root);
      if (cfg.mode !== 'hub') return false;
      const prefs = await d.teamSettings();
      if (!prefs?.autoSync) return false;
      if (force) return true;
      const last = cfg.lastSync ? Date.parse(cfg.lastSync) : 0;
      return now().getTime() - last >= (prefs.intervalMin ?? 15) * 60_000;
    },

    async plan(req: IpcRequest<'exchange:plan'>) {
      try {
        const ctx = await ctxFor(req.projectId);
        await d.journal.flush(ctx);
        const { ops, blobs, heads } = await selection(ctx, req);
        return {
          ok: true as const,
          ops: ops.length,
          blobs: blobs.length,
          bytes:
            ops.reduce((n, op) => n + JSON.stringify(op).length + 1, 0) +
            blobs.reduce((n, b) => n + b.size, 0),
          heads,
        };
      } catch (e) {
        return fail(e);
      }
    },

    async exportFile(req: IpcRequest<'exchange:export'>) {
      try {
        const ctx = await ctxFor(req.projectId);
        const team = await readTeam(ctx.root);
        if (!team) throw new SyncError('Share this project first: Share, then Exchange files.');
        await d.journal.flush(ctx);
        const sel = await selection(ctx, req);
        if (sel.ops.length === 0 && sel.blobs.length === 0) {
          throw new SyncError('There are no changes to send: they already have everything.');
        }
        const day = now().toISOString().slice(0, 10);
        const name =
          `${team.name} ${req.kind === 'bundle' ? 'bundle' : 'changes'} ${day}.aiosync`.replace(
            /[\\/:*?"<>|]/g,
            '-',
          );
        const path = await d.saveDialog(name);
        if (!path) return { ok: true as const, path: null, bytes: 0 };
        const me = await d.device.me();
        const signer = await d.device.signer();
        const mine = await ownRecord(ctx);
        if (!signer)
          throw new SyncError('This computer has no device key, so changes cannot be signed.');
        const devices = (await store.devices(ctx.root)).filter(
          (r) => r.id === mine.id || sel.ops.some((o) => o.dev === r.id),
        );
        const written = await writeExchange({
          out: path,
          kind: req.kind,
          teamProjectId: team.teamProjectId,
          from: { actor: me.actor, device: ctx.device, name: me.name, app: d.app },
          signer,
          since: req.peer ? { heads: sel.since } : req.since ? { date: req.since } : { all: true },
          heads: sel.heads,
          ops: sel.ops,
          devices,
          blobs: sel.blobs,
          ...(req.passphrase !== undefined ? { passphrase: req.passphrase } : {}),
          now: now(),
          onProgress: (done, total) => {
            d.emit('exchange:progress', { jobId: req.jobId, phase: 'write', done, total });
          },
        });
        if (req.peer) {
          const cfg = await config.get(ctx.root);
          await config.update(ctx.root, {
            peers: { ...cfg.peers, [req.peer]: mergeHeads(cfg.peers[req.peer] ?? {}, sel.heads) },
          });
        }
        d.emit('exchange:progress', { jobId: req.jobId, phase: 'done', done: 1, total: 1 });
        return { ok: true as const, path, bytes: written.bytes };
      } catch (e) {
        return fail(e);
      }
    },

    async preview(req: IpcRequest<'exchange:preview'>) {
      let opened: OpenedExchange | null = null;
      try {
        const ctx = await ctxFor(req.projectId);
        opened = await openFor(ctx, req.path, req.passphrase);
        const local = await readTeam(ctx.root);
        const wrong = teamCheck(local, opened);
        if (wrong) throw new SyncError(wrong);
        const preview: ExchangePreview = previewExchange(opened, await localView(ctx, opened));
        if (!local) {
          preview.problems.push(
            `Applying it makes this project part of the team project "${teamName(opened)}".`,
          );
        }
        return { ok: true as const, preview };
      } catch (e) {
        if (
          e instanceof ExchangeError &&
          (e.code === 'needs-passphrase' || e.code === 'passphrase')
        ) {
          return { ok: false as const, error: e.message, needsPassphrase: true };
        }
        return fail(e);
      } finally {
        await opened?.close();
      }
    },

    async importFile(req: IpcRequest<'exchange:import'>) {
      let opened: OpenedExchange | null = null;
      try {
        const ctx = await ctxFor(req.projectId);
        opened = await openFor(ctx, req.path, req.passphrase);
        const local = await readTeam(ctx.root);
        const wrong = teamCheck(local, opened);
        if (wrong) throw new SyncError(wrong);
        if (opened.signature !== 'valid') {
          throw new SyncError(
            opened.signature === 'invalid'
              ? 'The exchange file was refused: its signature does not match the device that sent it.'
              : opened.signature === 'revoked-device'
                ? 'The exchange file was refused: it comes from a device that was removed from the team.'
                : 'The exchange file was refused: it does not say which device sent it, so it cannot be checked.',
          );
        }
        d.emit('exchange:progress', {
          jobId: req.jobId,
          phase: 'check',
          done: 0,
          total: opened.ops.length,
        });
        await d.journal.flush(ctx);
        if (!local) await joinFrom(ctx, opened);
        await store.addDevices(ctx.root, opened.devices);
        const view = await localView(ctx, opened);
        const plan = planFor(opened, view);
        if (plan.forks.length > 0)
          throw new SyncError(plan.forks[0]?.message ?? 'The file does not follow this copy.');
        // blobs first: a bundle's files are in place before the ops that name them apply
        const paths = blobPathsOf([...view.ops, ...opened.ops]);
        let blobs = 0;
        for (const b of opened.header.blobs) {
          const rel = paths.get(b.sha256);
          const dest = rel ? safeJoin(ctx.root, rel) : null;
          if (!dest || view.hasBlob(b.sha256)) continue;
          await mkdir(join(dest, '..'), { recursive: true });
          if (await opened.copyBlob(b.sha256, dest)) blobs++;
          d.emit('exchange:progress', {
            jobId: req.jobId,
            phase: 'files',
            done: blobs,
            total: opened.header.blobs.length,
          });
        }
        const { plan: done, conflicts } = await ingest(ctx, opened.ops);
        const fresh = new Set(opened.ops.map((o) => o.id));
        const applied = done.apply.filter((o) => fresh.has(o.id)).length;
        const state = await loadState(ctx);
        if (!state.imported.includes(opened.header.id)) {
          await saveState(ctx, { ...state, imported: [...state.imported, opened.header.id] });
          await d.journal.record(
            ctx,
            'exchange.import',
            { rec: 'file', id: opened.header.id },
            {
              exchange: opened.header.id,
              kind: opened.header.kind,
              ops: applied,
            },
          );
        }
        // what they sent is what they hold: a patch back to them starts there
        const cfg = await config.get(ctx.root);
        const from = opened.header.from.device;
        await config.update(ctx.root, {
          peers: { ...cfg.peers, [from]: mergeHeads(cfg.peers[from] ?? {}, opened.header.heads) },
        });
        d.emit('exchange:progress', {
          jobId: req.jobId,
          phase: 'done',
          done: applied,
          total: applied,
        });
        return {
          ok: true as const,
          applied,
          duplicates: done.duplicates.filter((o) => fresh.has(o.id)).length,
          held: done.held.length,
          conflicts,
        };
      } catch (e) {
        if (
          e instanceof ExchangeError &&
          (e.code === 'needs-passphrase' || e.code === 'passphrase')
        ) {
          return { ok: false as const, error: e.message };
        }
        return fail(e);
      } finally {
        await opened?.close();
      }
    },
  };

  async function selection(
    ctx: ProjectCtx,
    req: { kind: 'patch' | 'bundle'; peer?: string | undefined; since?: string | undefined },
  ) {
    const all = await store.ops(ctx.root);
    const heads = headsOf(all);
    const cfg = await config.get(ctx.root);
    const since: Heads = req.peer ? (cfg.peers[req.peer] ?? {}) : {};
    let ops = opsSince(all, since);
    if (req.since && !req.peer) {
      const ms = Date.parse(req.since);
      // a run per chain must start where the chain does: from the first op on or after the date
      const firstSeq = new Map<string, number>();
      for (const op of ops) {
        if (Number(op.hlc.slice(0, 13)) >= ms && op.seq < (firstSeq.get(op.chain) ?? Infinity))
          firstSeq.set(op.chain, op.seq);
      }
      ops = ops.filter((op) => op.seq >= (firstSeq.get(op.chain) ?? Infinity));
    }
    const blobs: BundleBlob[] = [];
    if (req.kind === 'bundle') {
      for (const [sha, path] of blobPathsOf(ops)) {
        const file = safeJoin(ctx.root, path);
        const s = file ? await stat(file).catch(() => null) : null;
        if (file && s?.isFile()) blobs.push({ sha256: sha, size: s.size, file });
      }
    }
    const total = blobs.reduce((n, b) => n + b.size, 0);
    if (total > 2 * 1024 ** 3) {
      throw new SyncError(
        `The files in this bundle add up to ${formatBytes(total)}. Exchange files are limited to 2 GB: export changes only and move large files through a shared folder or a USB copy of the project.`,
      );
    }
    return { ops, blobs, heads, since };
  }
}

export type SyncService = ReturnType<typeof createSyncService>;

function teamName(opened: OpenedExchange): string {
  const share = opened.ops.find((o) => o.kind === 'project.share');
  return (share?.payload as { name?: string } | undefined)?.name ?? opened.header.teamProjectId;
}

/** sha256 to project-relative path, from `blob.add` ops. */
function blobPathsOf(ops: readonly Op[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const op of ops) {
    if (op.kind !== 'blob.add') continue;
    const p = op.payload as { sha256?: unknown; path?: unknown } | undefined;
    if (typeof p?.sha256 === 'string' && typeof p.path === 'string') out.set(p.sha256, p.path);
  }
  return out;
}

/** A project-relative path inside the project, or null for anything that would leave it. */
export function safeJoin(root: string, rel: string): string | null {
  if (!rel || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.includes('\0')) return null;
  const full = normalize(join(root, ...rel.split('/')));
  const back = relative(root, full);
  if (!back || back.startsWith('..') || isAbsolute(back) || back.split(sep).includes('..'))
    return null;
  return full;
}
