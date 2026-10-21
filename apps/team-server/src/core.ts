/**
 * What the Team Server does, without HTTP: check and store pushed ops, countersign them, page
 * them out, enrol devices and list members. It stores and forwards; it never merges, so the
 * server and the app cannot disagree on state.
 *
 * Who a device is (security review 2026-10-21): a device is bound to the actor it enrolled as only
 * when that actor was new to this server, or with a certificate from one of that person's devices
 * or from an owner. A project's journal has the last word: where it names the actor, a device the
 * journal does not list for that actor (and that no valid certificate vouches for) gets nothing
 * of the journal's role, and its ops do not verify as that actor's.
 */
import {
  checkOp,
  compareHlc,
  parseHlc,
  pinFromGenesis,
  verifyCert,
  verifySignature,
} from '@aio/journal';
import {
  CLOCK_AHEAD_HOLD_MS,
  EnrolRequest,
  Op,
  OP_PAYLOADS,
  ProjectSharePayload,
  TEAM_SCHEMA,
  type DeviceRecord,
  type EnrolResponse,
  type Member,
  type PushResult,
  type Receipt,
  type RefusalCode,
  type Role,
  type TeamGenesis,
  type TeamProject,
} from '@aio/schema';
import { checkDeviceRecord, inviteHash, serverCert } from './auth/enrol';
import type { ServerIdentity } from './identity';
import { makeReceipt } from './receipts';
import { ProjectTeam, REFUSAL_CODES } from './team';
import { decodeSince, encodeCursor, sinceFor } from './since';
import type { EnrolledDevice, Store } from './store/store';

/** An answer the HTTP layer turns into a status and `{ error, code }`. */
export class ServerRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServerRefusal';
  }
}

export interface CoreOptions {
  store: Store;
  identity: ServerIdentity;
  /** Shown to people at enrolment. */
  name: string;
  version: string;
  /** SHA-256 of the TLS certificate people see (64 zeros when TLS ends at a proxy we do not know). */
  fingerprint: string;
  now?: () => Date;
}

const READ_ROLES: readonly Role[] = ['owner', 'reviewer', 'viewer'];
const EDIT_ROLES: readonly Role[] = ['owner', 'reviewer'];

/** How many certificates deep a binding may be vouched for (device by device). */
const MAX_CERT_DEPTH = 4;

/** One write at a time: ops, receipts and the roles cache stay in step. */
function mutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };
}

const refuse = (id: string, code: RefusalCode, message: string) => ({ id, code, message });

type Devices = ReadonlyMap<string, EnrolledDevice>;

/** The role an enrolled device's invite gives in a project; null when it gives none. */
const grant = (d: EnrolledDevice, projectId: string | null): Role | null =>
  d.revokedAt === null && (d.project === null || d.project === projectId) ? d.role : null;

/**
 * Does the project accept this device as its actor? Yes when the journal lists the device for the
 * actor (or it shared the project), when the journal does not name the actor at all (the invite
 * decides), or when a certificate vouches for it: one of the person's own devices that holds, or
 * a device of someone who is an owner of this project now. Never when the journal gives the
 * device to someone else.
 */
export function bindingHolds(
  d: EnrolledDevice,
  t: ProjectTeam,
  devices: Devices,
  depth = 0,
): boolean {
  const listed = t.deviceKey(d.device);
  if (listed) return listed.actor === d.actor && listed.key === d.key;
  if (t.binds(d.actor, d.device)) return true;
  if (!t.inJournal(d.actor)) return true;
  const c = d.certifiedBy;
  if (!c || depth >= MAX_CERT_DEPTH) return false;
  const issuer = devices.get(c.device);
  if (issuer?.actor !== c.actor || issuer.revokedAt !== null) return false;
  if (t.revokedAt(issuer.device) !== null) return false;
  if (!bindingHolds(issuer, t, devices, depth + 1)) return false;
  return c.actor === d.actor || t.roleNow(c.actor) === 'owner';
}

/** The role a device has in a project now (null: none): revocations, binding, journal, invite. */
function roleIn(
  t: ProjectTeam,
  d: EnrolledDevice,
  projectId: string,
  devices: Devices,
): Role | null {
  if (d.revokedAt !== null || t.revokedAt(d.device) !== null) return null;
  if (!bindingHolds(d, t, devices)) return null;
  return t.inJournal(d.actor) ? t.roleNow(d.actor) : grant(d, projectId);
}

export function createCore(options: CoreOptions) {
  const { store, identity } = options;
  const now = options.now ?? (() => new Date());
  const exclusive = mutex();
  const teams = new Map<string, ProjectTeam>();

  /**
   * Pin the genesis once the project has a team (on the server: the first history its owner
   * pushed, trust on first use), so no op dated earlier can make itself the first owner later.
   */
  async function pinIfShared(projectId: string, t: ProjectTeam): Promise<void> {
    if (t.pin || !t.shared) return;
    const raws: Record<string, unknown>[] = [];
    for await (const op of store.allOps(projectId)) raws.push(op);
    const pin = t.genesisPin(raws);
    const first = pin ? raws.find((r) => r.id === pin.op) : undefined;
    const dev = typeof first?.dev === 'string' ? first.dev : null;
    const device = dev ? t.deviceKey(dev) : null;
    if (!pin || !dev || !device) return;
    const genesis: TeamGenesis = {
      op: pin.op,
      device: dev,
      key: device.key,
      at: pin.at,
      heads: { ...pin.heads },
    };
    await store.setProjectGenesis(projectId, genesis);
    t.setPin(pin);
  }

  async function team(projectId: string): Promise<ProjectTeam> {
    let t = teams.get(projectId);
    if (t) return t;
    const genesis = (await store.project(projectId))?.genesis;
    t = new ProjectTeam(genesis ? pinFromGenesis(genesis) : null);
    const ops: Op[] = [];
    for await (const op of store.allOps(projectId)) ops.push(op);
    t.add(ops);
    teams.set(projectId, t);
    // a project stored before the server pinned genesis is pinned now
    await pinIfShared(projectId, t);
    return t;
  }

  async function allTeams(): Promise<{ projectId: string; t: ProjectTeam }[]> {
    const out: { projectId: string; t: ProjectTeam }[] = [];
    for (const p of await store.projects())
      out.push({ projectId: p.teamProjectId, t: await team(p.teamProjectId) });
    return out;
  }

  /** The enrolled devices a binding check may need (only certified bindings look them up). */
  async function devicesFor(d: EnrolledDevice): Promise<Devices> {
    if (!d.certifiedBy) return new Map();
    return new Map((await store.devices()).map((e) => [e.device, e]));
  }

  async function roleOf(d: EnrolledDevice, projectId: string): Promise<Role | null> {
    return roleIn(await team(projectId), d, projectId, await devicesFor(d));
  }

  async function projectOr404(projectId: string): Promise<TeamProject> {
    const p = await store.project(projectId);
    if (!p) throw new ServerRefusal(404, 'not-found', 'This server holds no such project.');
    return p;
  }

  async function readAccess(d: EnrolledDevice, projectId: string): Promise<void> {
    await projectOr404(projectId);
    if ((await team(projectId)).revokedAt(d.device) !== null)
      throw new ServerRefusal(403, 'forbidden', 'This device was revoked in this project.');
    const role = await roleOf(d, projectId);
    if (role === null || !READ_ROLES.includes(role)) {
      throw new ServerRefusal(
        403,
        'forbidden',
        role === 'client'
          ? 'Clients see shared packages, not the team history.'
          : 'You are not a member of this project.',
      );
    }
  }

  async function projectsOf(d: EnrolledDevice) {
    const out: { teamProjectId: string; name: string }[] = [];
    for (const p of await store.projects()) {
      if ((await roleOf(d, p.teamProjectId)) !== null)
        out.push({ teamProjectId: p.teamProjectId, name: p.name });
    }
    return out;
  }

  /**
   * The certificate in a device record that lets it take an actor another device already has: from
   * one of that person's devices that holds the actor everywhere, or from an owner (a server-wide
   * owner invite, or an owner in a project's journal). Null when none verifies.
   */
  function certifiedBy(
    record: DeviceRecord,
    enrolled: readonly EnrolledDevice[],
    states: readonly { t: ProjectTeam }[],
  ): { actor: string; device: string } | null {
    const devices = new Map(enrolled.map((e) => [e.device, e]));
    const at = now().toISOString();
    for (const cert of record.certs) {
      if (cert.level !== 'owner' || cert.device !== record.id || cert.actor !== record.actor)
        continue;
      if (cert.expiresAt !== undefined && cert.expiresAt <= at) continue;
      const issuer = devices.get(cert.issuer.device);
      if (issuer?.revokedAt !== null) continue;
      if (cert.issuer.actor !== undefined && cert.issuer.actor !== issuer.actor) continue;
      if (!verifyCert(cert, issuer.key)) continue;
      if (states.some(({ t }) => t.revokedAt(issuer.device) !== null)) continue;
      const holdsEverywhere = states.every(({ t }) => bindingHolds(issuer, t, devices));
      if (issuer.actor === record.actor) {
        if (holdsEverywhere) return { actor: issuer.actor, device: issuer.device };
        continue;
      }
      const owner =
        (holdsEverywhere && issuer.role === 'owner' && issuer.project === null) ||
        states.some(
          ({ t }) => t.roleNow(issuer.actor) === 'owner' && bindingHolds(issuer, t, devices),
        );
      if (owner) return { actor: issuer.actor, device: issuer.device };
    }
    return null;
  }

  function answer(
    device: EnrolledDevice,
    projects: { teamProjectId: string; name: string }[],
  ): EnrolResponse {
    return {
      server: {
        id: identity.id,
        name: options.name,
        version: options.version,
        fingerprint: options.fingerprint,
        publicKey: identity.publicKey,
      },
      cert: serverCert(identity, device, now().toISOString()),
      role: device.role,
      projects,
    };
  }

  const actorTaken = () =>
    new ServerRefusal(
      403,
      'actor',
      "Another device already uses this person's identity on this server. Enrol with a certificate from one of that person's devices or from an owner, or with a new identity.",
    );

  return {
    identity,

    /** The enrolled, non-revoked device behind a signed request (null refuses it). */
    async device(deviceId: string): Promise<EnrolledDevice | null> {
      const d = await store.device(deviceId);
      return d?.revokedAt === null ? d : null;
    },

    async enrol(raw: unknown, signedBy: string): Promise<EnrolResponse> {
      const parsed = EnrolRequest.safeParse(raw);
      if (!parsed.success) throw new ServerRefusal(400, 'schema', 'The enrolment is not valid.');
      const rec = checkDeviceRecord((raw as { device: unknown }).device);
      if (!rec.ok) throw new ServerRefusal(400, 'device', rec.message);
      const record = rec.record;
      if (record.id !== signedBy)
        throw new ServerRefusal(401, 'signature', 'The request is not signed by this device.');
      return exclusive(async () => {
        const before = await store.device(record.id);
        if (before?.revokedAt)
          throw new ServerRefusal(403, 'revoked', 'This device was revoked on this server.');
        const at = now().toISOString();
        const takeInvite = async () => {
          const invite = await store.takeInvite(inviteHash(parsed.data.code), at, record.id);
          if (!invite)
            throw new ServerRefusal(
              403,
              'invite',
              'This invite code is not valid. It may be mistyped, used or expired.',
            );
          return invite;
        };
        if (before) {
          // enrolled already: a valid code still, but it keeps who it is and the role it has
          if (before.actor !== record.actor || before.key !== record.key)
            throw new ServerRefusal(
              403,
              'actor',
              'This device is enrolled on this server as another person.',
            );
          await takeInvite();
          return answer(before, await projectsOf(before));
        }
        const enrolled = await store.devices();
        const states = await allTeams();
        if (
          states.some(({ t }) => {
            const listed = t.deviceKey(record.id);
            return listed !== null && listed.actor !== record.actor;
          })
        )
          throw actorTaken();
        // an owner listed this device for this actor in a project: the journal vouches for it
        const listed = states.some(({ t }) => t.binds(record.actor, record.id));
        const taken =
          !listed &&
          (enrolled.some((e) => e.actor === record.actor) ||
            states.some(({ t }) => t.inJournal(record.actor) && !t.binds(record.actor, record.id)));
        const certified = taken ? certifiedBy(record, enrolled, states) : null;
        if (taken && !certified) throw actorTaken();

        const invite = await takeInvite();
        const device: EnrolledDevice = {
          device: record.id,
          actor: record.actor,
          key: record.key,
          name: record.name,
          initials: record.initials,
          role: invite.role,
          project: invite.project,
          enrolledAt: at,
          revokedAt: null,
          revokeReason: null,
          record,
          ...(certified ? { certifiedBy: certified } : {}),
        };
        await store.putDevice(device);
        return answer(device, await projectsOf(device));
      });
    },

    async heads(d: EnrolledDevice, projectId: string) {
      await readAccess(d, projectId);
      return { project: projectId, heads: await store.heads(projectId) };
    },

    async pull(d: EnrolledDevice, projectId: string, token: string | undefined, limit: number) {
      await readAccess(d, projectId);
      const decoded = decodeSince(token ?? 'v1');
      if (!decoded) throw new ServerRefusal(400, 'since', 'The since value is not valid.');
      const heads = await store.heads(projectId);
      const since = sinceFor(decoded, Object.keys(heads));
      const page = await store.opsSince(projectId, since, limit);
      const after: Record<string, number> = { ...since };
      for (const op of page.ops) after[op.chain] = Math.max(after[op.chain] ?? 0, op.seq);
      return { ops: page.ops, cursor: page.more ? encodeCursor(after) : null, more: page.more };
    },

    async members(d: EnrolledDevice, projectId: string): Promise<Member[]> {
      const project = await projectOr404(projectId);
      await readAccess(d, projectId);
      const t = await team(projectId);
      const enrolled = await store.devices();
      const devices = new Map(enrolled.map((e) => [e.device, e]));
      const here = new Set(
        enrolled
          .filter((e) => e.revokedAt === null && bindingHolds(e, t, devices))
          .map((e) => e.device),
      );
      const fromJournal = t
        .members()
        .map((m) =>
          m.devices.some((x) => here.has(x.id)) ? { ...m, verification: 'server' as const } : m,
        );
      const named = new Set(fromJournal.map((m) => m.actor));
      const granted = new Map<string, Member>();
      for (const e of enrolled) {
        const role = grant(e, projectId);
        if (role === null || named.has(e.actor) || t.inJournal(e.actor)) continue;
        if (t.deviceKey(e.device) !== null || t.revokedAt(e.device) !== null) continue;
        const m = granted.get(e.actor);
        const dev = { id: e.device, key: e.key, revoked: false };
        if (m) m.devices.push(dev);
        else
          granted.set(e.actor, {
            actor: e.actor,
            name: e.name,
            initials: e.initials,
            role,
            devices: [dev],
            verification: 'server',
            addedBy: project.createdBy,
            addedAt: e.enrolledAt,
          });
      }
      return [...fromJournal, ...granted.values()];
    },

    /**
     * Check and store pushed ops. The server checks what only it can: schema, hash, chain (seq,
     * link and a clock that moves forward), a clock more than a day ahead, a key the project or an
     * accepted enrolment gives the device, and devices revoked on this server. Membership, roles,
     * journal revocations and the genesis are then judged with the journal's own team logic on the
     * stored and the pushed ops together, so the server's verdict is the one every app reaches on
     * the same ops. Accepted ops are countersigned. `forbidden` is set when nothing was accepted
     * and something was refused for role, membership or revocation (HTTP 403).
     */
    async push(
      d: EnrolledDevice,
      projectId: string,
      rawOps: readonly unknown[],
    ): Promise<PushResult & { forbidden: boolean }> {
      return exclusive(async () => {
        const result: PushResult = { accepted: [], duplicates: [], refused: [], receipts: [] };
        const valid: { op: Op; raw: Record<string, unknown> }[] = [];
        for (const raw of rawOps) {
          const id =
            raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string'
              ? (raw as { id: string }).id
              : '?';
          const parsed = Op.safeParse(raw);
          if (!parsed.success) {
            result.refused.push(refuse(id, 'schema', 'The op is not valid.'));
            continue;
          }
          const op = parsed.data;
          const schema = (
            OP_PAYLOADS as Record<string, { safeParse(v: unknown): { success: boolean } }>
          )[op.kind];
          if (schema && 'payload' in (raw as object) && !schema.safeParse(op.payload).success) {
            result.refused.push(refuse(op.id, 'schema', `The ${op.kind} payload is not valid.`));
            continue;
          }
          valid.push({ op, raw: raw as Record<string, unknown> });
        }
        valid.sort((a, b) => compareHlc(a.op.hlc, b.op.hlc));

        let project = await store.project(projectId);
        const t = await team(projectId);
        const enrolled = await store.devices();
        const byDevice = new Map(enrolled.map((e) => [e.device, e]));
        if (!project) {
          const share = valid.find(
            ({ op }) =>
              op.kind === 'project.share' &&
              op.act === d.actor &&
              op.dev === d.device &&
              ProjectSharePayload.safeParse(op.payload).data?.teamProjectId === projectId,
          );
          if (!share)
            throw new ServerRefusal(404, 'not-found', 'This server holds no such project.');
          if (grant(d, projectId) !== 'owner')
            throw new ServerRefusal(
              403,
              'forbidden',
              'Only an owner invited to this server can share a new project to it.',
            );
          project = {
            schema: TEAM_SCHEMA,
            teamProjectId: projectId,
            name: ProjectSharePayload.parse(share.op.payload).name,
            createdAt: now().toISOString(),
            createdBy: d.actor,
          };
        }
        const forget = async () => {
          if (!(await store.project(projectId))) teams.delete(projectId);
        };
        const pusherRole = roleIn(t, d, projectId, byDevice);
        if (pusherRole === null) {
          await forget();
          throw new ServerRefusal(
            403,
            'forbidden',
            t.revokedAt(d.device) !== null
              ? 'This device was revoked in this project.'
              : 'You are not a member of this project.',
          );
        }
        // until its owner has added the team, a project takes history only from that owner
        const creator = project.createdBy;
        if (!t.shared && !t.pin && d.actor !== creator) {
          await forget();
          throw new ServerRefusal(
            403,
            'forbidden',
            'The owner who shared this project has not added the team yet.',
          );
        }

        const heads = new Map(Object.entries(await store.heads(projectId)));
        const clocks = new Map<string, string>();
        const known = await store.hasOps(
          projectId,
          valid.map((v) => v.op.id),
        );
        const refusals = new Map<string, { code: RefusalCode; message: string }>();
        const candidates: { op: Op; raw: Record<string, unknown> }[] = [];
        const seen = new Set<string>();
        const nowMs = now().getTime();

        // what only the server checks, in clock order (a chain's ops come in seq order)
        for (const { op, raw } of valid) {
          if (known.has(op.id) || seen.has(op.id)) {
            result.duplicates.push(op.id);
            continue;
          }
          const no = (code: RefusalCode, message: string) => {
            refusals.set(op.id, { code, message });
          };
          const check = checkOp(raw);
          if (!check.id || check.payload === false) {
            no('hash', 'The op does not match its hash.');
            continue;
          }
          if (parseHlc(op.hlc).ms - nowMs > CLOCK_AHEAD_HOLD_MS) {
            no('clock-ahead', 'The op was written by a clock more than a day ahead.');
            continue;
          }
          const head = heads.get(op.chain);
          const expected = (head?.seq ?? 0) + 1;
          if (op.seq > expected) {
            no('gap', `Ops ${expected} to ${op.seq - 1} of this chain are missing.`);
            continue;
          }
          if (op.seq < expected || op.prev !== (head?.id ?? null)) {
            no('chain', 'The op does not continue its chain (a fork or an edited history).');
            continue;
          }
          const last = clocks.get(op.chain) ?? t.clockOf(op.chain);
          if (last !== null && compareHlc(op.hlc, last) <= 0) {
            no('chain', 'The op is dated before the op it follows in its chain.');
            continue;
          }
          // the key: from the journal, else from an enrolment the project accepts
          const listed = t.deviceKey(op.dev);
          const author = byDevice.get(op.dev);
          const key = listed
            ? listed.actor === op.act
              ? listed.key
              : null
            : author?.actor === op.act && bindingHolds(author, t, byDevice)
              ? author.key
              : null;
          if (key === null) {
            no('non-member', 'The device that wrote the op is not a member device.');
            continue;
          }
          if (typeof op.sig !== 'string' || !verifySignature(key, 'aio.op/1', op.id, op.sig)) {
            no('signature', 'The op signature does not verify.');
            continue;
          }
          // revoked on this server by its admin: no new op of the device is taken
          if ((author?.revokedAt ?? null) !== null) {
            no('revoked', 'The device that wrote the op was revoked on this server.');
            continue;
          }
          if (pusherRole === 'client' && op.act !== d.actor) {
            no('role', 'A client sends only their own replies.');
            continue;
          }
          if (!t.shared && !t.pin && op.kind === 'member.add' && op.act !== creator) {
            no('non-member', 'Only the owner who shared this project adds its first members.');
            continue;
          }
          heads.set(op.chain, { seq: op.seq, id: op.id });
          clocks.set(op.chain, op.hlc);
          seen.add(op.id);
          candidates.push({ op, raw });
        }

        // the journal's verdict on the stored and pushed ops together; a refused op takes the
        // rest of its chain with it (the server stores no gap), so judge again until it holds
        let live = candidates;
        for (;;) {
          const { verdicts } = t.replay(live);
          const out = new Set<string>();
          const cut = new Map<string, number>();
          for (const { op } of live) {
            const v = verdicts.get(op.id);
            if (v && !v.ok) {
              refusals.set(op.id, { code: REFUSAL_CODES[v.code], message: v.reason });
              out.add(op.id);
              cut.set(op.chain, Math.min(cut.get(op.chain) ?? op.seq, op.seq));
            }
          }
          if (out.size === 0) break;
          for (const { op } of live) {
            const from = cut.get(op.chain);
            if (from !== undefined && op.seq > from && !out.has(op.id)) {
              refusals.set(op.id, {
                code: 'gap',
                message: 'An earlier op of this chain was refused.',
              });
              out.add(op.id);
            }
          }
          live = live.filter(({ op }) => !out.has(op.id));
        }
        for (const { op } of valid) {
          const r = refusals.get(op.id);
          if (r) result.refused.push(refuse(op.id, r.code, r.message));
        }
        const roleRefusals = [...refusals.values()].filter(
          (r) => r.code === 'role' || r.code === 'non-member' || r.code === 'revoked',
        ).length;
        const accepted = live.map(({ raw }) => raw as Op);

        try {
          if (accepted.length > 0) {
            if (!(await store.project(projectId))) await store.createProject(project);
            const { stored } = await store.appendOps(projectId, accepted);
            const at = now().toISOString();
            let prev: Receipt | null = await store.lastReceipt();
            const receipts: Receipt[] = [];
            for (const id of stored) {
              prev = makeReceipt(identity.signer, identity.id, prev, id, at);
              receipts.push(prev);
            }
            await store.appendReceipts(receipts);
            result.accepted.push(...stored);
            result.receipts.push(...receipts);
            t.add(accepted);
            await pinIfShared(projectId, t);
          }
        } catch (e) {
          teams.delete(projectId);
          throw e;
        }
        if (accepted.length === 0) await forget();
        return { ...result, forbidden: accepted.length === 0 && roleRefusals > 0 };
      });
    },

    /**
     * May this device read a blob: it sent every byte of it, or it may read a project whose
     * journal names the blob (`blob.add`)?
     */
    async mayReadBlob(d: EnrolledDevice, sha256: string): Promise<boolean> {
      if (await store.blobUploadedBy(sha256, d.device)) return true;
      for (const { projectId, t } of await allTeams()) {
        if (!t.hasBlob(sha256)) continue;
        const role = await roleOf(d, projectId);
        if (role !== null && READ_ROLES.includes(role)) return true;
      }
      return false;
    },

    /** May this device upload blobs: it may edit in a project, or its invite lets it edit? */
    async mayUploadBlob(d: EnrolledDevice): Promise<boolean> {
      const projects = await store.projects();
      for (const p of projects) {
        const role = await roleOf(d, p.teamProjectId);
        if (role !== null && EDIT_ROLES.includes(role)) return true;
      }
      // the project of its invite before it is on the server, or every project to come
      const open = d.project === null || !projects.some((p) => p.teamProjectId === d.project);
      const role = open ? grant(d, d.project) : null;
      return role !== null && EDIT_ROLES.includes(role);
    },

    /** The device sent every byte of a blob (it may read it back). */
    async uploadedBlob(d: EnrolledDevice, sha256: string): Promise<void> {
      await store.addBlobUpload(sha256, d.device, now().toISOString());
    },
  };
}

export type Core = ReturnType<typeof createCore>;
