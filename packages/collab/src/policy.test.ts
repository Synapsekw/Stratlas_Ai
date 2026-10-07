import { ApprovalPolicy, DEFAULT_APPROVAL_POLICY, type ApprovalView } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { approvalOutcome } from './index';

const material = 'a'.repeat(64);
const roles: Record<string, 'owner' | 'reviewer' | 'viewer'> = {
  rana: 'owner',
  omar: 'reviewer',
  lina: 'reviewer',
  vera: 'viewer',
};
const approval = (id: string, by: string, extra: Partial<ApprovalView> = {}): ApprovalView => ({
  id,
  target: { kind: 'issue', id: 'i_f05' },
  by,
  decision: 'approve',
  contentHash: material,
  at: `1790000000000.0000.d_${'a'.repeat(52)}`,
  withdrawn: false,
  current: true,
  ...extra,
});
const target = { creator: 'rana', materialHash: material, roleOf: (a: string) => roles[a] };

describe('@aio/collab approval policy (T0)', () => {
  it('four-eyes: the creator does not count; another reviewer completes it', () => {
    const mine = approvalOutcome(DEFAULT_APPROVAL_POLICY, [approval('ap1', 'rana')], target);
    expect(mine.approved).toBe(false);
    expect(mine.notCounted).toEqual([{ id: 'ap1', why: 'four-eyes' }]);
    const both = approvalOutcome(
      DEFAULT_APPROVAL_POLICY,
      [approval('ap1', 'rana'), approval('ap2', 'omar')],
      target,
    );
    expect(both.approved).toBe(true);
    expect(both.counted).toEqual(['omar']);
  });

  it('needs two distinct current approvals when the policy says two', () => {
    const two = ApprovalPolicy.parse({ required: 2 });
    const stale = approval('ap3', 'lina', { contentHash: 'b'.repeat(64) });
    const r = approvalOutcome(
      two,
      [approval('ap2', 'omar'), approval('ap2b', 'omar'), stale, approval('ap4', 'vera')],
      target,
    );
    expect(r.approved).toBe(false);
    expect(r.notCounted.map((n) => n.why)).toEqual(['duplicate', 'out-of-date', 'not-eligible']);
    expect(
      approvalOutcome(two, [approval('ap2', 'omar'), approval('ap5', 'lina')], target).approved,
    ).toBe(true);
  });
});
