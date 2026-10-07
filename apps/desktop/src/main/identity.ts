/**
 * Identity, devices and members (M9 stream T2): `identity:*` and `members:*`, plus `--profile`.
 *
 * - The person: userData `identity.json` (`aio.identity/1`), moved once from the renderer's old
 *   free-text author (`identity:set` `migrateFrom`), the OS account otherwise.
 * - The device: an Ed25519 key made on first need. The private key lives only in the OS vault
 *   (account `device-signing`); it never reaches a project, a card, a log or the renderer. When
 *   the vault fails, the key lasts for this run only and ops are written unsigned.
 * - Members and roles: ops in the project journal (`member.*`, `device.revoke`), replayed by
 *   `@aio/journal` `replayTeam`. Renderer code never signs; this module stamps every team op.
 */
import {
  certifyDevice,
  compareHlc,
  contentHash,
  createClock,
  deriveInitials,
  deviceIdFromKey,
  randomId,
  replayTeam,
  roleRefusal,
  sealOp,
  signerFromKey,
  verifySignature,
  type Signer,
  type TeamReplay,
} from '@aio/journal';
import {
  DEVICE_KEY_ACCOUNT,
  DEVICE_SCHEMA,
  IDENTITY_CARD_EXTENSION,
  IDENTITY_CARD_SCHEMA,
  IDENTITY_FILE,
  IDENTITY_SCHEMA,
  Identity,
  IdentityCard,
  PersonName,
  type AppStamp,
  type DeviceRecord,
  type IpcRequest,
  type IpcResponse,
  type Member,
  type Op,
  type Role,
} from '@aio/schema';
import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil';
import type { KeyEntry } from './keys';
import type { Handle } from './notYet';

// ---------------------------------------------------------------- profiles (--profile=<name>)

/** A profile name: letters, digits, `-` and `_`, up to 40 characters. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/**
 * `--profile=<name>` from the command line: a second person on one PC (tests, training, founder
 * testing). Null when absent or not a valid name.
 */
export function profileFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const m = /^--profile=(.*)$/.exec(arg);
    if (m) return PROFILE_NAME.test(m[1] ?? '') ? (m[1] ?? null) : null;
  }
  return null;
}

/** userData of a profile: `<userData>/profiles/<name>`. */
export function profileUserData(userData: string, profile: string): string {
  return join(userData, 'profiles', profile);
}

/** Vault service of a profile: `<service>.profile.<name>`, so keys never mix between people. */
export function profileVaultService(service: string, profile: string | null): string {
  return profile ? `${service}.profile.${profile}` : service;
}

// ---------------------------------------------------------------- identity file

/** `<userData>/identity.json`. */
export function identityPath(userData: string): string {
  return join(userData, IDENTITY_FILE);
}

export interface IdentityStoreDeps {
  /** The OS account name, the default display name. */
  osUser: () => string | undefined;
  now?: () => Date;
}

const FALLBACK_NAME = 'Reviewer';

export function createIdentityStore(file: string, deps: IdentityStoreDeps) {
  const now = deps.now ?? (() => new Date());
  let cached: Identity | null = null;
  // One read-or-make and one change at a time: on first start the journal, the renderer and the
  // person's own change ask together, and each would otherwise make an identity of its own.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  }

  function osName(): string | null {
    const parsed = PersonName.safeParse(deps.osUser() ?? '');
    return parsed.success ? parsed.data : null;
  }

  function fresh(name: string, from: Identity['migratedFrom']): Identity {
    return Identity.parse({
      schema: IDENTITY_SCHEMA,
      actor: randomId('a_', 26),
      name,
      initials: deriveInitials(name),
      createdAt: now().toISOString(),
      migratedFrom: from,
    });
  }

  async function load(): Promise<Identity | null> {
    if (cached) return cached;
    for (const path of [file, `${file}.bak`]) {
      let raw: unknown;
      try {
        raw = await readJson(path);
      } catch {
        continue;
      }
      if (raw === undefined) continue;
      const parsed = Identity.safeParse(raw);
      if (parsed.success) {
        cached = parsed.data;
        return cached;
      }
    }
    return null;
  }

  async function save(identity: Identity): Promise<Identity> {
    await writeJsonAtomic(file, identity, { backup: true });
    cached = identity;
    return identity;
  }

  async function exists(): Promise<boolean> {
    try {
      await stat(file);
      return true;
    } catch {
      return false;
    }
  }

  return {
    /** This person, made on first call from the OS account when there is no file yet. */
    get(): Promise<Identity> {
      if (cached) return Promise.resolve(cached);
      return serial(async () => {
        const have = await load();
        if (have) return have;
        if (await exists()) {
          // A damaged file is never overwritten: the actor id in it may be in project journals.
          throw new Error(`Your identity file could not be read (${file}).`);
        }
        const os = osName();
        return save(fresh(os ?? FALLBACK_NAME, os ? 'os-account' : 'new'));
      });
    },

    set(patch: IpcRequest<'identity:set'>): Promise<Identity> {
      return serial(() => change(patch));
    },
  };

  /** `set`, one at a time (see `serial`). */
  async function change(patch: IpcRequest<'identity:set'>): Promise<Identity> {
    const migrate = PersonName.safeParse(patch.migrateFrom ?? '');
    let current = await load();
    if (!current) {
      if (await exists()) throw new Error(`Your identity file could not be read (${file}).`);
      if (migrate.success) {
        current = await save(fresh(migrate.data, 'author-setting'));
      } else {
        const os = osName();
        current = fresh(os ?? FALLBACK_NAME, os ? 'os-account' : 'new');
      }
    } else if (
      migrate.success &&
      current.migratedFrom !== 'author-setting' &&
      current.name === (osName() ?? FALLBACK_NAME)
    ) {
      // the identity was made from the OS account before the old setting arrived: take it once
      current = {
        ...current,
        name: migrate.data,
        initials: deriveInitials(migrate.data),
        migratedFrom: 'author-setting',
      };
    }
    const next: Identity = { ...current };
    if (patch.name !== undefined && patch.name !== current.name) {
      next.name = patch.name;
      // initials follow the name until the person sets their own
      if (patch.initials === undefined && current.initials === deriveInitials(current.name)) {
        next.initials = deriveInitials(patch.name);
      }
    }
    if (patch.initials !== undefined) next.initials = patch.initials;
    if (patch.email !== undefined) {
      if (patch.email === '') delete next.email;
      else next.email = patch.email;
    }
    return save(Identity.parse(next));
  }
}

export type IdentityStore = ReturnType<typeof createIdentityStore>;

// ---------------------------------------------------------------- device key in the vault

export interface DeviceKey {
  signer: Signer;
  /** False when the vault failed: the key lasts for this run only and ops are unsigned. */
  stored: boolean;
}

/** Error class and message only; OS vault messages never contain the secret. */
function errorName(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error';
}

function keyFromText(text: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(text, 'base64url'), format: 'der', type: 'pkcs8' });
}

/**
 * The device signing key in the OS vault (service = app id, or `.isolated` for test runs, plus
 * `.profile.<name>`; account `device-signing`). `onSecret` registers the key text with the
 * diagnostics redaction, so it can never appear in an exported log.
 */
export function createDeviceKeys(
  service: string,
  entry: (service: string, account: string) => KeyEntry,
  onSecret: (secret: string) => void = () => undefined,
) {
  let current: DeviceKey | null = null;
  let vaultFailed = false;

  function read(): KeyObject | null {
    try {
      const text = entry(service, DEVICE_KEY_ACCOUNT).getPassword();
      if (text === null || text === '') return null;
      onSecret(text);
      return keyFromText(text);
    } catch (e) {
      vaultFailed = true;
      console.warn(`Device key: could not read the vault (${errorName(e)}).`);
      return null;
    }
  }

  return {
    /** The device id when a key exists, without making one (`identity:get`). */
    peek(): { device: string | null; unsigned: boolean } {
      if (current) return { device: current.signer.device, unsigned: !current.stored };
      const key = read();
      if (key) current = { signer: signerFromKey(key), stored: true };
      return { device: current?.signer.device ?? null, unsigned: vaultFailed };
    },

    /** The device key, made and stored on first need. */
    get(): DeviceKey {
      if (current) return current;
      const existing = read();
      if (existing) {
        current = { signer: signerFromKey(existing), stored: true };
        return current;
      }
      const { privateKey } = generateKeyPairSync('ed25519');
      let stored = false;
      if (!vaultFailed) {
        const text = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
        onSecret(text);
        try {
          entry(service, DEVICE_KEY_ACCOUNT).setPassword(text);
          stored = true;
        } catch (e) {
          vaultFailed = true;
          console.warn(`Device key: could not store the key in the vault (${errorName(e)}).`);
        }
      }
      current = { signer: signerFromKey(privateKey), stored };
      return current;
    },
  };
}

export type DeviceKeys = ReturnType<typeof createDeviceKeys>;

// ---------------------------------------------------------------- identity cards (.aioid)

const CARD_MAX_BYTES = 64 * 1024;

function hashWithoutSig(record: Record<string, unknown>): string {
  return contentHash({ ...record, sig: undefined });
}

/** This person's identity card, self-signed by the device (`aio.idcard/1`). */
export function makeCard(
  identity: Identity,
  signer: Signer,
  app: AppStamp,
  at: Date,
): IdentityCard {
  const body = {
    schema: IDENTITY_CARD_SCHEMA,
    actor: identity.actor,
    name: identity.name,
    initials: identity.initials,
    ...(identity.email ? { email: identity.email } : {}),
    device: { id: signer.device, alg: 'ed25519' as const, key: signer.publicKey },
    app,
    createdAt: at.toISOString(),
  };
  return IdentityCard.parse({ ...body, sig: signer.sign('aio.idcard/1', hashWithoutSig(body)) });
}

export type CardCheck = { ok: true; card: IdentityCard } | { ok: false; error: string };

/** Read and check a card: shape, device id against its key, and the self-signature. */
export function checkCard(text: string): CardCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, error: 'This file is not an identity card.' };
  }
  const parsed = IdentityCard.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'This file is not an identity card.' };
  const card = parsed.data;
  if (deviceIdOf(card.device.key) !== card.device.id) {
    return { ok: false, error: 'The device on this identity card does not match its key.' };
  }
  const hash = hashWithoutSig(raw as Record<string, unknown>);
  if (!verifySignature(card.device.key, 'aio.idcard/1', hash, card.sig)) {
    return {
      ok: false,
      error:
        'The signature on this identity card does not match. It was changed after it was made.',
    };
  }
  return { ok: true, card };
}

function deviceIdOf(key: string): string {
  return deviceIdFromKey(Buffer.from(key, 'base64url'));
}

async function readCardText(card: string): Promise<string> {
  if (card.trimStart().startsWith('{')) return card;
  const info = await stat(card);
  if (info.size > CARD_MAX_BYTES) throw new Error('This file is too large to be an identity card.');
  return readFile(card, 'utf8');
}

// ---------------------------------------------------------------- the team journal

/** One team op to write: this device stamps, chains and signs it. */
export interface TeamEntry {
  kind: 'member.add' | 'member.role' | 'member.remove' | 'device.revoke';
  target: { rec: string; id: string };
  payload: unknown;
}

/** What identity needs of the project journal: T1's journal service (`teamJournal`). */
export interface TeamJournal {
  /** Every op of the project, raw JSON (verification works on raw lines). */
  ops(root: string): Promise<Record<string, unknown>[]>;
  /** Append one op by this person and device; fsync before it resolves. */
  append(root: string, actor: string, key: DeviceKey, entry: TeamEntry): Promise<Op>;
  /** Write this device's public record into `journal/devices/` when it is missing. */
  publishDevice(root: string, record: DeviceRecord): Promise<void>;
}

/** The public record of this device, self-signed (`aio.device/1`). */
export function deviceRecord(
  identity: Identity,
  signer: Signer,
  app: AppStamp,
  at: Date,
): DeviceRecord {
  const body = {
    schema: DEVICE_SCHEMA,
    id: signer.device,
    alg: 'ed25519' as const,
    key: signer.publicKey,
    actor: identity.actor,
    name: identity.name,
    initials: identity.initials,
    app,
    createdAt: at.toISOString(),
    certs: [],
  };
  return { ...body, sig: signer.sign('aio.device/1', hashWithoutSig(body)) };
}

// ---------------------------------------------------------------- the service

export interface IdentityServiceDeps {
  store: IdentityStore;
  keys: DeviceKeys;
  journal: TeamJournal;
  /** Root folder of a folder project; undefined for packages and unknown ids. */
  projectRoot: (id: string) => string | undefined;
  isPackage: (id: string) => boolean;
  /** Save dialog for the card; null on cancel. */
  chooseCardPath: (defaultName: string) => Promise<string | null>;
  app: AppStamp;
  now?: () => Date;
}

interface Failure {
  ok: false;
  error: string;
  code?: 'read-only' | 'forbidden';
}

const fail = (error: string, code?: Failure['code']): Failure =>
  code ? { ok: false, error, code } : { ok: false, error };

function cardFileName(identity: Identity): string {
  const clean = identity.name.replace(/[<>:"/\\|?*\p{Cc}]/gu, '').trim() || 'identity';
  return `${clean}${IDENTITY_CARD_EXTENSION}`;
}

/** A sealed op by this person that is never written: to ask the team "would this apply?". */
function draftOp(
  actor: string,
  key: DeviceKey,
  entry: TeamEntry,
  ops: readonly Record<string, unknown>[],
): Op {
  const device = key.signer.device;
  const clock = createClock(device);
  const newest = ops
    .map((o) => o.hlc)
    .filter((h): h is string => typeof h === 'string')
    .sort(compareHlc)
    .pop();
  if (newest) clock.receive(newest);
  return sealOp(
    {
      v: 1,
      chain: `${device}.r_${'a'.repeat(16)}`,
      dev: device,
      act: actor,
      seq: 1,
      hlc: clock.tick(),
      prev: null,
      kind: entry.kind,
      target: entry.target,
    },
    entry.payload,
    key.signer,
  );
}

export function createIdentityService(deps: IdentityServiceDeps) {
  const now = deps.now ?? (() => new Date());

  function folder(projectId: string): { root: string } | Failure {
    if (deps.isPackage(projectId)) {
      return fail(
        'A package is read-only. Extract it to a folder project to manage members.',
        'read-only',
      );
    }
    const root = deps.projectRoot(projectId);
    return root ? { root } : fail('This project is not open.');
  }

  async function team(
    root: string,
  ): Promise<{ ops: Record<string, unknown>[]; replay: TeamReplay }> {
    const ops = await deps.journal.ops(root);
    return { ops, replay: replayTeam(ops) };
  }

  /** Is the person allowed to change the team, with the reason when not. */
  function adminRefusal(replay: TeamReplay, identity: Identity, key: DeviceKey): string | null {
    const me = replay.members.find((m) => m.actor === identity.actor);
    if (!me)
      return `You (${identity.name}) are not a member of this project. Only an owner can change members.`;
    if (me.role !== 'owner') return roleRefusal(me.name, me.role, 'admin', replay.policy);
    const device = me.devices.find((d) => d.id === key.signer.device);
    if (!device) {
      return 'This computer is not one of your devices in this project. Ask another owner to add it from your identity card.';
    }
    if (device.revoked)
      return 'This computer was revoked for this project. Ask another owner to add a new device.';
    return null;
  }

  /** Write one team op after checking it would apply; the verdict's reason when it would not. */
  async function write(
    root: string,
    identity: Identity,
    key: DeviceKey,
    entry: TeamEntry,
    ops: Record<string, unknown>[],
  ): Promise<Failure | { ok: true }> {
    const draft = draftOp(identity.actor, key, entry, ops);
    const verdict = replayTeam([...ops, draft]).verdicts.get(draft.id);
    if (verdict && !verdict.ok) return fail(verdict.reason, 'forbidden');
    await deps.journal.publishDevice(root, deviceRecord(identity, key.signer, deps.app, now()));
    await deps.journal.append(root, identity.actor, key, entry);
    return { ok: true };
  }

  /** The signed device key a team change needs, or why there is none. */
  function signingKey(): DeviceKey | Failure {
    const key = deps.keys.get();
    if (!key.stored) {
      return fail(
        'Your device key could not be kept in the credential store, so team changes cannot be signed on this computer.',
      );
    }
    return key;
  }

  /** Shared changes need a team: members:setRole, members:remove, members:revokeDevice. */
  async function change(
    projectId: string,
    entry: (replay: TeamReplay) => TeamEntry | Failure,
  ): Promise<{ ok: true } | Failure> {
    const where = folder(projectId);
    if ('ok' in where) return where;
    const { ops, replay } = await team(where.root);
    if (!replay.shared) return fail('This project is not shared, so it has no members to change.');
    const identity = await deps.store.get();
    const key = signingKey();
    if ('ok' in key) return key;
    const refusal = adminRefusal(replay, identity, key);
    if (refusal) return fail(refusal, 'forbidden');
    const e = entry(replay);
    if ('ok' in e) return e;
    return write(where.root, identity, key, e, ops);
  }

  const memberOf = (replay: TeamReplay, actor: string) =>
    replay.members.find((m) => m.actor === actor);

  return {
    /** For T1's journal service: who writes and with which key. */
    identity: () => deps.store.get(),
    deviceKey: () => deps.keys.get(),

    /**
     * Sharing (T5): the person who shares becomes the first owner, with this device, unless the
     * project already has a team. Idempotent.
     */
    async shareAsOwner(projectId: string): Promise<{ ok: true } | Failure> {
      const where = folder(projectId);
      if ('ok' in where) return where;
      const { ops, replay } = await team(where.root);
      if (replay.shared) return { ok: true };
      const identity = await deps.store.get();
      const key = signingKey();
      if ('ok' in key) return key;
      return write(
        where.root,
        identity,
        key,
        {
          kind: 'member.add',
          target: { rec: 'member', id: identity.actor },
          payload: {
            actor: identity.actor,
            name: identity.name,
            initials: identity.initials,
            ...(identity.email ? { email: identity.email } : {}),
            role: 'owner',
            devices: [{ id: key.signer.device, key: key.signer.publicKey }],
          },
        },
        ops,
      );
    },

    /**
     * Team server (T7): add people the server granted (enrolled devices) who are not members yet.
     * Owner only; each is one `member.add` with the role the server gave.
     */
    async addGranted(
      projectId: string,
      granted: readonly {
        actor: string;
        name: string;
        initials: string;
        role: Role;
        devices: readonly { id: string; key: string }[];
      }[],
    ): Promise<{ ok: true; added: number } | Failure> {
      const where = folder(projectId);
      if ('ok' in where) return where;
      let { ops, replay } = await team(where.root);
      if (!replay.shared) return { ok: true, added: 0 };
      const identity = await deps.store.get();
      if (memberOf(replay, identity.actor)?.role !== 'owner') return { ok: true, added: 0 };
      const key = signingKey();
      if ('ok' in key) return key;
      let added = 0;
      for (const g of granted) {
        if (memberOf(replay, g.actor) || g.devices.length === 0) continue;
        const r = await write(
          where.root,
          identity,
          key,
          {
            kind: 'member.add',
            target: { rec: 'member', id: g.actor },
            payload: {
              actor: g.actor,
              name: g.name,
              initials: g.initials,
              role: g.role,
              devices: g.devices.map((d) => ({ id: d.id, key: d.key })),
            },
          },
          ops,
        );
        if (r.ok) added++;
        ({ ops, replay } = await team(where.root));
      }
      return { ok: true, added };
    },

    async get(): Promise<IpcResponse<'identity:get'>> {
      const identity = await deps.store.get();
      const { device, unsigned } = deps.keys.peek();
      return { ok: true, identity, device, unsigned };
    },

    async set(req: IpcRequest<'identity:set'>): Promise<IpcResponse<'identity:set'>> {
      return { ok: true, identity: await deps.store.set(req) };
    },

    async exportCard(): Promise<IpcResponse<'identity:exportCard'>> {
      const identity = await deps.store.get();
      const key = signingKey();
      if ('ok' in key) return key;
      const path = await deps.chooseCardPath(cardFileName(identity));
      if (path === null) return { ok: true, path: null };
      await writeJsonAtomic(path, makeCard(identity, key.signer, deps.app, now()));
      return { ok: true, path };
    },

    async importCard(
      req: IpcRequest<'identity:importCard'>,
    ): Promise<IpcResponse<'identity:importCard'>> {
      const r = checkCard(await readCardText(req.path));
      if (!r.ok) return fail(r.error);
      const { card } = r;
      return {
        ok: true,
        actor: card.actor,
        name: card.name,
        initials: card.initials,
        device: card.device.id,
      };
    },

    async list(req: IpcRequest<'members:list'>): Promise<IpcResponse<'members:list'>> {
      if (deps.isPackage(req.projectId)) return { ok: true, members: [] };
      const where = folder(req.projectId);
      if ('ok' in where) return where;
      const { replay } = await team(where.root);
      if (!replay.shared) return { ok: true, members: [] };
      const identity = await deps.store.get();
      const me = memberOf(replay, identity.actor)?.role;
      return { ok: true, members: replay.members, ...(me ? { me } : {}) };
    },

    async add(req: IpcRequest<'members:add'>): Promise<IpcResponse<'members:add'>> {
      const where = folder(req.projectId);
      if ('ok' in where) return where;
      let text: string;
      try {
        text = await readCardText(req.card);
      } catch (e) {
        return fail(e instanceof Error ? e.message : 'The identity card could not be read.');
      }
      const checked = checkCard(text);
      if (!checked.ok) return fail(checked.error);
      const { card } = checked;
      const identity = await deps.store.get();
      if (card.actor === identity.actor) {
        return fail(
          'This is your own identity card. Add the card of the person you want to invite.',
        );
      }
      const key = signingKey();
      if ('ok' in key) return key;
      let { ops, replay } = await team(where.root);
      if (!replay.shared) {
        // the person who shares is the first owner (file mode): add yourself, then the card
        const first = await write(
          where.root,
          identity,
          key,
          {
            kind: 'member.add',
            target: { rec: 'member', id: identity.actor },
            payload: {
              actor: identity.actor,
              name: identity.name,
              initials: identity.initials,
              ...(identity.email ? { email: identity.email } : {}),
              role: 'owner',
              devices: [{ id: key.signer.device, key: key.signer.publicKey }],
            },
          },
          ops,
        );
        if (!first.ok) return first;
        ({ ops, replay } = await team(where.root));
      }
      const refusal = adminRefusal(replay, identity, key);
      if (refusal) return fail(refusal, 'forbidden');
      const existing = memberOf(replay, card.actor);
      if (existing?.devices.some((d) => d.id === card.device.id)) {
        return fail(
          `${existing.name} is already a member (${existing.role}). Change the role in the members list.`,
        );
      }
      const cert = req.certify
        ? certifyDevice(key.signer, identity.actor, card.actor, card.device.id, now().toISOString())
        : undefined;
      const added = await write(
        where.root,
        identity,
        key,
        {
          kind: 'member.add',
          target: { rec: 'member', id: card.actor },
          payload: {
            actor: card.actor,
            name: card.name,
            initials: card.initials,
            ...(card.email ? { email: card.email } : {}),
            role: req.role,
            devices: [{ id: card.device.id, key: card.device.key }],
            ...(cert ? { cert } : {}),
          },
        },
        ops,
      );
      if (!added.ok) return added;
      const member: Member | undefined = memberOf((await team(where.root)).replay, card.actor);
      return member ? { ok: true, member } : fail(`${card.name} could not be added.`);
    },

    setRole(req: IpcRequest<'members:setRole'>) {
      return change(req.projectId, (replay) =>
        memberOf(replay, req.actor)
          ? {
              kind: 'member.role',
              target: { rec: 'member', id: req.actor },
              payload: { actor: req.actor, role: req.role satisfies Role },
            }
          : fail('This person is not a member of the project.'),
      );
    },

    remove(req: IpcRequest<'members:remove'>) {
      return change(req.projectId, (replay) =>
        memberOf(replay, req.actor)
          ? {
              kind: 'member.remove',
              target: { rec: 'member', id: req.actor },
              payload: { actor: req.actor },
            }
          : fail('This person is not a member of the project.'),
      );
    },

    revokeDevice(req: IpcRequest<'members:revokeDevice'>) {
      return change(req.projectId, (replay) => {
        const owner = replay.members.find((m) => m.devices.some((d) => d.id === req.device));
        if (!owner) return fail('This device is not part of the team.');
        if (owner.devices.find((d) => d.id === req.device)?.revoked) {
          return fail(`This device of ${owner.name} is already revoked.`);
        }
        return {
          kind: 'device.revoke',
          target: { rec: 'device', id: req.device },
          payload: { device: req.device, ...(req.reason ? { reason: req.reason } : {}) },
        };
      });
    },
  };
}

export type IdentityService = ReturnType<typeof createIdentityService>;

// ---------------------------------------------------------------- IPC

export interface IdentityIpcDeps {
  handle: Handle;
  service: IdentityService;
}

/** Errors become a failure the renderer shows, never a rejected invoke. */
function guarded<R>(run: () => Promise<R>): Promise<R | Failure> {
  return run().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
}

export function registerIdentityIpc({ handle, service }: IdentityIpcDeps): void {
  handle('identity:get', () => guarded(() => service.get()));
  handle('identity:set', (req) => guarded(() => service.set(req)));
  handle('identity:exportCard', () => guarded(() => service.exportCard()));
  handle('identity:importCard', (req) => guarded(() => service.importCard(req)));
  handle('members:list', (req) => guarded(() => service.list(req)));
  handle('members:add', (req) => guarded(() => service.add(req)));
  handle('members:setRole', (req) => guarded(() => service.setRole(req)));
  handle('members:remove', (req) => guarded(() => service.remove(req)));
  handle('members:revokeDevice', (req) => guarded(() => service.revokeDevice(req)));
}
