/**
 * Who may do what in one team project, as the server enforces it (M9 T7; the plan's roles table).
 * Membership comes from the project's own signed ops (`project.share`, `member.*`,
 * `device.revoke`, `policy.set`), evaluated at each op's clock reading (HLC), exactly as the
 * desktop quarantines in file mode. Where the journal has no member op for an actor, the role of
 * the invite they enrolled with applies (a "server grant"), so a person invited to the server can
 * work before an owner's app has added them.
 */
import { compareHlc } from '@aio/journal';
import {
  DeviceRevokePayload,
  MemberAddPayload,
  MemberRemovePayload,
  MemberRolePayload,
  OP_PERMISSION,
  PERMISSIONS,
  PolicySetPayload,
  ProjectSharePayload,
  type Member,
  type Op,
  type Permission,
  type Role,
} from '@aio/schema';

/** Op kinds that change who may do what. */
export const TEAM_KINDS = new Set([
  'project.share',
  'member.add',
  'member.role',
  'member.remove',
  'device.revoke',
  'policy.set',
]);

/** Before every real reading: the creator owns the history written before the project was shared. */
const BEGINNING = '0';

interface RoleEvent {
  hlc: string;
  actor: string;
  role: Role | null;
}

interface MemberInfo {
  actor: string;
  name: string;
  initials: string;
  email?: string;
  devices: Map<string, string>;
  addedBy: string;
  addedAt: string;
  certified: boolean;
}

interface PolicyEvent {
  hlc: string;
  viewersMayComment?: boolean;
  closeBy?: 'owner' | 'owner-or-reviewer';
}

const atOrBefore = (a: string, b: string) => compareHlc(a, b) <= 0;

export class TeamState {
  creator: string | null = null;
  private readonly roleEvents: RoleEvent[] = [];
  private readonly info = new Map<string, MemberInfo>();
  private readonly keys = new Map<string, { actor: string; key: string }>();
  private readonly revokes = new Map<string, string>();
  private readonly policies: PolicyEvent[] = [];

  /** Take in an accepted op (only the team kinds change anything). */
  apply(op: Op): void {
    if (!TEAM_KINDS.has(op.kind)) return;
    const payload: unknown = op.payload;
    switch (op.kind) {
      case 'project.share': {
        if (!ProjectSharePayload.safeParse(payload).success) return;
        if (this.creator === null) {
          this.creator = op.act;
          this.roleEvents.push({ hlc: BEGINNING, actor: op.act, role: 'owner' });
        }
        return;
      }
      case 'member.add': {
        const p = MemberAddPayload.safeParse(payload);
        if (!p.success) return;
        const m = p.data;
        const devices = new Map(this.info.get(m.actor)?.devices ?? []);
        for (const d of m.devices) {
          devices.set(d.id, d.key);
          this.keys.set(d.id, { actor: m.actor, key: d.key });
        }
        this.info.set(m.actor, {
          actor: m.actor,
          name: m.name,
          initials: m.initials,
          ...(m.email ? { email: m.email } : {}),
          devices,
          addedBy: op.act,
          addedAt: op.hlc,
          certified: m.cert !== undefined,
        });
        this.pushRole({ hlc: op.hlc, actor: m.actor, role: m.role });
        return;
      }
      case 'member.role': {
        const p = MemberRolePayload.safeParse(payload);
        if (p.success) this.pushRole({ hlc: op.hlc, actor: p.data.actor, role: p.data.role });
        return;
      }
      case 'member.remove': {
        const p = MemberRemovePayload.safeParse(payload);
        if (p.success) this.pushRole({ hlc: op.hlc, actor: p.data.actor, role: null });
        return;
      }
      case 'device.revoke': {
        const p = DeviceRevokePayload.safeParse(payload);
        if (!p.success) return;
        const before = this.revokes.get(p.data.device);
        if (!before || compareHlc(op.hlc, before) < 0) this.revokes.set(p.data.device, op.hlc);
        return;
      }
      case 'policy.set': {
        const p = PolicySetPayload.safeParse(payload);
        if (!p.success) return;
        const a = p.data.approval;
        this.policies.push({
          hlc: op.hlc,
          ...(a?.viewersMayComment !== undefined ? { viewersMayComment: a.viewersMayComment } : {}),
          ...(a?.closeBy !== undefined ? { closeBy: a.closeBy } : {}),
        });
        this.policies.sort((x, y) => compareHlc(x.hlc, y.hlc));
        return;
      }
      default:
        return;
    }
  }

  private pushRole(e: RoleEvent): void {
    this.roleEvents.push(e);
    this.roleEvents.sort((a, b) => compareHlc(a.hlc, b.hlc));
  }

  /** Does the journal name this actor at all (ever)? */
  inJournal(actor: string): boolean {
    return this.roleEvents.some((e) => e.actor === actor);
  }

  /** The actor's role in the journal at `hlc`; null when not a member then. */
  roleAt(actor: string, hlc: string): Role | null {
    let role: Role | null = null;
    for (const e of this.roleEvents) {
      if (!atOrBefore(e.hlc, hlc)) break;
      if (e.actor === actor) role = e.role;
    }
    return role;
  }

  /** The actor's role now (the latest member op). */
  roleNow(actor: string): Role | null {
    let role: Role | null = null;
    for (const e of this.roleEvents) if (e.actor === actor) role = e.role;
    return role;
  }

  /** A device key named by a `member.add` op. */
  deviceKey(device: string): { actor: string; key: string } | null {
    return this.keys.get(device) ?? null;
  }

  /** The reading at which the journal revoked a device; null when it did not. */
  revokedAt(device: string): string | null {
    return this.revokes.get(device) ?? null;
  }

  private policyAt(hlc: string): Required<Omit<PolicyEvent, 'hlc'>> {
    const out = { viewersMayComment: false, closeBy: 'owner' as 'owner' | 'owner-or-reviewer' };
    for (const p of this.policies) {
      if (!atOrBefore(p.hlc, hlc)) break;
      if (p.viewersMayComment !== undefined) out.viewersMayComment = p.viewersMayComment;
      if (p.closeBy !== undefined) out.closeBy = p.closeBy;
    }
    return out;
  }

  /** Does `role` hold `permission` at `hlc` (policy switches included)? */
  allows(role: Role, permission: Permission, hlc: string): boolean {
    const rule = PERMISSIONS[permission];
    if ((rule.roles as readonly Role[]).includes(role)) return true;
    if (!('policy' in rule)) return false;
    const policy = this.policyAt(hlc);
    if (rule.policy.switch === 'viewersMayComment')
      return policy.viewersMayComment && role === rule.policy.adds;
    return policy.closeBy === 'owner-or-reviewer' && role === rule.policy.adds;
  }

  /** The members named by the journal, as of now. */
  members(verification: (m: { devices: string[]; certified: boolean }) => Member['verification']) {
    const out: Member[] = [];
    for (const m of this.info.values()) {
      const role = this.roleNow(m.actor);
      if (role === null) continue;
      out.push({
        actor: m.actor,
        name: m.name,
        initials: m.initials,
        ...(m.email ? { email: m.email } : {}),
        role,
        devices: [...m.devices].map(([id, key]) => {
          const revokedAt = this.revokedAt(id);
          return { id, key, revoked: revokedAt !== null, ...(revokedAt ? { revokedAt } : {}) };
        }),
        verification: verification({ devices: [...m.devices.keys()], certified: m.certified }),
        addedBy: m.addedBy,
        addedAt: m.addedAt,
      });
    }
    return out.sort((a, b) => (a.actor < b.actor ? -1 : 1));
  }
}

/**
 * What an op needs, beyond its kind's permission: a client may post only client-visible comments
 * and acceptances; a client-visible comment needs `comment.client`, an acceptance `accept`.
 */
export function permissionFor(op: Op): Permission | null {
  const payload = (op.payload ?? {}) as { visibility?: unknown; decision?: unknown };
  if (op.kind === 'comment.add' && payload.visibility === 'client') return 'comment.client';
  if (op.kind === 'approval.add' && payload.decision === 'accept') return 'accept';
  if (op.kind in OP_PERMISSION) return OP_PERMISSION[op.kind as keyof typeof OP_PERMISSION];
  // a kind from a newer app: allowed to the roles that may edit
  return 'edit';
}

/** The only ops a client may send (the plan's roles table). */
export function clientMaySend(op: Op): boolean {
  const p = permissionFor(op);
  return p === 'comment.client' || p === 'accept';
}
