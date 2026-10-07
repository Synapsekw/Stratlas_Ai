import {
  PERMISSIONS,
  type ApprovalPolicy,
  type ApprovalView,
  type Permission,
  type Role,
} from '@aio/schema';

/** Why an approval does not count. */
export type NotCounted = 'withdrawn' | 'out-of-date' | 'four-eyes' | 'not-eligible' | 'duplicate';

export interface ApprovalOutcome {
  /** The policy is met: the status may become `approved`. */
  approved: boolean;
  /** Distinct actors whose approval counts. */
  counted: string[];
  needed: number;
  /** Approvals that do not count, and why. */
  notCounted: { id: string; why: NotCounted }[];
}

/** What the four-eyes rule and the role check need to know about a target. */
export interface ApprovalTarget {
  /** Who made the target (the issue's creator). */
  creator: string;
  /** Who last changed it materially; absent when nobody did after the creator. */
  lastEditor?: string | undefined;
  materialHash: string;
  roleOf: (actor: string) => Role | undefined;
}

/** The people four-eyes keeps from approving: the creator and the last material editor. */
export function authorsOf(target: Pick<ApprovalTarget, 'creator' | 'lastEditor'>): Set<string> {
  const out = new Set<string>([target.creator]);
  if (target.lastEditor) out.add(target.lastEditor);
  return out;
}

/**
 * Do the approvals of a target meet the policy (decision 6)? An approval counts once per actor,
 * while not withdrawn, while its content hash equals the target's material hash, from an owner
 * or reviewer, and (four-eyes) not from the target's creator or its last material editor.
 * `accept` and `changes-requested` never count towards approval.
 */
export function approvalOutcome(
  policy: ApprovalPolicy,
  approvals: readonly ApprovalView[],
  target: ApprovalTarget,
): ApprovalOutcome {
  const authors = authorsOf(target);
  const counted = new Set<string>();
  const notCounted: ApprovalOutcome['notCounted'] = [];
  for (const a of approvals) {
    if (a.decision !== 'approve') continue;
    const role = target.roleOf(a.by);
    const why: NotCounted | null = a.withdrawn
      ? 'withdrawn'
      : a.contentHash !== target.materialHash
        ? 'out-of-date'
        : role !== 'owner' && role !== 'reviewer'
          ? 'not-eligible'
          : policy.fourEyes && authors.has(a.by)
            ? 'four-eyes'
            : counted.has(a.by)
              ? 'duplicate'
              : null;
    if (why) notCounted.push({ id: a.id, why });
    else counted.add(a.by);
  }
  return {
    approved: counted.size >= policy.required,
    counted: [...counted].sort(),
    needed: policy.required,
    notCounted,
  };
}

/**
 * May `role` do `permission` under the approval policy (the roles table of the M9 plan)?
 * `viewersMayComment` adds viewers to team comments; `closeBy` adds reviewers to closing.
 */
export function allowed(
  permission: Permission,
  role: Role | undefined,
  policy: Pick<ApprovalPolicy, 'viewersMayComment' | 'closeBy'>,
): boolean {
  if (!role) return false;
  const rule = PERMISSIONS[permission];
  if ((rule.roles as readonly Role[]).includes(role)) return true;
  if (!('policy' in rule)) return false;
  const on =
    rule.policy.switch === 'viewersMayComment'
      ? policy.viewersMayComment
      : policy.closeBy === 'owner-or-reviewer';
  return on && rule.policy.adds === role;
}

/** Why a person may not approve a target now, or null when they may. */
export type ApproveRefusal =
  'agent' | 'not-shared' | 'role' | 'four-eyes' | 'already' | 'not-reviewed' | 'acceptance-off';

/**
 * The checks main runs before it writes `approval.add` (the agent never gets here: decision 6).
 * `status` is the issue's status for issue targets, absent for the others.
 */
export function approveRefusal(input: {
  decision: 'approve' | 'changes-requested' | 'accept';
  me: string;
  role: Role | undefined;
  shared: boolean;
  policy: ApprovalPolicy;
  target: Pick<ApprovalTarget, 'creator' | 'lastEditor' | 'materialHash'>;
  /** My earlier approvals of this target. */
  mine: readonly ApprovalView[];
  status?: string | undefined;
  agent?: boolean;
}): ApproveRefusal | null {
  if (input.agent) return 'agent';
  if (!input.shared) return 'not-shared';
  if (input.decision === 'accept') {
    if (input.policy.clientAcceptance === 'off') return 'acceptance-off';
    return allowed('accept', input.role, input.policy) ? null : 'role';
  }
  if (!allowed('approve', input.role, input.policy)) return 'role';
  if (input.decision === 'changes-requested') return null;
  if (input.policy.fourEyes && authorsOf(input.target).has(input.me)) return 'four-eyes';
  if (input.status === 'draft') return 'not-reviewed';
  const current = input.mine.some(
    (a) => a.decision === 'approve' && !a.withdrawn && a.contentHash === input.target.materialHash,
  );
  return current ? 'already' : null;
}
