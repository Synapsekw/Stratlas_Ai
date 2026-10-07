/**
 * What the Team Server does, without HTTP: check and store pushed ops, countersign them, page
 * them out, enrol devices and list members. It stores and forwards; it never merges, so the
 * server and the app cannot disagree on state.
 */
import { checkOp, compareHlc, parseHlc, verifySignature } from '@aio/journal';
import {
  CLOCK_AHEAD_HOLD_MS,
  EnrolRequest,
  Op,
  OP_PAYLOADS,
  ProjectSharePayload,
  TEAM_SCHEMA,
  type EnrolResponse,
  type Member,
  type PushResult,
  type Receipt,
  type RefusalCode,
  type Role,
  type TeamProject,
} from '@aio/schema';
import { checkDeviceRecord, inviteHash, serverCert } from './auth/enrol';
import type { ServerIdentity } from './identity';
import { makeReceipt } from './receipts';
import { clientMaySend, permissionFor, TeamState, TEAM_KINDS } from './roles';
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

export function createCore(options: CoreOptions) {
  const { store, identity } = options;
  const now = options.now ?? (() => new Date());
  const exclusive = mutex();
  const teams = new Map<string, TeamState>();

  async function team(projectId: string): Promise<TeamState> {
    let t = teams.get(projectId);
    if (t) return t;
    t = new TeamState();
    for await (const op of store.allOps(projectId)) if (TEAM_KINDS.has(op.kind)) t.apply(op);
    teams.set(projectId, t);
    return t;
  }

  /** The role an enrolled device's invite gives in a project; null when it gives none. */
  const grant = (d: EnrolledDevice, projectId: string): Role | null =>
    d.revokedAt === null && (d.project === null || d.project === projectId) ? d.role : null;

  /** The role a device's person has in a project now: the journal's, else the invite's. */
  async function roleOf(d: EnrolledDevice, projectId: string): Promise<Role | null> {
    const t = await team(projectId);
    return t.inJournal(d.actor) ? t.roleNow(d.actor) : grant(d, projectId);
  }

  async function projectOr404(projectId: string): Promise<TeamProject> {
    const p = await store.project(projectId);
    if (!p) throw new ServerRefusal(404, 'not-found', 'This server holds no such project.');
    return p;
  }

  async function readAccess(d: EnrolledDevice, projectId: string): Promise<void> {
    await projectOr404(projectId);
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
        const invite = await store.takeInvite(inviteHash(parsed.data.code), at, record.id);
        if (!invite)
          throw new ServerRefusal(
            403,
            'invite',
            'This invite code is not valid. It may be mistyped, used or expired.',
          );
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
        };
        await store.putDevice(device);
        return {
          server: {
            id: identity.id,
            name: options.name,
            version: options.version,
            fingerprint: options.fingerprint,
          },
          cert: serverCert(identity, device, at),
          role: invite.role,
          projects: await projectsOf(device),
        };
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
      const here = new Set(enrolled.map((e) => e.device));
      const fromJournal = t.members(({ devices, certified }) =>
        devices.some((x) => here.has(x)) ? 'server' : certified ? 'owner' : 'self',
      );
      const named = new Set(fromJournal.map((m) => m.actor));
      const granted = new Map<string, Member>();
      for (const e of enrolled) {
        const role = grant(e, projectId);
        if (role === null || named.has(e.actor) || t.inJournal(e.actor)) continue;
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
     * Check and store pushed ops: schema, hash, chain, signature, revocation, membership and role
     * at each op's clock reading. Accepted ops are countersigned. `forbidden` is set when nothing
     * was accepted and something was refused for role, membership or revocation (HTTP 403).
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
        if (!project) {
          const share = valid.find(
            ({ op }) =>
              op.kind === 'project.share' &&
              op.act === d.actor &&
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
          // the creator owns the history written before sharing
          t.apply(share.op);
        }
        const pusherRole = t.inJournal(d.actor) ? t.roleNow(d.actor) : grant(d, projectId);
        if (pusherRole === null)
          throw new ServerRefusal(403, 'forbidden', 'You are not a member of this project.');

        const enrolled = await store.devices();
        const byDevice = new Map(enrolled.map((e) => [e.device, e]));
        const grantOf = (actor: string): Role | null => {
          for (const e of enrolled)
            if (e.actor === actor) {
              const g = grant(e, projectId);
              if (g) return g;
            }
          return null;
        };
        const heads = new Map(Object.entries(await store.heads(projectId)));
        const known = await store.hasOps(
          projectId,
          valid.map((v) => v.op.id),
        );
        const accepted: Op[] = [];
        const seen = new Set<string>();
        const nowMs = now().getTime();
        let roleRefusals = 0;

        try {
          for (const { op, raw } of valid) {
            if (known.has(op.id) || seen.has(op.id)) {
              result.duplicates.push(op.id);
              continue;
            }
            const no = (code: RefusalCode, message: string) => {
              if (code === 'role' || code === 'non-member' || code === 'revoked') roleRefusals++;
              result.refused.push(refuse(op.id, code, message));
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
            const fromJournal = t.deviceKey(op.dev);
            const fromServer = byDevice.get(op.dev);
            const key =
              fromJournal?.actor === op.act
                ? fromJournal.key
                : fromServer?.actor === op.act
                  ? fromServer.key
                  : null;
            if (key === null) {
              no('non-member', 'The device that wrote the op is not a member device.');
              continue;
            }
            if (typeof op.sig !== 'string' || !verifySignature(key, 'aio.op/1', op.id, op.sig)) {
              no('signature', 'The op signature does not verify.');
              continue;
            }
            const revoked = t.revokedAt(op.dev);
            const serverRevoked = fromServer?.revokedAt
              ? Date.parse(fromServer.revokedAt) <= parseHlc(op.hlc).ms
              : false;
            if ((revoked !== null && compareHlc(revoked, op.hlc) <= 0) || serverRevoked) {
              no('revoked', 'The device was revoked before it wrote the op.');
              continue;
            }
            const role = t.inJournal(op.act) ? t.roleAt(op.act, op.hlc) : grantOf(op.act);
            if (role === null) {
              no('non-member', 'The author was not a member when the op was written.');
              continue;
            }
            if (pusherRole === 'client' && op.act !== d.actor) {
              no('role', 'A client sends only their own replies.');
              continue;
            }
            const permission = permissionFor(op);
            if (
              (role === 'client' && !clientMaySend(op)) ||
              (permission !== null && !t.allows(role, permission, op.hlc))
            ) {
              no('role', `A ${role} may not do this (${op.kind}).`);
              continue;
            }
            heads.set(op.chain, { seq: op.seq, id: op.id });
            seen.add(op.id);
            t.apply(op);
            accepted.push(raw as Op);
          }

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
          }
        } catch (e) {
          teams.delete(projectId);
          throw e;
        }
        if (accepted.length === 0 && !(await store.project(projectId))) teams.delete(projectId);
        return { ...result, forbidden: accepted.length === 0 && roleRefusals > 0 };
      });
    },
  };
}

export type Core = ReturnType<typeof createCore>;
