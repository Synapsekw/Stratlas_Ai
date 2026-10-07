import {
  targetKey,
  type ApprovalView,
  type AssignmentView,
  type CollabState,
  type CollabTarget,
  type CommentView,
  type Role,
} from '@aio/schema';

/** One line of My work. */
export type WorkItem =
  | { kind: 'assigned'; target: CollabTarget; assignment: AssignmentView }
  | { kind: 'mention'; target: CollabTarget; comment: CommentView }
  | { kind: 'awaiting'; target: CollabTarget; assignment: AssignmentView };

export interface MyWork {
  assigned: WorkItem[];
  mentions: WorkItem[];
  awaiting: WorkItem[];
}

/**
 * My work (in app only, no email or push in M9): what is assigned to me, the comments that
 * mention me (not my own, not deleted), and what awaits my approval: work assigned to me whose
 * target is reviewed and that I have not approved at its current content. `statusOf` gives an
 * issue's status (other targets have none and are always awaiting until I sign them).
 */
export function myWork(
  state: CollabState,
  me: string,
  opts: { statusOf?: (target: CollabTarget) => string | undefined } = {},
): MyWork {
  const approvedByMe = new Set(
    state.approvals
      .filter((a) => a.by === me && a.decision === 'approve' && !a.withdrawn && a.current)
      .map((a) => targetKey(a.target)),
  );
  const assigned: WorkItem[] = [];
  const awaiting: WorkItem[] = [];
  for (const a of state.assignments) {
    if (a.assignee !== me) continue;
    assigned.push({ kind: 'assigned', target: a.target, assignment: a });
    if (!state.policy) continue;
    const status = opts.statusOf?.(a.target);
    if (a.target.kind === 'issue' && status !== 'reviewed') continue;
    if (!approvedByMe.has(targetKey(a.target)))
      awaiting.push({ kind: 'awaiting', target: a.target, assignment: a });
  }
  const mentions: WorkItem[] = state.comments
    .filter((c) => c.mentions.includes(me) && c.author !== me && !c.deleted && !c.redacted)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .map((c) => ({ kind: 'mention', target: c.target, comment: c }));
  return { assigned, mentions, awaiting };
}

/** Targets that are mine: assigned to me, or mentioning me (the Mine filter). */
export function mineKeys(state: CollabState, me: string): Set<string> {
  const w = myWork(state, me);
  return new Set([...w.assigned, ...w.mentions].map((i) => targetKey(i.target)));
}

/**
 * What a role may read (the roles table): a client sees only client-visible comments and the
 * sign-offs, never internal comments or assignments.
 */
export function visibleTo(state: CollabState, role: Role | undefined): CollabState {
  if (role !== 'client') return state;
  return {
    comments: state.comments.filter((c) => c.visibility === 'client'),
    assignments: [],
    approvals: state.approvals.filter((a) => a.decision !== 'changes-requested'),
    policy: state.policy,
  };
}

/** A thread: top-level comments in order, each with its replies. */
export function threadOf(
  comments: readonly CommentView[],
): { comment: CommentView; replies: CommentView[] }[] {
  const ids = new Set(comments.map((c) => c.id));
  const replies = new Map<string, CommentView[]>();
  const top: CommentView[] = [];
  for (const c of comments) {
    if (c.replyTo && ids.has(c.replyTo)) {
      replies.set(c.replyTo, [...(replies.get(c.replyTo) ?? []), c]);
    } else top.push(c);
  }
  return top.map((comment) => ({ comment, replies: replies.get(comment.id) ?? [] }));
}

/** The latest approval of each person on a target (what the approval bar lists). */
export function latestByPerson(approvals: readonly ApprovalView[]): ApprovalView[] {
  const by = new Map<string, ApprovalView>();
  for (const a of approvals) if (!a.withdrawn) by.set(`${a.by}:${a.decision}`, a);
  return [...by.values()];
}
