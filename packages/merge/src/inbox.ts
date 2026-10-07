import type { Conflict, Op, QuarantineEntry } from '@aio/schema';
import { mergeStateFiles, type MergedFile } from './apply';
import { releaseDraft, resolveDrafts, type OpDraft } from './conflicts';
import { project, type Projection } from './project';

/**
 * The four `sync:*` inbox channels as functions over injected I/O, so main wires each with one
 * line (T5 owns `main/sync/index.ts`). Answers follow the IPC shapes: `{ ok: true, ... }` or
 * `{ ok: false, error }` with a plain sentence.
 */
export interface InboxDeps {
  /** Every op of the project the journal holds (all chains). */
  ops: () => Promise<readonly Op[]>;
  /** The actor using this copy. */
  viewer: string;
  /** Device public keys from `journal/devices/` (checked: hash, payload, signature). */
  keys?: () => Promise<ReadonlyMap<string, string>>;
  /** This machine's time (clock-ahead hold). */
  now?: () => number;
  /** Seal, sign and append one op through the journal service (op first, then state). */
  append: (draft: OpDraft) => Promise<void>;
  /** Read a project-relative state file; null when absent. */
  read: (path: string) => Promise<string | null>;
  /** Write merged state files through the journal service (atomic, `.bak`). */
  write: (files: readonly MergedFile[]) => Promise<void>;
}

interface Failure {
  ok: false;
  error: string;
}

export interface Inbox {
  conflicts(): Promise<{ ok: true; conflicts: Conflict[] } | Failure>;
  resolve(req: {
    conflict: string;
    choice: 'ours' | 'theirs' | 'restore';
    /** Restore: the op in history whose value to write back. */
    op?: string;
    /** Edit: the value the person typed (not in the T0 request yet; see the README). */
    value?: unknown;
  }): Promise<{ ok: true } | Failure>;
  quarantine(): Promise<{ ok: true; entries: QuarantineEntry[] } | Failure>;
  release(req: { op: string }): Promise<{ ok: true } | Failure>;
  /** Project and write merged state files (after a sync or import); returns the projection. */
  refresh(): Promise<Projection>;
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createInbox(deps: InboxDeps): Inbox {
  const current = async (): Promise<Projection> =>
    project(await deps.ops(), {
      viewer: deps.viewer,
      ...(deps.keys ? { keys: await deps.keys() } : {}),
      ...(deps.now ? { now: deps.now() } : {}),
    });
  const refresh = async (): Promise<Projection> => {
    let p = await current();
    // codes renumbered here are written down, so they stay (every copy picks the same ones)
    if (p.recodes.length > 0) {
      for (const r of p.recodes) {
        await deps.append({
          kind: 'issue.recode',
          target: { rec: 'issue', id: r.issue },
          payload: { from: r.from, to: r.to },
          label: `${r.from} to ${r.to} (made apart with the same code)`,
        });
      }
      p = await current();
    }
    const { files } = await mergeStateFiles(p, deps.read);
    if (files.length > 0) await deps.write(files);
    return p;
  };
  return {
    refresh,
    async conflicts() {
      try {
        return { ok: true, conflicts: (await current()).conflicts };
      } catch (e) {
        return { ok: false, error: `The conflicts could not be read: ${why(e)}` };
      }
    },
    async resolve({ conflict, choice, op, value }) {
      try {
        const p = await current();
        const c = p.conflicts.find((x) => x.id === conflict);
        if (!c) return { ok: false, error: 'This conflict is already resolved.' };
        let chosen = value;
        if (choice === 'restore' && op !== undefined) {
          const h = p.history(c.target, c.field).find((w) => w.op === op);
          if (!h || h.absent)
            return { ok: false, error: 'That earlier value is not in the history.' };
          chosen = h.value;
        }
        if (choice === 'restore' && chosen === undefined) {
          return { ok: false, error: 'Choose an earlier value or type a new one.' };
        }
        for (const d of resolveDrafts(c, choice, chosen)) await deps.append(d);
        await refresh();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `The choice was not saved: ${why(e)}` };
      }
    },
    async quarantine() {
      try {
        return { ok: true, entries: (await current()).quarantined };
      } catch (e) {
        return { ok: false, error: `The quarantined changes could not be read: ${why(e)}` };
      }
    },
    async release({ op }) {
      try {
        const p = await current();
        const role = p.team.members.get(deps.viewer)?.role;
        if (p.team.shared && role !== 'owner') {
          return { ok: false, error: 'Only an owner can apply a quarantined change.' };
        }
        const entry = p.quarantined.find((q) => q.op === op);
        if (!entry) return { ok: false, error: 'This change is no longer quarantined.' };
        await deps.append(releaseDraft(entry));
        await refresh();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `The change was not applied: ${why(e)}` };
      }
    },
  };
}
