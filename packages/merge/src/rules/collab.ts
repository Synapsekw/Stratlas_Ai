import { targetKey, type CollabTarget } from '@aio/schema';
import type { OpIndex, OpNode } from '../causal';
import { sideOf, type ConflictSeed } from '../conflicts';
import { concurrentLosers, writeOf, type Write } from '../registers';

/**
 * Comments and approvals only grow (edits are versions, deletes and withdrawals are marks);
 * assignments are last writer per target, two different concurrent assignees being a conflict.
 * The views match `@aio/schema` `CollabState`, except that whether an approval is still current
 * (its content hash against the target's material content) is left to `@aio/collab`.
 */

export interface MergedComment {
  id: string;
  target: CollabTarget;
  author: string;
  text: string | null;
  visibility: 'team' | 'client';
  mentions: string[];
  view?: unknown;
  replyTo?: string;
  createdAt: string;
  editedAt?: string;
  versions: number;
  deleted: boolean;
  redacted?: { by: string; at: string };
}

export interface MergedAssignment {
  target: CollabTarget;
  assignee: string;
  due?: string;
  note?: string;
  by: string;
  at: string;
}

export interface MergedApproval {
  id: string;
  target: CollabTarget;
  by: string;
  decision: 'approve' | 'changes-requested' | 'accept';
  contentHash: string;
  comment?: string;
  at: string;
  withdrawn: boolean;
}

export interface CollabProjection {
  comments: MergedComment[];
  assignments: MergedAssignment[];
  approvals: MergedApproval[];
  conflicts: ConflictSeed[];
}

const COLLAB_KINDS = new Set([
  'comment.add',
  'comment.edit',
  'comment.delete',
  'comment.redact',
  'assign.set',
  'approval.add',
  'approval.withdraw',
]);

export const isCollabOp = (node: OpNode): boolean => COLLAB_KINDS.has(node.op.kind);

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function asTarget(v: unknown): CollabTarget | null {
  const t = obj(v);
  if (typeof t.kind !== 'string' || typeof t.id !== 'string') return null;
  return {
    kind: t.kind as CollabTarget['kind'],
    id: t.id,
    ...(typeof t.in === 'string' ? { in: t.in } : {}),
  };
}

export function projectCollab(applied: readonly OpNode[], index: OpIndex): CollabProjection {
  const comments = new Map<string, MergedComment>();
  const approvals = new Map<string, MergedApproval>();
  const assigns = new Map<string, { target: CollabTarget; writes: Write[] }>();
  const redactedComments = new Map<string, { by: string; at: string }>();

  for (const node of applied) {
    if (!isCollabOp(node)) continue;
    const { op } = node;
    const p = obj(op.payload);
    const id = typeof p.id === 'string' ? p.id : undefined;
    switch (op.kind) {
      case 'comment.add': {
        const target = asTarget(p.target);
        if (!id || !target || comments.has(id)) break;
        comments.set(id, {
          id,
          target,
          author: op.act,
          text: typeof p.text === 'string' ? p.text : null,
          visibility: p.visibility === 'client' ? 'client' : 'team',
          mentions: Array.isArray(p.mentions)
            ? p.mentions.filter((m) => typeof m === 'string')
            : [],
          ...(p.view !== undefined ? { view: p.view } : {}),
          ...(typeof p.replyTo === 'string' ? { replyTo: p.replyTo } : {}),
          createdAt: op.hlc,
          versions: 1,
          deleted: false,
        });
        break;
      }
      case 'comment.edit': {
        const c = id ? comments.get(id) : undefined;
        if (c?.author !== op.act) break;
        c.versions += 1;
        c.editedAt = op.hlc;
        c.text = typeof p.text === 'string' ? p.text : null;
        if (Array.isArray(p.mentions)) c.mentions = p.mentions.filter((m) => typeof m === 'string');
        break;
      }
      case 'comment.delete': {
        const c = id ? comments.get(id) : undefined;
        if (c) c.deleted = true;
        break;
      }
      case 'comment.redact':
        if (id) redactedComments.set(id, { by: op.act, at: op.hlc });
        break;
      case 'assign.set': {
        const target = asTarget(p.target);
        if (!target) break;
        const key = targetKey(target);
        const entry = assigns.get(key) ?? { target, writes: [] };
        entry.writes.push({
          ...writeOf(node, p.assignee ?? null),
          // the full payload rides along for the view; equality is by assignee
          value: { assignee: p.assignee ?? null, due: p.due, note: p.note },
        });
        assigns.set(key, entry);
        break;
      }
      case 'approval.add': {
        const target = asTarget(p.target);
        if (!id || !target || approvals.has(id)) break;
        const decision =
          p.decision === 'changes-requested' || p.decision === 'accept' ? p.decision : 'approve';
        approvals.set(id, {
          id,
          target,
          by: op.act,
          decision,
          contentHash: typeof p.contentHash === 'string' ? p.contentHash : '',
          ...(typeof p.comment === 'string' ? { comment: p.comment } : {}),
          at: op.hlc,
          withdrawn: false,
        });
        break;
      }
      case 'approval.withdraw': {
        const a = id ? approvals.get(id) : undefined;
        if (a?.by === op.act) a.withdrawn = true;
        break;
      }
      default:
        break;
    }
  }
  for (const [id, r] of redactedComments) {
    const c = comments.get(id);
    if (c) {
      c.text = null;
      c.redacted = r;
    }
  }

  const conflicts: ConflictSeed[] = [];
  const assignments: MergedAssignment[] = [];
  for (const { target, writes } of assigns.values()) {
    const w = writes[writes.length - 1];
    const v = obj(w?.value);
    if (w && typeof v.assignee === 'string') {
      assignments.push({
        target,
        assignee: v.assignee,
        ...(typeof v.due === 'string' ? { due: v.due } : {}),
        ...(typeof v.note === 'string' ? { note: v.note } : {}),
        by: w.node.op.act,
        at: w.node.op.hlc,
      });
    }
    for (const c of concurrentLosers('assignee', writes, index)) {
      const side = (x: Write) => ({ ...sideOf(x), value: obj(x.value).assignee ?? null });
      conflicts.push({
        target: { rec: target.kind, id: target.id, ...(target.in ? { in: target.in } : {}) },
        field: 'assignee',
        kind: 'value',
        winner: side(c.winner),
        loser: side(c.loser),
      });
    }
  }

  const byAt = <T extends { createdAt?: string; at?: string; id?: string }>(a: T, b: T) => {
    const x = a.createdAt ?? a.at ?? '';
    const y = b.createdAt ?? b.at ?? '';
    return x < y ? -1 : x > y ? 1 : (a.id ?? '') < (b.id ?? '') ? -1 : 1;
  };
  return {
    comments: [...comments.values()].sort(byAt),
    assignments: assignments.sort((a, b) => (targetKey(a.target) < targetKey(b.target) ? -1 : 1)),
    approvals: [...approvals.values()].sort(byAt),
    conflicts,
  };
}
