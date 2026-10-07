import {
  ApprovalPayload,
  ApprovalWithdrawPayload,
  AssignPayload,
  CollabTargetKind,
  CommentDeletePayload,
  CommentEditPayload,
  CommentPayload,
  CommentRedactPayload,
  DEFAULT_TEAM_POLICY,
  PolicySetPayload,
  TeamPolicy,
  targetKey,
  type ApprovalView,
  type AssignmentView,
  type CollabState,
  type CollabTarget,
  type CommentView,
} from '@aio/schema';

/**
 * The part of an op the projection reads. Main hands the raw lines of every chain; `payload` is
 * absent when it was redacted. Unknown kinds are ignored here (the journal keeps them).
 */
export interface CollabOp {
  id: string;
  act: string;
  hlc: string;
  kind: string;
  target: { rec: string; id: string; in?: string | undefined };
  payload?: unknown;
}

export interface ProjectOptions {
  /**
   * The target's current material hash under the projected policy (null: no team policy); null
   * when the target is gone or unreadable.
   */
  materialHashOf?: (target: CollabTarget, policy: TeamPolicy | null) => string | null;
  /** Owners may delete others' comments, redact and set the policy. */
  isOwner?: (actor: string) => boolean;
}

/** Kinds that make a project shared (a team policy applies from then on). */
const SHARING_KINDS = new Set(['project.share', 'policy.set', 'member.add']);

/** The op's record ref as a collab target, when it names one. */
export function targetOfRef(ref: CollabOp['target']): CollabTarget | null {
  const kind = CollabTargetKind.safeParse(ref.rec);
  if (!kind.success) return null;
  return { kind: kind.data, id: ref.id, ...(ref.in ? { in: ref.in } : {}) };
}

/** The record ref a collab op is written against: the commented, assigned or approved record. */
export function refOfTarget(t: CollabTarget): CollabOp['target'] {
  return { rec: t.kind, id: t.id, ...(t.in ? { in: t.in } : {}) };
}

/** Deterministic order: clock reading, then op id. Any arrival order projects the same. */
export function sortOps<T extends Pick<CollabOp, 'hlc' | 'id'>>(ops: readonly T[]): T[] {
  return [...ops].sort((a, b) =>
    a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

function ok<T>(r: { success: true; data: T } | { success: false }): T | null {
  return r.success ? r.data : null;
}

/** Does the op list share the project (a policy applies)? */
export function isShared(ops: readonly Pick<CollabOp, 'kind'>[]): boolean {
  return ops.some((o) => SHARING_KINDS.has(o.kind));
}

/**
 * Comments, assignments, approvals and the team policy from the journal (data-conventions
 * section 18). Rules: comments are grow-only, edited by their author, deleted (tombstone) by the
 * author or an owner, redacted by an owner; an assignment is the last `assign.set` by clock; an
 * approval is grow-only and withdrawn by its own author; the policy folds the owner's `policy.set`
 * ops over the defaults. Order-independent: ops are sorted by clock and id first.
 */
export function projectCollab(ops: readonly CollabOp[], opts: ProjectOptions = {}): CollabState {
  const isOwner = opts.isOwner ?? (() => false);
  const sorted = sortOps(ops);
  const comments = new Map<string, CommentView>();
  /** Op ids of comment adds whose payload is gone, for redactions that name them. */
  const bareAdds = new Map<string, CollabOp>();
  const assignments = new Map<string, AssignmentView>();
  const approvals = new Map<string, ApprovalView>();
  const shared = isShared(sorted);
  let policy: TeamPolicy | null = shared ? structuredClone(DEFAULT_TEAM_POLICY) : null;

  for (const op of sorted) {
    switch (op.kind) {
      case 'comment.add': {
        if (op.payload === undefined) {
          bareAdds.set(op.id, op);
          break;
        }
        const p = ok(CommentPayload.safeParse(op.payload));
        if (!p || comments.has(p.id)) break;
        comments.set(p.id, {
          id: p.id,
          target: p.target,
          author: op.act,
          text: p.text,
          visibility: p.visibility,
          mentions: p.mentions,
          ...(p.view ? { view: p.view } : {}),
          ...(p.replyTo ? { replyTo: p.replyTo } : {}),
          createdAt: op.hlc,
          versions: 1,
          deleted: false,
        });
        break;
      }
      case 'comment.edit': {
        const p = ok(CommentEditPayload.safeParse(op.payload));
        const c = p ? comments.get(p.id) : undefined;
        if (!p || c?.author !== op.act || c.deleted || c.redacted) break;
        c.text = p.text;
        if (p.mentions) c.mentions = p.mentions;
        c.editedAt = op.hlc;
        c.versions += 1;
        break;
      }
      case 'comment.delete': {
        const p = ok(CommentDeletePayload.safeParse(op.payload));
        const c = p ? comments.get(p.id) : undefined;
        if (!c || (c.author !== op.act && !isOwner(op.act))) break;
        c.deleted = true;
        c.text = null;
        break;
      }
      case 'comment.redact': {
        const p = ok(CommentRedactPayload.safeParse(op.payload));
        if (!p || !isOwner(op.act)) break;
        let c = comments.get(p.id);
        if (!c) {
          // the add lost its payload already: rebuild the bare comment from its op
          const add = p.ops.map((id) => bareAdds.get(id)).find(Boolean);
          const target = add ? targetOfRef(add.target) : null;
          if (!add || !target) break;
          c = {
            id: p.id,
            target,
            author: add.act,
            text: null,
            visibility: 'team',
            mentions: [],
            createdAt: add.hlc,
            versions: 1,
            deleted: false,
          };
          comments.set(p.id, c);
        }
        c.text = null;
        c.mentions = [];
        delete c.view;
        c.redacted = { by: op.act, at: op.hlc };
        break;
      }
      case 'assign.set': {
        const p = ok(AssignPayload.safeParse(op.payload));
        if (!p) break;
        const key = targetKey(p.target);
        if (p.assignee === null) assignments.delete(key);
        else
          assignments.set(key, {
            target: p.target,
            assignee: p.assignee,
            ...(p.due ? { due: p.due } : {}),
            ...(p.note ? { note: p.note } : {}),
            by: op.act,
            at: op.hlc,
          });
        break;
      }
      case 'approval.add': {
        const p = ok(ApprovalPayload.safeParse(op.payload));
        if (!p || approvals.has(p.id)) break;
        approvals.set(p.id, {
          id: p.id,
          target: p.target,
          by: op.act,
          decision: p.decision,
          contentHash: p.contentHash,
          ...(p.comment ? { comment: p.comment } : {}),
          at: op.hlc,
          withdrawn: false,
          current: false,
        });
        break;
      }
      case 'approval.withdraw': {
        const p = ok(ApprovalWithdrawPayload.safeParse(op.payload));
        const a = p ? approvals.get(p.id) : undefined;
        if (a?.by === op.act) a.withdrawn = true;
        break;
      }
      case 'policy.set': {
        const p = ok(PolicySetPayload.safeParse(op.payload));
        if (!p || !policy || !isOwner(op.act)) break;
        policy = TeamPolicy.parse({
          approval: { ...policy.approval, ...stripUndefined(p.approval ?? {}) },
          minVerification: p.minVerification ?? policy.minVerification,
          packageHistory: p.packageHistory ?? policy.packageHistory,
        });
        break;
      }
    }
  }

  const hashes = new Map<string, string | null>();
  const hashOf = (t: CollabTarget) => {
    const k = targetKey(t);
    if (!hashes.has(k)) hashes.set(k, opts.materialHashOf?.(t, policy) ?? null);
    return hashes.get(k) ?? null;
  };
  for (const a of approvals.values()) a.current = hashOf(a.target) === a.contentHash;

  const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    comments: [...comments.values()].sort(
      (a, b) => byKey(a.createdAt, b.createdAt) || byKey(a.id, b.id),
    ),
    assignments: [...assignments.values()].sort((a, b) =>
      byKey(targetKey(a.target), targetKey(b.target)),
    ),
    approvals: [...approvals.values()].sort((a, b) => byKey(a.at, b.at) || byKey(a.id, b.id)),
    policy,
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The state of one target only (`collab:read` with a target). */
export function stateOfTarget(state: CollabState, target: CollabTarget): CollabState {
  const k = targetKey(target);
  return {
    comments: state.comments.filter((c) => targetKey(c.target) === k),
    assignments: state.assignments.filter((a) => targetKey(a.target) === k),
    approvals: state.approvals.filter((a) => targetKey(a.target) === k),
    policy: state.policy,
  };
}
