import {
  AccountLink,
  DEFAULT_TEAM_POLICY,
  DeviceRevokePayload,
  isKnownOpKind,
  MemberAddPayload,
  MemberRemovePayload,
  MemberRolePayload,
  Op,
  OP_PERMISSION,
  PERMISSIONS,
  PolicySetPayload,
  verifiedAtLeast,
  type DeviceCert,
  type Member,
  type Permission,
  type Role,
  type TeamPolicy,
  type VerificationLevel,
} from '@aio/schema';
import { contentHash, deviceIdFromKey } from './hash';
import { compareHlc } from './hlc';
import { checkOp, type OpCheck } from './op';
import { verifySignature, type Signer } from './sign';

/**
 * Members and roles (M9 stream T2, data-conventions section 18): the team as projected from the
 * `member.*`, `device.revoke` and `policy.set` ops, and the one permission check shared by the
 * desktop (UI gating, quarantine on import) and the team server (403). Pure: the same ops give the
 * same team whatever order they arrive in, because they are replayed in clock order.
 *
 * In file and hub mode roles are advisory but tamper-evident: anyone with write access to the
 * folder can edit files, but an op beyond its author's role, from a stranger, from a revoked
 * device, unsigned or edited after it was written is held, and the verdict says why.
 */

/** Why an op is held. Each comes with a sentence a person can read. */
export type RefusalCode =
  | 'not-member'
  | 'role'
  | 'verification'
  | 'revoked-device'
  | 'unknown-device'
  | 'unsigned'
  | 'bad-signature'
  | 'edited'
  | 'bad-certificate'
  | 'last-owner'
  | 'invalid';

export type Verdict = { ok: true } | { ok: false; code: RefusalCode; reason: string };

interface MemberState {
  actor: string;
  name: string;
  initials: string;
  email?: string;
  role: Role;
  verification: VerificationLevel;
  addedBy: string;
  addedAt: string;
  account?: AccountLink;
  removed: boolean;
}

interface DeviceState {
  actor: string;
  key: string;
  revokedAt?: string;
}

/** The team at one clock reading. Built by `replayTeam`; read by `canApply`. */
export interface TeamState {
  members: Map<string, MemberState>;
  devices: Map<string, DeviceState>;
  policy: TeamPolicy;
}

export function emptyTeam(): TeamState {
  return { members: new Map(), devices: new Map(), policy: DEFAULT_TEAM_POLICY };
}

/** A project is shared once it has a member; a project that is not shared has no roles. */
export function isShared(state: TeamState): boolean {
  return state.members.size > 0;
}

// ---------------------------------------------------------------- initials

const ARTICLE = 'ال';

function lettersOf(word: string): string[] {
  return Array.from(word.matchAll(/\p{L}/gu), (m) => m[0]);
}

function upperFirst(letter: string): string {
  return /^./su.exec(letter.toUpperCase())?.[0] ?? letter;
}

/**
 * Initials from a name: the first letters of the first and last words (any script; the Arabic
 * article "ال" is skipped), two letters of a single name, "X" when the name has no letter.
 */
export function deriveInitials(name: string): string {
  const words = name
    .trim()
    .split(/[\s\-_.]+/u)
    .map((w) => {
      const letters = lettersOf(w);
      const joined = letters.join('');
      return joined.startsWith(ARTICLE) && letters.length > 2 ? letters.slice(2) : letters;
    })
    .filter((l) => l.length > 0);
  const first = words[0];
  if (!first) return 'X';
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const picked = last ? [first[0], last[0]] : first.slice(0, 2);
  return picked
    .filter((l): l is string => l !== undefined)
    .map(upperFirst)
    .join('');
}

/** Initials unique within a team: a digit 2 to 9 is added when they are taken. */
export function uniqueInitials(initials: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(initials)) return initials;
  const base = initials.replace(/\d$/u, '');
  if (!used.has(base)) return base;
  for (let d = 2; d <= 9; d += 1) {
    const candidate = `${base}${String(d)}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}9`;
}

// ---------------------------------------------------------------- permissions

/** The permission an op kind needs; a kind from a newer version needs edit rights. */
export function permissionFor(kind: string): Permission | null {
  return isKnownOpKind(kind) ? OP_PERMISSION[kind] : 'edit';
}

/** The roles that hold a permission under a team policy (the policy switches add one role). */
export function rolesFor(permission: Permission, policy: TeamPolicy): Role[] {
  const rule: { roles: readonly Role[]; policy?: { switch: string; adds: Role } } =
    PERMISSIONS[permission];
  const roles = [...rule.roles];
  const extra = rule.policy;
  if (extra) {
    const on =
      extra.switch === 'viewersMayComment'
        ? policy.approval.viewersMayComment
        : policy.approval.closeBy === 'owner-or-reviewer';
    if (on && !roles.includes(extra.adds)) roles.push(extra.adds);
  }
  return roles;
}

export function permits(role: Role, permission: Permission, policy: TeamPolicy): boolean {
  return rolesFor(permission, policy).includes(role);
}

const ARTICLES: Record<Role, string> = {
  owner: 'an owner',
  reviewer: 'a reviewer',
  viewer: 'a viewer',
  client: 'a client',
};

const ACTIONS: Record<Permission, string> = {
  read: 'open the project',
  'comment.team': 'comment for the team',
  'comment.client': 'comment for the client',
  accept: 'record client acceptance',
  edit: 'edit',
  assign: 'assign work',
  approve: 'approve',
  'close-approved': 'close or reopen an approved issue',
  'builder.edit': 'change layers, imports and pipelines',
  'builder.georef': 'change the coordinate system, origin or datum',
  admin: 'change members, roles, devices and the team policy',
  'export.package': 'export a customer package',
  'export.audit': 'export the audit',
  verify: 'verify the history',
};

function listOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? 'nobody';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1] ?? ''}`;
}

/** "Omar Sample is a viewer in this project. Only an owner or a reviewer can edit." */
export function roleRefusal(
  name: string,
  role: Role,
  permission: Permission,
  policy: TeamPolicy,
): string {
  const who = listOr(rolesFor(permission, policy).map((r) => ARTICLES[r]));
  return `${name} is ${ARTICLES[role]} in this project. Only ${who} can ${ACTIONS[permission]}.`;
}

function refuse(code: RefusalCode, reason: string): Verdict {
  return { ok: false, code, reason };
}

/** Who an actor is, for messages. */
function nameOf(state: TeamState, actor: string): string {
  return state.members.get(actor)?.name ?? 'Someone outside the team';
}

/**
 * May this op apply to the team as it is? `check` is what the op says about itself (`checkOp`);
 * without it, hashes and signatures are taken as checked elsewhere (Verify, the server).
 */
export function canApply(op: Op, state: TeamState, check?: OpCheck): Verdict {
  if (!isShared(state)) return { ok: true };
  const device = state.devices.get(op.dev);
  if (!device) {
    return refuse(
      'not-member',
      `This change comes from a device that is not part of the team (${nameOf(state, op.act)}).`,
    );
  }
  if (device.actor !== op.act) {
    return refuse(
      'unknown-device',
      `This change claims to be by ${nameOf(state, op.act)} but comes from a device of ${nameOf(state, device.actor)}.`,
    );
  }
  const member = state.members.get(op.act);
  if (!member || member.removed) {
    return refuse('not-member', `${nameOf(state, op.act)} is not a member of this project.`);
  }
  if (device.revokedAt !== undefined && compareHlc(op.hlc, device.revokedAt) > 0) {
    return refuse(
      'revoked-device',
      `This change was made on a device of ${member.name} after an owner revoked it.`,
    );
  }
  if (check) {
    if (!check.id) {
      return refuse('edited', 'This change was edited after it was written, so it does not count.');
    }
    if (check.signature === null) {
      return refuse(
        'unsigned',
        'This change is not signed, so it cannot be checked against the role of its author.',
      );
    }
    if (!check.signature) {
      return refuse(
        'bad-signature',
        `The signature of this change does not match ${member.name}'s device.`,
      );
    }
  }
  const permission = permissionFor(op.kind);
  if (permission === null) return { ok: true };
  if (
    member.role !== 'owner' &&
    !verifiedAtLeast(member.verification, state.policy.minVerification)
  ) {
    return refuse(
      'verification',
      `${member.name}'s identity is ${member.verification === 'self' ? 'self-asserted' : `verified by ${member.verification}`}. This project needs members certified by an owner or better.`,
    );
  }
  if (!permits(member.role, permission, state.policy)) {
    return refuse('role', roleRefusal(member.name, member.role, permission, state.policy));
  }
  return { ok: true };
}

// ---------------------------------------------------------------- certificates

function certHash(cert: Omit<DeviceCert, 'sig'> & { sig?: string }): string {
  return contentHash({ ...cert, sig: undefined });
}

/** An owner certificate: the issuer's device says `device` belongs to `actor` (`aio.cert/1`). */
export function certifyDevice(
  issuer: Signer,
  issuerActor: string,
  actor: string,
  device: string,
  issuedAt: string,
): DeviceCert {
  const body = {
    level: 'owner' as const,
    issuer: { actor: issuerActor, device: issuer.device },
    actor,
    device,
    issuedAt,
  };
  return { ...body, sig: issuer.sign('aio.cert/1', certHash(body)) };
}

/** Check a certificate's signature with the issuer device's raw public key. */
export function verifyCert(cert: DeviceCert, issuerKey: string): boolean {
  return verifySignature(issuerKey, 'aio.cert/1', certHash(cert), cert.sig);
}

function keyMatchesDevice(id: string, key: string): boolean {
  try {
    return deviceIdFromKey(Buffer.from(key, 'base64url')) === id;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- replay

const TEAM_KINDS = new Set([
  'member.add',
  'member.role',
  'member.remove',
  'member.link',
  'device.revoke',
  'policy.set',
]);

/** Owners left with at least one device that is not revoked. */
function activeOwners(state: TeamState): string[] {
  return [...state.members.values()]
    .filter((m) => !m.removed && m.role === 'owner')
    .filter((m) =>
      [...state.devices.values()].some((d) => d.actor === m.actor && d.revokedAt === undefined),
    )
    .map((m) => m.actor);
}

function cloneTeam(state: TeamState): TeamState {
  return {
    members: new Map([...state.members].map(([k, v]) => [k, { ...v }])),
    devices: new Map([...state.devices].map(([k, v]) => [k, { ...v }])),
    policy: state.policy,
  };
}

const LAST_OWNER = refuse(
  'last-owner',
  'A shared project keeps at least one owner with a working device. Make someone else an owner first.',
);

/** Apply one team op to a copy of the state; the copy, or why the op does not apply. */
function applyTeamOp(state: TeamState, op: Op): TeamState | Verdict {
  const next = cloneTeam(state);
  const invalid = refuse('invalid', 'This team change is not readable by this version.');
  switch (op.kind) {
    case 'member.add': {
      const p = MemberAddPayload.safeParse(op.payload);
      if (!p.success) return invalid;
      const add = p.data;
      for (const d of add.devices) {
        if (!keyMatchesDevice(d.id, d.key)) {
          return refuse('invalid', 'A device in this team change does not match its key.');
        }
        const owner = next.devices.get(d.id);
        if (owner && owner.actor !== add.actor) {
          return refuse('invalid', `This device already belongs to ${nameOf(next, owner.actor)}.`);
        }
      }
      let verification: VerificationLevel = 'self';
      if (add.cert) {
        const key = next.devices.get(op.dev)?.key;
        const ok =
          add.cert.level === 'owner' &&
          add.cert.issuer.device === op.dev &&
          add.cert.actor === add.actor &&
          add.devices.some((d) => d.id === add.cert?.device) &&
          key !== undefined &&
          verifyCert(add.cert, key);
        if (!ok) {
          return refuse(
            'bad-certificate',
            `The owner certificate for ${add.name} does not verify, so ${add.name} was not added.`,
          );
        }
        verification = 'owner';
      }
      const before = next.members.get(add.actor);
      const taken = [...next.members.values()]
        .filter((m) => !m.removed && m.actor !== add.actor)
        .map((m) => m.initials);
      const keep = before && !before.removed;
      next.members.set(add.actor, {
        actor: add.actor,
        name: add.name,
        initials: keep ? before.initials : uniqueInitials(add.initials, taken),
        ...(add.email ? { email: add.email } : {}),
        role: add.role,
        verification:
          keep && verifiedAtLeast(before.verification, verification)
            ? before.verification
            : verification,
        addedBy: keep ? before.addedBy : op.act,
        addedAt: keep ? before.addedAt : op.hlc,
        ...(keep && before.account ? { account: before.account } : {}),
        removed: false,
      });
      for (const d of add.devices) {
        if (!next.devices.has(d.id)) next.devices.set(d.id, { actor: add.actor, key: d.key });
      }
      if (before?.role === 'owner' && add.role !== 'owner' && activeOwners(next).length === 0) {
        return LAST_OWNER;
      }
      return next;
    }
    case 'member.role': {
      const p = MemberRolePayload.safeParse(op.payload);
      if (!p.success) return invalid;
      const m = next.members.get(p.data.actor);
      if (!m || m.removed) return refuse('invalid', 'This person is not a member of the project.');
      m.role = p.data.role;
      return activeOwners(next).length === 0 ? LAST_OWNER : next;
    }
    case 'member.remove': {
      const p = MemberRemovePayload.safeParse(op.payload);
      if (!p.success) return invalid;
      const m = next.members.get(p.data.actor);
      if (!m || m.removed) return refuse('invalid', 'This person is not a member of the project.');
      m.removed = true;
      return activeOwners(next).length === 0 ? LAST_OWNER : next;
    }
    case 'member.link': {
      const p = AccountLink.safeParse(op.payload);
      if (!p.success) return invalid;
      const m = next.members.get(p.data.actor);
      if (!m || m.removed) return refuse('invalid', 'This person is not a member of the project.');
      // Reserved for M10: kept and shown; the account issuer's certificate is checked from M10 on.
      m.account = p.data;
      return next;
    }
    case 'device.revoke': {
      const p = DeviceRevokePayload.safeParse(op.payload);
      if (!p.success) return invalid;
      const d = next.devices.get(p.data.device);
      if (!d) return refuse('invalid', 'This device is not part of the team.');
      d.revokedAt ??= op.hlc;
      return activeOwners(next).length === 0 ? LAST_OWNER : next;
    }
    case 'policy.set': {
      const p = PolicySetPayload.safeParse(op.payload);
      if (!p.success) return invalid;
      // Only the fields the op names change (a partial policy never resets the others).
      const named = (op.payload as { approval?: Record<string, unknown> }).approval ?? {};
      const changes = Object.fromEntries(
        Object.entries(p.data.approval ?? {}).filter(([k, v]) => k in named && v !== undefined),
      );
      next.policy = {
        approval: { ...next.policy.approval, ...changes },
        minVerification: p.data.minVerification ?? next.policy.minVerification,
        packageHistory: p.data.packageHistory ?? next.policy.packageHistory,
      };
      return next;
    }
    default:
      return next;
  }
}

/** The first member: the owner who shares the project adds themself with their own device. */
function bootstrap(op: Op, raw: Record<string, unknown>): Verdict {
  const p = MemberAddPayload.safeParse(op.payload);
  const first = p.success ? p.data : null;
  const device = first?.devices.find((d) => d.id === op.dev);
  if (first?.actor !== op.act || first.role !== 'owner' || !device) {
    return refuse(
      'not-member',
      'The first member of a team must be the owner who shares the project, added from their own device.',
    );
  }
  const check = checkOp(raw, device.key);
  if (!check.id) return refuse('edited', 'This change was edited after it was written.');
  if (check.signature !== true) {
    return refuse('unsigned', 'The change that shared this project is not signed by its owner.');
  }
  return { ok: true };
}

export interface TeamReplay {
  shared: boolean;
  state: TeamState;
  members: Member[];
  policy: TeamPolicy;
  /** Verdict per op id: team ops always, every op with `verdicts: 'all'`. */
  verdicts: Map<string, Verdict>;
  /** The ops that are held (kept, not applied), in clock order. */
  quarantined: {
    op: string;
    kind: string;
    act: string;
    hlc: string;
    code: RefusalCode;
    reason: string;
  }[];
}

/**
 * Replay ops in clock order (ties by id) into the team, judging each op against the team at its
 * clock reading. `verdicts: 'all'` also judges every other op (quarantine on import); the default
 * judges the team ops only, which is what the members list needs.
 */
export function replayTeam(
  raws: readonly Record<string, unknown>[],
  opts: { verdicts?: 'team' | 'all' } = {},
): TeamReplay {
  const all = opts.verdicts === 'all';
  const seen = new Set<string>();
  const ops: { op: Op; raw: Record<string, unknown> }[] = [];
  for (const raw of raws) {
    const parsed = Op.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    if (all || TEAM_KINDS.has(parsed.data.kind)) ops.push({ op: parsed.data, raw });
  }
  ops.sort((a, b) => compareHlc(a.op.hlc, b.op.hlc) || (a.op.id < b.op.id ? -1 : 1));

  let state = emptyTeam();
  const verdicts = new Map<string, Verdict>();
  const quarantined: TeamReplay['quarantined'] = [];
  for (const { op, raw } of ops) {
    const team = TEAM_KINDS.has(op.kind);
    let verdict: Verdict;
    if (!isShared(state)) {
      verdict = op.kind === 'member.add' ? bootstrap(op, raw) : { ok: true };
      if (verdict.ok && team && op.kind !== 'member.add') {
        verdict = refuse(
          'not-member',
          'This project is not shared yet, so it has no team to change.',
        );
      }
    } else {
      verdict = canApply(op, state, checkOp(raw, state.devices.get(op.dev)?.key));
    }
    if (verdict.ok && team) {
      const next = applyTeamOp(state, op);
      if ('members' in next) state = next;
      else verdict = next;
    }
    verdicts.set(op.id, verdict);
    if (!verdict.ok) {
      quarantined.push({
        op: op.id,
        kind: op.kind,
        act: op.act,
        hlc: op.hlc,
        code: verdict.code,
        reason: verdict.reason,
      });
    }
  }
  return {
    shared: isShared(state),
    state,
    members: membersOf(state),
    policy: state.policy,
    verdicts,
    quarantined,
  };
}

/** The members list (members:list), in the order they joined. */
export function membersOf(state: TeamState): Member[] {
  return [...state.members.values()]
    .filter((m) => !m.removed)
    .sort((a, b) => compareHlc(a.addedAt, b.addedAt) || (a.actor < b.actor ? -1 : 1))
    .map((m) => ({
      actor: m.actor,
      name: m.name,
      initials: m.initials,
      ...(m.email ? { email: m.email } : {}),
      role: m.role,
      devices: [...state.devices]
        .filter(([, d]) => d.actor === m.actor)
        .map(([id, d]) => ({
          id,
          key: d.key,
          revoked: d.revokedAt !== undefined,
          ...(d.revokedAt !== undefined ? { revokedAt: d.revokedAt } : {}),
        })),
      verification: m.verification,
      addedBy: m.addedBy,
      addedAt: m.addedAt,
      ...(m.account ? { account: m.account } : {}),
    }));
}
