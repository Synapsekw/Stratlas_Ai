/**
 * The real ports of sync (M9 integration): T1's journal service is the only writer of
 * `journal/`, and T4's merge engine projects every op into the state files. Ops from another copy
 * are appended to their own chains and merged as one journal step per project, so no save of
 * this copy can fall between the append and the merged write.
 */
import { createInbox, type Inbox, type OpDraft as MergeDraft, type Projection } from '@aio/merge';
import type { Conflict, IpcEvent, Op, QuarantineEntry, RecordRef } from '@aio/schema';
import type { DraftOp } from '@aio/journal';
import type { JournalService, JournalTx } from '../journal';
import type { DevicePort, JournalPort, MergePort, ProjectCtx } from './ports';

type Notice = IpcEvent<'sync:notice'>['notices'][number];

export interface TeamEngineDeps {
  journal: JournalService;
  device: DevicePort;
  /** Clock-ahead and renumbering notices for the renderer (`sync:notice`). */
  notice?: (projectId: string, notices: Notice[]) => void;
  /** Records the merge changed (`journal:changed`). */
  changed?: (projectId: string, records: RecordRef[]) => void;
  /** T3: issue statuses the approvals decide after a merge (approved, or back to reviewed). */
  derivedStatuses?: (
    projectId: string,
  ) => Promise<{ id: string; code: string; from: string; to: 'approved' | 'reviewed' }[]>;
  now?: () => number;
}

export interface TeamEngine {
  journal: JournalPort;
  merge: MergePort;
  /** The Conflicts inbox and quarantine of a project folder (`sync:*`, T4). */
  conflicts(root: string): Promise<{ ok: true; conflicts: Conflict[] } | Failure>;
  resolve(
    projectId: string,
    root: string,
    req: {
      conflict: string;
      choice: 'ours' | 'theirs' | 'restore' | 'edit';
      op?: string;
      value?: unknown;
    },
  ): Promise<{ ok: true } | Failure>;
  quarantine(root: string): Promise<{ ok: true; entries: QuarantineEntry[] } | Failure>;
  release(projectId: string, root: string, op: string): Promise<{ ok: true } | Failure>;
  /** Project and write the merged state (after a sync, an import or a resolution). */
  refresh(projectId: string, root: string): Promise<void>;
}

interface Failure {
  ok: false;
  error: string;
}

const targetKey = (r: RecordRef) => `${r.rec}/${r.id}/${r.in ?? ''}`;

function targetsOf(ops: readonly Pick<Op, 'target'>[]): RecordRef[] {
  const seen = new Map<string, RecordRef>();
  for (const o of ops) seen.set(targetKey(o.target), o.target);
  return [...seen.values()];
}

export function createTeamEngine(d: TeamEngineDeps): TeamEngine {
  const now = d.now ?? (() => Date.now());
  /** Last projection counts per folder, keyed by the journal's heads (status asks often). */
  const counted = new Map<string, { stamp: string; conflicts: number; quarantined: number }>();

  async function keysOf(root: string): Promise<Map<string, string>> {
    return new Map((await d.journal.store.devices(root)).map((r) => [r.id, r.key]));
  }

  /** An inbox whose writes go through this journal step. */
  async function inboxIn(t: JournalTx, recodes: Notice[]): Promise<Inbox> {
    const me = await d.device.me();
    const keys = await keysOf(t.root);
    return createInbox({
      ops: () => d.journal.store.ops(t.root),
      viewer: me.actor,
      keys: () => Promise.resolve(keys),
      now,
      async append(draft: MergeDraft) {
        await t.append([draft as unknown as DraftOp]);
        if (draft.kind === 'issue.recode') {
          const p = draft.payload as { from?: unknown; to?: unknown };
          recodes.push({
            kind: 'recode',
            issue: draft.target.id,
            from: String(p.from),
            to: String(p.to),
          });
        }
      },
      read: (path) => t.read(path),
      write: (files) => t.writeMerged(files),
    });
  }

  function clockNotices(p: Projection): Notice[] {
    return p.clock.map((c) => ({
      kind: 'clock-ahead' as const,
      device: c.device,
      actor: c.actor,
      ...(p.team.members.get(c.actor)?.name ? { name: p.team.members.get(c.actor)?.name } : {}),
      aheadMs: c.aheadMs,
      level: c.level,
    }));
  }

  /** Inside a journal step: project, write, remember the counts, announce. */
  async function refreshIn(projectId: string, t: JournalTx): Promise<Projection> {
    const recodes: Notice[] = [];
    const inbox = await inboxIn(t, recodes);
    let p = await inbox.refresh();
    // T3: the status follows the approvals (decision 6), written as ops, then merged again
    const statuses = (await d.derivedStatuses?.(projectId).catch(() => [])) ?? [];
    if (statuses.length > 0) {
      await t.append(
        statuses.map((s) => ({
          kind: 'issue.status' as const,
          target: { rec: 'issue', id: s.id },
          payload: { from: s.from, to: s.to },
          label:
            s.to === 'approved'
              ? `${s.code} to approved (approvals complete)`
              : `${s.code} back to reviewed (approval out of date)`,
        })),
      );
      p = await inbox.refresh();
    }
    counted.set(t.root, {
      stamp: await stampOf(t.root),
      conflicts: p.conflicts.length,
      quarantined: p.quarantined.length,
    });
    const notices = [...clockNotices(p), ...recodes];
    if (notices.length > 0) d.notice?.(projectId, notices);
    return p;
  }

  async function stampOf(root: string): Promise<string> {
    const heads = Object.entries(await d.journal.store.heads(root))
      .map(([c, h]) => `${c}:${String(h.seq)}`)
      .sort();
    return heads.join('|');
  }

  const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const journal: JournalPort = {
    async flush(ctx: ProjectCtx) {
      await d.journal.catchUp(ctx.root);
      await d.journal.flush(ctx.root);
    },
    async record(ctx, kind, target, payload) {
      const [op] = await d.journal.append(ctx.root, [
        { kind, target, payload } as unknown as DraftOp,
      ]);
      return op ?? null;
    },
    async ingest(ctx, ops) {
      return d.journal.locked(ctx.root, async (t) => {
        const added = await t.ingest(ops);
        const p = added > 0 ? await refreshIn(ctx.projectId, t) : null;
        const mine = await t.chain();
        const records = added > 0 ? targetsOf(ops.filter((o) => o.chain !== mine)) : [];
        return { records, conflicts: p?.conflicts.length ?? (await counts(ctx.root)).conflicts };
      });
    },
  };

  async function counts(root: string) {
    const stamp = await stampOf(root);
    const hit = counted.get(root);
    if (hit?.stamp === stamp) return { conflicts: hit.conflicts, quarantined: hit.quarantined };
    const me = await d.device.me();
    const keys = await keysOf(root);
    const { project } = await import('@aio/merge');
    const p = project(await d.journal.store.ops(root), { viewer: me.actor, keys, now: now() });
    counted.set(root, { stamp, conflicts: p.conflicts.length, quarantined: p.quarantined.length });
    return { conflicts: p.conflicts.length, quarantined: p.quarantined.length };
  }

  const merge: MergePort = {
    counts: (ctx) => counts(ctx.root),
  };

  return {
    journal,
    merge,
    async conflicts(root) {
      try {
        return await d.journal.locked(root, async (t) => (await inboxIn(t, [])).conflicts());
      } catch (e) {
        return { ok: false, error: `The conflicts could not be read: ${why(e)}` };
      }
    },
    async quarantine(root) {
      try {
        return await d.journal.locked(root, async (t) => (await inboxIn(t, [])).quarantine());
      } catch (e) {
        return { ok: false, error: `The quarantined changes could not be read: ${why(e)}` };
      }
    },
    async resolve(projectId, root, req) {
      const r = await d.journal.locked(root, async (t) => {
        const recodes: Notice[] = [];
        const inbox = await inboxIn(t, recodes);
        const out = await inbox.resolve({
          conflict: req.conflict,
          // a typed value is a restore of that value (the inbox writes it as the resolution)
          choice: req.choice === 'edit' ? 'restore' : req.choice,
          ...(req.op !== undefined ? { op: req.op } : {}),
          ...(req.choice === 'edit' || req.value !== undefined ? { value: req.value } : {}),
        });
        return out;
      });
      if (r.ok) {
        counted.delete(root);
        d.changed?.(projectId, [{ rec: 'project', id: projectId }]);
      }
      return r;
    },
    async release(projectId, root, op) {
      const r = await d.journal.locked(root, async (t) => (await inboxIn(t, [])).release({ op }));
      if (r.ok) {
        counted.delete(root);
        d.changed?.(projectId, [{ rec: 'project', id: projectId }]);
      }
      return r;
    },
    async refresh(projectId, root) {
      await d.journal.locked(root, (t) => refreshIn(projectId, t));
    },
  };
}
