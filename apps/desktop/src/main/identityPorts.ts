/**
 * One person, one device key (M9 integration): T2's identity service is the only source of the
 * actor, the name and initials, and the Ed25519 device key (vault account `device-signing` under
 * the profile's service). Every stream reaches it through these adapters:
 *
 * - T1 journal: `journalIdentity` (who signs each op);
 * - T5 sync and exchange: `devicePort` (`me`, `signer`, `record`);
 * - T7 team server: `deviceSource` (the request signer and the public device record);
 * - T3 review workflow: `collabIdentity` and `collabMembers` (the members T2 replays);
 * - T2 itself: `teamJournal`, its team ops written by T1's journal service.
 */
import { replayTeam, type Signer } from '@aio/journal';
import type { AppStamp, DeviceRecord, Op } from '@aio/schema';
import type { CollabOp } from '@aio/collab';
import type { CollabIdentity, CollabMembers } from './collab';
import { deviceRecord, type IdentityService, type TeamJournal } from './identity';
import type { JournalIdentity, JournalService } from './journal';
import type { DevicePort } from './sync/ports';
import type { DeviceSource } from './teamServer';

/** T1: who signs the journal. Without a stored key the device is named but nothing is signed. */
export function journalIdentity(
  service: IdentityService,
  app: AppStamp,
): () => Promise<JournalIdentity> {
  return async () => {
    const who = await service.identity();
    const key = service.deviceKey();
    return {
      actor: who.actor,
      name: who.name,
      initials: who.initials,
      device: { id: key.signer.device, publicKey: key.signer.publicKey },
      signer: key.stored ? key.signer : null,
      app,
    };
  };
}

/** The self-signed public record of this device, made again when the name changes. */
function recordCache(service: IdentityService, app: AppStamp, now: () => Date) {
  let cached: { key: string; record: DeviceRecord } | null = null;
  return async (signer: Signer): Promise<DeviceRecord> => {
    const who = await service.identity();
    const cacheKey = `${signer.device}|${who.actor}|${who.name}|${who.initials}`;
    if (cached?.key === cacheKey) return cached.record;
    cached = { key: cacheKey, record: deviceRecord(who, signer, app, now()) };
    return cached.record;
  };
}

/** T5: the person and this device for sync and exchange files. */
export function devicePort(
  service: IdentityService,
  app: AppStamp,
  now: () => Date = () => new Date(),
): DevicePort {
  const record = recordCache(service, app, now);
  const signer = () => {
    const key = service.deviceKey();
    return key.stored ? key.signer : null;
  };
  return {
    async me() {
      const who = await service.identity();
      return { actor: who.actor, name: who.name, initials: who.initials };
    },
    signer: () => Promise.resolve(signer()),
    async record() {
      const s = signer();
      return s ? record(s) : null;
    },
  };
}

/**
 * T7: the request signer and the device record. A device whose key is not in the vault cannot
 * enrol (`null`), except in automated runs on an isolated profile, which sign for the session.
 */
export function deviceSource(
  service: IdentityService,
  app: AppStamp,
  opts: { sessionKeyWithoutVault?: boolean; now?: () => Date } = {},
): DeviceSource {
  const record = recordCache(service, app, opts.now ?? (() => new Date()));
  return async () => {
    const key = service.deviceKey();
    if (!key.stored && !opts.sessionKeyWithoutVault) return null;
    return { signer: key.signer, record: await record(key.signer) };
  };
}

/** T3: this person. */
export function collabIdentity(service: IdentityService): CollabIdentity {
  return {
    async me() {
      const who = await service.identity();
      return { actor: who.actor, name: who.name, initials: who.initials };
    },
  };
}

/** T3: the members as T2 replays them (verified, roles at the end of the history). */
export function collabMembers(): CollabMembers {
  return {
    list(_root, ops) {
      const replay = replayTeam(ops as unknown as Record<string, unknown>[]);
      return Promise.resolve(
        replay.members.map((m) => ({
          actor: m.actor,
          name: m.name,
          initials: m.initials,
          role: m.role,
        })),
      );
    },
  };
}

/**
 * T2's team ops through T1's journal service (the only writer of `journal/`). A getter, because
 * the journal signs with the identity service that holds this port.
 */
export function teamJournal(journalOf: () => JournalService): TeamJournal {
  return {
    async ops(root) {
      return await journalOf().store.ops(root);
    },
    async append(root, _actor, _key, entry) {
      const [op] = await journalOf().append(root, [
        {
          kind: entry.kind,
          target: entry.target,
          payload: entry.payload as Record<string, unknown>,
        },
      ]);
      if (!op) throw new Error('The team change was not written.');
      return op;
    },
    async publishDevice(root) {
      // T1 publishes this device's record with the first op of its chain in the folder
      await journalOf().chainOf(root);
    },
  };
}

/**
 * Collab ops as T3 reads them: every op of every chain, raw (payload absent when redacted), less
 * the ops T2's team replay holds back (a stranger, a role that does not allow it, a revoked
 * device), so they never count as comments, assignments or approvals.
 */
export async function collabOps(journal: JournalService, root: string): Promise<CollabOp[]> {
  const ops: Op[] = await journal.store.ops(root);
  const raws = ops as unknown as Record<string, unknown>[];
  const replay = replayTeam(raws, { verdicts: 'all' });
  return ops.filter((o) => replay.verdicts.get(o.id)?.ok !== false);
}
