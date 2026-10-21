import {
  AccountLink,
  DEFAULT_TEAM_POLICY,
  DeviceRevokePayload,
  GEOREF_FIELDS,
  isKnownOpKind,
  MemberAddPayload,
  MemberRemovePayload,
  MemberRolePayload,
  Op,
  OP_PERMISSION,
  permits,
  PolicySetPayload,
  Role,
  roleRefusal,
  verifiedAtLeast,
  type DeviceCert,
  type Member,
  type Permission,
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
  | 'clock-back'
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

/**
 * What a copy pins about its team when the project is shared (`team.json` `genesis`): the op that
 * made the first owner, its clock reading, and the history the project was shared with (the last
 * seq of each chain at that moment). With a pin, no other op can make itself the first owner, and
 * an op dated before the share that is not part of that history is judged as if written after it.
 */
export interface TeamPin {
  /** Id of the owner's first `member.add`. */
  op: string;
  /** Its clock reading. */
  at: string;
  /** Last seq per chain of the history before the share. */
  heads: Readonly<Record<string, number>>;
}

/** The team at one clock reading. Built by `replayTeam`; read by `canApply`. */
export interface TeamState {
  members: Map<string, MemberState>;
  devices: Map<string, DeviceState>;
  policy: TeamPolicy;
  /** The pinned genesis, when this copy has one (absent: a project shared by an older version). */
  pin?: TeamPin;
}

export function emptyTeam(pin?: TeamPin | null): TeamState {
  return {
    members: new Map(),
    devices: new Map(),
    policy: DEFAULT_TEAM_POLICY,
    ...(pin ? { pin } : {}),
  };
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

export { GEOREF_FIELDS, permits, roleRefusal, rolesFor } from '@aio/schema';

const asObj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * The permission an op needs. The kind decides, refined by the payload where the plan's roles
 * table does: a manifest change of the coordinate system, origin or datum is `builder.georef`; a
 * status step out of or back to approved is `close-approved`; a client-visible comment is
 * `comment.client`; a client acceptance is `accept`. A kind from a newer version needs edit
 * rights. Null: no permission needed (events about the op's own chain).
 */
export function permissionFor(kind: string, payload?: unknown): Permission | null {
  const p = asObj(payload);
  if (kind === 'record.external') return 'patch' in p ? 'edit' : null;
  if (!isKnownOpKind(kind)) return 'edit';
  if (kind === 'manifest.entry') {
    const touched = [
      ...Object.keys(asObj(p.set)),
      ...(Array.isArray(p.unset) ? p.unset.map(String) : []),
    ];
    if (touched.some((f) => (GEOREF_FIELDS as readonly string[]).includes(f))) {
      return 'builder.georef';
    }
  }
  if (kind === 'issue.status') {
    const pair = `${String(p.from)}>${String(p.to)}`;
    if (pair === 'approved>closed' || pair === 'closed>approved') return 'close-approved';
  }
  if (kind === 'comment.add' && p.visibility === 'client') return 'comment.client';
  if (kind === 'approval.add' && p.decision === 'accept') return 'accept';
  return OP_PERMISSION[kind];
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
  // the replay judges ops in team order (`orderForTeam`): an op judged after the revocation is
  // later than it, or was moved after it because the owner who revoked had not seen it
  if (device.revokedAt !== undefined) {
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
  const permission = permissionFor(op.kind, op.payload);
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
    ...(state.pin ? { pin: state.pin } : {}),
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
function bootstrap(op: Op, raw: Record<string, unknown>, pin?: TeamPin): Verdict {
  if (pin && op.id !== pin.op) {
    return refuse(
      'not-member',
      'This change claims to make the first owner of the team, but it is not the change this copy recorded when the project was shared.',
    );
  }
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

/** Is the op part of the history a pin says the project was shared with? */
function pinned(pin: TeamPin, op: Op): boolean {
  return op.id === pin.op || (pin.heads[op.chain] ?? 0) >= op.seq;
}

/** Team ops: they change the members, devices or policy when they apply. */
export function isTeamKind(kind: string): boolean {
  return TEAM_KINDS.has(kind);
}

/**
 * One step of the replay: the verdict on `op` against the team as it is, and the team after it
 * (unchanged unless a team op applied). The merge engine's quarantine gate walks ops with it in
 * the same team order (`orderForTeam`), so desktop and merge judge every op the same way.
 */
export function judgeOp(
  state: TeamState,
  op: Op,
  raw: Record<string, unknown>,
): { verdict: Verdict; state: TeamState } {
  const team = TEAM_KINDS.has(op.kind);
  let verdict: Verdict;
  if (!isShared(state)) {
    if (state.pin && !pinned(state.pin, op)) {
      // not the history the project was shared with, and no team to judge it by yet
      verdict = refuse(
        'not-member',
        'This change is not part of the history this project was shared with, and it does not come from a member of the team.',
      );
    } else {
      verdict = op.kind === 'member.add' ? bootstrap(op, raw, state.pin) : { ok: true };
    }
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
    if ('members' in next) return { verdict, state: next };
    return { verdict: next, state };
  }
  return { verdict, state };
}

// ---------------------------------------------------------------- team order

/**
 * A team change that says which ops of its target its author had seen (`seen`: last seq per
 * chain): a revocation, a removal or a demotion, and the pinned genesis for every device. An op of
 * the target it does not cover and dated before it is judged right after it, so a revoked, removed
 * or demoted person cannot write "earlier" ops, or open a new chain dated earlier, to dodge it.
 */
export interface TeamFence {
  /** The fencing op (the genesis for a pin). */
  id: string;
  hlc: string;
  /** Whose ops it fences: devices, an actor, or everyone (`all`, the genesis). */
  devices: readonly string[];
  actor?: string;
  all?: boolean;
  /** Last seq per chain its author had seen. */
  seen: Readonly<Record<string, number>>;
}

const before = (a: { hlc: string; id: string }, b: { hlc: string; id: string }): number =>
  compareHlc(a.hlc, b.hlc) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function fences(fence: TeamFence, op: Op): boolean {
  if (fence.id === op.id) return false;
  if (!(fence.all === true || fence.devices.includes(op.dev) || fence.actor === op.act)) {
    return false;
  }
  if ((fence.seen[op.chain] ?? 0) >= op.seq) return false;
  return before(fence, op) > 0;
}

/**
 * Ops in the order the team judges them: clock order (ties by id), except that an op a fence did
 * not see and that is dated before it comes right after the latest such fence. Pure and the same
 * for any arrival order, so every copy judges the same way.
 */
export function orderForTeam<T>(
  items: readonly T[],
  opOf: (item: T) => Op,
  fenceList: readonly TeamFence[],
): T[] {
  const keyed = items.map((item) => {
    const op = opOf(item);
    let anchor: TeamFence | null = null;
    for (const f of fenceList) {
      if (fences(f, op) && (!anchor || before(f, anchor) > 0)) anchor = f;
    }
    return { item, op, at: anchor ?? op, moved: anchor ? 1 : 0 };
  });
  keyed.sort((a, b) => before(a.at, b.at) || a.moved - b.moved || before(a.op, b.op));
  return keyed.map((k) => k.item);
}

const CHAIN_ID = /^d_[a-z2-7]{52}\.r_[a-z2-7]{16}$/;

const ROLE_RANK: Record<Role, number> = { owner: 3, reviewer: 2, viewer: 1, client: 1 };

function seenOf(payload: unknown): Record<string, number> | null {
  const seen = asObj(payload).seen;
  if (seen === undefined || seen === null || typeof seen !== 'object' || Array.isArray(seen)) {
    return null;
  }
  const out: Record<string, number> = {};
  for (const [chain, seq] of Object.entries(seen as Record<string, unknown>)) {
    // chain ids only: a key such as `__proto__` is not a chain and never a field
    if (!CHAIN_ID.test(chain)) continue;
    if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0) out[chain] = seq;
  }
  return out;
}

/** The fence an applied team op sets, judged against the team just before it. */
function fenceOf(prev: TeamState, op: Op): TeamFence | null {
  const seen = seenOf(op.payload);
  if (!seen) return null;
  const p = asObj(op.payload);
  const devicesOf = (actor: string) =>
    [...prev.devices].filter(([, d]) => d.actor === actor).map(([id]) => id);
  if (op.kind === 'device.revoke' && typeof p.device === 'string') {
    return { id: op.id, hlc: op.hlc, devices: [p.device], seen };
  }
  if (op.kind === 'member.remove' && typeof p.actor === 'string') {
    return { id: op.id, hlc: op.hlc, devices: devicesOf(p.actor), actor: p.actor, seen };
  }
  if (op.kind === 'member.role' && typeof p.actor === 'string') {
    const was = prev.members.get(p.actor)?.role;
    const role = Role.safeParse(p.role);
    // a promotion fences nothing: ops before it keep the role they were written under
    if (!was || !role.success || role.data === was || ROLE_RANK[role.data] > ROLE_RANK[was]) {
      return null;
    }
    return { id: op.id, hlc: op.hlc, devices: devicesOf(p.actor), actor: p.actor, seen };
  }
  return null;
}

/** The genesis as a fence over every device: ops before it must be the history it pinned. */
function genesisFence(pin: TeamPin): TeamFence {
  return { id: pin.op, hlc: pin.at, devices: [], all: true, seen: pin.heads };
}

/** The pin for a genesis op among `raws`: its clock reading and the history before it. */
export function pinOf(raws: readonly Record<string, unknown>[], genesis: string): TeamPin | null {
  const ops: Op[] = [];
  for (const raw of raws) {
    const p = Op.safeParse(raw);
    if (p.success) ops.push(p.data);
  }
  const g = ops.find((o) => o.id === genesis);
  if (!g) return null;
  const byChain = new Map<string, Op[]>();
  for (const o of ops) {
    const list = byChain.get(o.chain) ?? [];
    list.push(o);
    byChain.set(o.chain, list);
  }
  const heads: Record<string, number> = {};
  for (const [chain, list] of byChain) {
    list.sort((a, b) => a.seq - b.seq);
    let head = 0;
    for (const o of list) {
      if (o.seq !== head + 1 || before(o, g) > 0) break;
      head = o.seq;
    }
    if (head > 0) heads[chain] = head;
  }
  return { op: g.id, at: g.hlc, heads };
}

/** An op whose clock reading is not after the op before it in its chain (a backdated op). */
export function clockGoesBack(op: Op, prevHlc: string | undefined): Verdict | null {
  if (prevHlc === undefined || compareHlc(op.hlc, prevHlc) > 0) return null;
  return refuse(
    'clock-back',
    'The clock reading of this change is earlier than the change before it from the same device, so it was dated back.',
  );
}

export interface TeamReplay {
  shared: boolean;
  state: TeamState;
  members: Member[];
  policy: TeamPolicy;
  /** Verdict per op id: team ops always, every op with `verdicts: 'all'`. */
  verdicts: Map<string, Verdict>;
  /** The op that made the first owner (the genesis), when the project is shared. */
  genesis?: string;
  /** The ops that are held (kept, not applied), in team order. */
  quarantined: {
    op: string;
    kind: string;
    act: string;
    hlc: string;
    code: RefusalCode;
    reason: string;
  }[];
}

interface Entry {
  op: Op;
  raw: Record<string, unknown>;
}

/** Judge entries already in team order: the team, the verdicts and the fences that applied. */
function judgeAll(entries: readonly Entry[], pin: TeamPin | null, hlcOf: Map<string, string>) {
  let state = emptyTeam(pin);
  const verdicts = new Map<string, Verdict>();
  const quarantined: TeamReplay['quarantined'] = [];
  const applied: TeamFence[] = [];
  let genesis: string | undefined;
  for (const { op, raw } of entries) {
    const back = clockGoesBack(op, op.prev === null ? undefined : hlcOf.get(op.prev));
    const step = back ? { verdict: back, state } : judgeOp(state, op, raw);
    const verdict = step.verdict;
    if (verdict.ok && TEAM_KINDS.has(op.kind)) {
      const f = fenceOf(state, op);
      if (f) applied.push(f);
    }
    if (genesis === undefined && !isShared(state) && isShared(step.state)) genesis = op.id;
    state = step.state;
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
  return { state, verdicts, quarantined, fences: applied, genesis };
}

/**
 * The ops to judge (parsed; `keep` picks which by kind) and every op's clock reading by id, read
 * from the raw lines (a chain's predecessor may be any kind).
 */
function entriesOf(raws: readonly Record<string, unknown>[], keep: (kind: string) => boolean) {
  const seen = new Set<string>();
  const entries: Entry[] = [];
  const hlcOf = new Map<string, string>();
  for (const raw of raws) {
    if (typeof raw.id !== 'string' || seen.has(raw.id)) continue;
    if (typeof raw.hlc === 'string') hlcOf.set(raw.id, raw.hlc);
    if (typeof raw.kind !== 'string' || !keep(raw.kind)) continue;
    const parsed = Op.safeParse(raw);
    if (!parsed.success) continue;
    seen.add(parsed.data.id);
    entries.push({ op: parsed.data, raw });
  }
  return { entries, hlcOf };
}

const teamKind = (kind: string) => TEAM_KINDS.has(kind);

const fenceKey = (fs: readonly TeamFence[]) =>
  fs
    .map((f) => f.id)
    .sort()
    .join(',');

function fencesOf(
  entries: readonly Entry[],
  pin: TeamPin | null,
  hlcOf: Map<string, string>,
): TeamFence[] {
  const team = entries.filter((e) => teamKind(e.op.kind));
  const base = pin ? [genesisFence(pin)] : [];
  let current: TeamFence[] = base;
  for (let round = 0; round < 8; round += 1) {
    const ordered = orderForTeam(team, (e) => e.op, current);
    const next = [...base, ...judgeAll(ordered, pin, hlcOf).fences];
    if (fenceKey(next) === fenceKey(current)) return next;
    current = next;
  }
  return current;
}

/**
 * The fences of a history: the pinned genesis, and each revocation, removal or demotion that
 * applies and says what its author had seen. Which of those apply depends on the order, which
 * depends on the fences, so the team ops are replayed until the set no longer changes (a few
 * rounds at most; the same for the same ops in any order).
 */
export function teamFences(
  raws: readonly Record<string, unknown>[],
  pin?: TeamPin | null,
): TeamFence[] {
  const { entries, hlcOf } = entriesOf(raws, teamKind);
  return fencesOf(entries, pin ?? null, hlcOf);
}

/**
 * Replay ops in team order (`orderForTeam`) into the team, judging each op against the team at its
 * place. `verdicts: 'all'` also judges every other op (quarantine on import); the default judges
 * the team ops only, which is what the members list needs. `pin`: the genesis this copy pinned.
 */
export function replayTeam(
  raws: readonly Record<string, unknown>[],
  opts: { verdicts?: 'team' | 'all'; pin?: TeamPin | null } = {},
): TeamReplay {
  const pin = opts.pin ?? null;
  const { entries, hlcOf } = entriesOf(raws, opts.verdicts === 'all' ? () => true : teamKind);
  const fenceList = fencesOf(entries, pin, hlcOf);
  const { state, verdicts, quarantined, genesis } = judgeAll(
    orderForTeam(entries, (e) => e.op, fenceList),
    pin,
    hlcOf,
  );
  return {
    shared: isShared(state),
    ...(genesis !== undefined ? { genesis } : {}),
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
