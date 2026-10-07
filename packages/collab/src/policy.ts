import type { ApprovalPolicy, ApprovalView, Role } from '@aio/schema';

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

/**
 * Do the approvals of a target meet the policy (decision 6)? An approval counts once per actor,
 * while not withdrawn, while its content hash equals the target's material hash, from an owner
 * or reviewer, and (four-eyes) not from the target's creator. `accept` and `changes-requested`
 * never count towards approval.
 */
export function approvalOutcome(
  policy: ApprovalPolicy,
  approvals: readonly ApprovalView[],
  target: { creator: string; materialHash: string; roleOf: (actor: string) => Role | undefined },
): ApprovalOutcome {
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
          : policy.fourEyes && a.by === target.creator
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
