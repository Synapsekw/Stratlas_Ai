import { checkOp, parseHlc } from '@aio/journal';
import {
  CLOCK_AHEAD_HOLD_MS,
  CLOCK_AHEAD_NOTICE_MS,
  DEFAULT_TEAM_POLICY,
  isKnownOpKind,
  OP_PERMISSION,
  PERMISSIONS,
  type Permission,
  type QuarantineEntry,
  type RefusalCode,
  type Role,
  type TeamPolicy,
} from '@aio/schema';
import type { OpIndex, OpNode } from './causal';
import { OWNER_ONLY_MANIFEST_FIELDS } from './rules';

/** Why an op is refused, from verification done elsewhere (Verify, the importer, the server). */
export interface Refusal {
  reason: RefusalCode;
  message: string;
}

export interface GateOptions {
  /** Device public keys (base64url): ops are checked against them (hash, payload, signature). */
  keys?: ReadonlyMap<string, string>;
  /** Ops already refused by Verify or the importer, by op id. */
  refused?: ReadonlyMap<string, Refusal>;
  /** This machine's time (ms): ops more than 24 hours ahead are held in quarantine. */
  now?: number;
}

/** The prefix of a `conflict.resolve` op's `conflict` that releases a quarantined op. */
export const RELEASE_PREFIX = 'quarantine:';

export interface MemberView {
  actor: string;
  role: Role;
  name?: string;
  initials?: string;
}

/** Who is in the project, from the applied team ops. A project never shared has no roles. */
export interface TeamView {
  shared: boolean;
  teamProjectId?: string;
  members: ReadonlyMap<string, MemberView>;
  /** Device id to the clock reading of its revocation. */
  revoked: ReadonlyMap<string, string>;
  /** Null for a project that is not shared (free status stepping as in 0.8). */
  policy: TeamPolicy | null;
}

export interface ClockNotice {
  device: string;
  actor: string;
  aheadMs: number;
  /** `hold`: more than 24 hours ahead, the op waits in quarantine. */
  level: 'notice' | 'hold';
}

export interface Gate {
  /** Ops that apply, in total order. */
  applied: OpNode[];
  quarantined: QuarantineEntry[];
  /** Quarantined ops an owner released (applied anyway, with a recorded decision). */
  released: string[];
  team: TeamView;
  clock: ClockNotice[];
}

const MESSAGES: Record<RefusalCode, string> = {
  schema: 'The change is not in a form this version understands.',
  hash: 'The change was altered after it was made.',
  signature: 'The signature does not match the device key.',
  chain: 'The change does not fit the chain of its device.',
  gap: 'Earlier changes from this device are missing.',
  role: 'The role of the person who made it does not allow this change.',
  revoked: 'Made on a device that was revoked.',
  'non-member': 'Made by someone who is not a member of this project.',
  'clock-ahead': 'The clock of the device was more than a day ahead.',
};

/** Whether a role may use a permission under a team policy. */
export function roleAllows(role: Role, perm: Permission, policy: TeamPolicy): boolean {
  const rule: { roles: readonly Role[]; policy?: { switch: string; adds: Role } } =
    PERMISSIONS[perm];
  if (rule.roles.includes(role)) return true;
  if (rule.policy?.adds !== role) return false;
  if (rule.policy.switch === 'viewersMayComment') return policy.approval.viewersMayComment;
  if (rule.policy.switch === 'closeBy') return policy.approval.closeBy === 'owner-or-reviewer';
  return false;
}

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The permission an op needs at its clock reading; null when none (events about itself). */
export function permissionFor(node: OpNode): Permission | null {
  const { kind } = node.op;
  const payload = obj(node.op.payload);
  if (kind === 'record.external') return 'patch' in payload ? 'edit' : null;
  if (!isKnownOpKind(kind)) return null;
  if (kind === 'manifest.entry') {
    const touched = [
      ...Object.keys(obj(payload.set)),
      ...(Array.isArray(payload.unset) ? payload.unset.map(String) : []),
    ];
    if (touched.some((f) => (OWNER_ONLY_MANIFEST_FIELDS as readonly string[]).includes(f))) {
      return 'builder.georef';
    }
  }
  if (kind === 'issue.status') {
    const pair = `${String(payload.from)}>${String(payload.to)}`;
    if (pair === 'approved>closed' || pair === 'closed>approved') return 'close-approved';
  }
  if (kind === 'comment.add' && payload.visibility === 'client') return 'comment.client';
  if (kind === 'approval.add' && payload.decision === 'accept') return 'accept';
  return OP_PERMISSION[kind];
}

function mergePolicy(base: TeamPolicy, patch: Record<string, unknown>): TeamPolicy {
  const approval = { ...base.approval, ...obj(patch.approval) };
  const out: TeamPolicy = { ...base, approval };
  if (typeof patch.minVerification === 'string') {
    out.minVerification = patch.minVerification as TeamPolicy['minVerification'];
  }
  if (patch.packageHistory === 'summary' || patch.packageHistory === 'full') {
    out.packageHistory = patch.packageHistory;
  }
  return out;
}

/**
 * Decide which ops apply. Ops that fail verification, come from a revoked device or a
 * non-member, go beyond the person's role at their clock reading, or are more than a day ahead
 * are quarantined: kept, never applied, listed for an owner. An owner may release one with a
 * `conflict.resolve` op naming `quarantine:<op id>` (the decision is recorded).
 *
 * Team ops are evaluated in clock order, each against the membership at that point, so every copy
 * with the same ops reaches the same membership and the same verdicts.
 */
export function gate(index: OpIndex, opts: GateOptions = {}): Gate {
  const st = { shared: false };
  let teamProjectId: string | undefined;
  const members = new Map<string, MemberView>();
  const revoked = new Map<string, string>();
  let policy: TeamPolicy = DEFAULT_TEAM_POLICY;
  const commentAuthors = new Map<string, string>();
  const approvalAuthors = new Map<string, string>();
  const applied: OpNode[] = [];
  const quarantined = new Map<string, { node: OpNode; reason: RefusalCode; message: string }>();
  const releases = new Set<string>();
  const clock = new Map<string, ClockNotice>();

  const roleOf = (actor: string): Role | undefined => members.get(actor)?.role;

  const refuse = (node: OpNode): Refusal | null => {
    const { op } = node;
    const given = opts.refused?.get(op.id);
    if (given) return given;
    const key = opts.keys?.get(op.dev);
    if (opts.keys) {
      const check = checkOp(op, key);
      if (!check.id || check.payload === false) return { reason: 'hash', message: MESSAGES.hash };
      if (check.signature === false) return { reason: 'signature', message: MESSAGES.signature };
    }
    if (opts.now !== undefined) {
      const ahead = parseHlc(op.hlc).ms - opts.now;
      if (ahead > CLOCK_AHEAD_NOTICE_MS) {
        const level = ahead > CLOCK_AHEAD_HOLD_MS ? 'hold' : 'notice';
        const seen = clock.get(op.dev);
        if (!seen || seen.aheadMs < ahead) {
          clock.set(op.dev, { device: op.dev, actor: op.act, aheadMs: ahead, level });
        }
        if (level === 'hold') return { reason: 'clock-ahead', message: MESSAGES['clock-ahead'] };
      }
    }
    const revokedAt = revoked.get(op.dev);
    if (revokedAt !== undefined && op.hlc > revokedAt) {
      return { reason: 'revoked', message: MESSAGES.revoked };
    }
    const payload = obj(op.payload);
    // rules that hold with or without a team
    if (op.kind === 'comment.edit') {
      const author = commentAuthors.get(String(payload.id));
      if (author !== undefined && author !== op.act) {
        return { reason: 'role', message: 'Only the author edits a comment.' };
      }
    }
    if (op.kind === 'comment.delete') {
      const author = commentAuthors.get(String(payload.id));
      if (author !== undefined && author !== op.act && !(st.shared && roleOf(op.act) === 'owner')) {
        return { reason: 'role', message: 'Only the author or an owner deletes a comment.' };
      }
    }
    if (op.kind === 'approval.withdraw') {
      const author = approvalAuthors.get(String(payload.id));
      if (author !== undefined && author !== op.act) {
        return { reason: 'role', message: 'Only the person who approved withdraws an approval.' };
      }
    }
    if (op.kind === 'approval.add' && op.via && 'agent' in op.via) {
      return { reason: 'role', message: 'The agent never approves. Only a person does.' };
    }
    if (op.kind === 'project.share' && !st.shared) return null;
    if (!st.shared) return null;
    const perm = permissionFor(node);
    if (perm === null) return null;
    const role = roleOf(op.act);
    if (role === undefined) return { reason: 'non-member', message: MESSAGES['non-member'] };
    if (!roleAllows(role, perm, policy)) {
      return { reason: 'role', message: `A ${role} may not make this change.` };
    }
    return null;
  };

  const applyTeam = (node: OpNode): void => {
    const { op } = node;
    const p = obj(op.payload);
    switch (op.kind) {
      case 'project.share':
        if (!st.shared) {
          st.shared = true;
          teamProjectId = typeof p.teamProjectId === 'string' ? p.teamProjectId : undefined;
          if (!members.has(op.act)) members.set(op.act, { actor: op.act, role: 'owner' });
        }
        break;
      case 'member.add':
        if (typeof p.actor === 'string' && typeof p.role === 'string') {
          members.set(p.actor, {
            actor: p.actor,
            role: p.role as Role,
            ...(typeof p.name === 'string' ? { name: p.name } : {}),
            ...(typeof p.initials === 'string' ? { initials: p.initials } : {}),
          });
        }
        break;
      case 'member.role': {
        const m = typeof p.actor === 'string' ? members.get(p.actor) : undefined;
        if (m && typeof p.role === 'string') members.set(m.actor, { ...m, role: p.role as Role });
        break;
      }
      case 'member.remove':
        if (typeof p.actor === 'string') members.delete(p.actor);
        break;
      case 'device.revoke':
        if (typeof p.device === 'string' && !revoked.has(p.device)) revoked.set(p.device, op.hlc);
        break;
      case 'policy.set':
        policy = mergePolicy(policy, p);
        break;
      case 'comment.add':
        if (typeof p.id === 'string' && !commentAuthors.has(p.id)) commentAuthors.set(p.id, op.act);
        break;
      case 'approval.add':
        if (typeof p.id === 'string' && !approvalAuthors.has(p.id)) {
          approvalAuthors.set(p.id, op.act);
        }
        break;
      case 'conflict.resolve': {
        const c = typeof p.conflict === 'string' ? p.conflict : '';
        const owner = !st.shared || roleOf(op.act) === 'owner';
        if (c.startsWith(RELEASE_PREFIX) && p.choice !== 'ours' && owner) {
          releases.add(c.slice(RELEASE_PREFIX.length));
        }
        break;
      }
      default:
        break;
    }
  };

  for (const node of index.nodes) {
    if (node.vc === null) continue;
    const r = refuse(node);
    if (r) {
      quarantined.set(node.op.id, { node, reason: r.reason, message: r.message });
      continue;
    }
    applyTeam(node);
    applied.push(node);
  }

  const released: string[] = [];
  for (const id of [...releases].sort()) {
    const q = quarantined.get(id);
    if (!q) continue;
    quarantined.delete(id);
    applied.push(q.node);
    released.push(id);
  }
  applied.sort((a, b) => a.order - b.order);

  return {
    applied,
    released,
    quarantined: [...quarantined.values()].map(({ node, reason, message }) => ({
      op: node.op.id,
      chain: node.op.chain,
      seq: node.op.seq,
      by: node.op.act,
      device: node.op.dev,
      hlc: node.op.hlc,
      kind: node.op.kind,
      target: node.op.target,
      reason,
      message,
    })),
    team: {
      shared: st.shared,
      ...(teamProjectId !== undefined ? { teamProjectId } : {}),
      members,
      revoked,
      policy: st.shared ? policy : null,
    },
    clock: [...clock.values()].sort((a, b) => (a.device < b.device ? -1 : 1)),
  };
}
