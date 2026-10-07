/**
 * The Team Server client (M9 stream T7, preview): enrolment with an invite code, a pinned
 * certificate fingerprint and per-device signed requests (`server:*`). The app talks to a server
 * only when the person connects one here or a server-mode project syncs, and never when the
 * offline-only setting is on. Enrolled servers are kept in `userData/team/servers.json` (public
 * data: address, fingerprint, the server's certificate for this device); the device key stays in
 * the OS vault.
 *
 * `teamServers(...)` is also what the sync module (T5) uses for a server-mode project:
 * `transport(serverId, teamProjectId)` is an `HttpTransport` pinned to the accepted certificate.
 */
import { generateKeyPairSync, createPrivateKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { contentHash, randomId, signerFromKey, type Signer } from '@aio/journal';
import {
  DeviceCert,
  Identity,
  IDENTITY_FILE,
  ServerInfo,
  type AppStamp,
  type DeviceRecord,
} from '@aio/schema';
import {
  createHttpClient,
  createHttpTransport,
  enrolDevice,
  probeFingerprint,
  serverHealth,
  serverOrigin,
  TeamServerError,
  type HttpTransport,
} from '@aio/sync/http';
import { z } from 'zod';
import { writeJsonAtomic } from './fsutil';
import { notYet, type Handle } from './notYet';

/** This device as the team server sees it: the signer (vault key) and its public record. */
export interface DeviceIdentity {
  signer: Signer;
  record: DeviceRecord;
}

/** Gives the device identity; null when there is none (no vault). T2's identity plugs in here. */
export type DeviceSource = () => Promise<DeviceIdentity | null>;

export const SERVERS_FILE = join('team', 'servers.json');
export const SERVERS_SCHEMA = 'aio.team-servers/1';

const StoredServer = ServerInfo.extend({ cert: DeviceCert });
const ServersFile = z.object({
  schema: z.literal(SERVERS_SCHEMA),
  servers: z.array(StoredServer),
});
type StoredServer = z.infer<typeof StoredServer>;

export interface TeamServerDeps {
  userData: () => string;
  offlineOnly: () => boolean;
  device: DeviceSource;
  now?: () => Date;
}

const OFFLINE =
  'Offline only is on, so this computer makes no network connections. Turn it off in Settings, Privacy and cloud to connect to a team server.';

function failure(e: unknown) {
  if (e instanceof TeamServerError) {
    return {
      ok: false as const,
      error: e.message,
      ...(e.code === 'forbidden' ? { code: 'forbidden' as const } : {}),
    };
  }
  return { ok: false as const, error: 'The team server could not be reached.' };
}

export function teamServers(deps: TeamServerDeps) {
  const file = () => join(deps.userData(), SERVERS_FILE);
  const now = deps.now ?? (() => new Date());

  function read(): StoredServer[] {
    if (!existsSync(file())) return [];
    try {
      return ServersFile.parse(JSON.parse(readFileSync(file(), 'utf8'))).servers;
    } catch {
      console.warn('Team servers: the list of servers could not be read; it is ignored.');
      return [];
    }
  }

  async function write(servers: StoredServer[]): Promise<void> {
    mkdirSync(dirname(file()), { recursive: true });
    await writeJsonAtomic(file(), { schema: SERVERS_SCHEMA, servers });
  }

  const publicInfo = (s: StoredServer): ServerInfo => {
    const info: Partial<StoredServer> = { ...s };
    delete info.cert;
    return ServerInfo.parse(info);
  };

  return {
    list: (): ServerInfo[] => read().map(publicInfo),

    /** First contact (no fingerprint): the certificate to show. Then: enrol, pinned to it. */
    async enrol(req: { url: string; code: string; fingerprint?: string | undefined }) {
      if (deps.offlineOnly())
        return { ok: false as const, error: OFFLINE, code: 'offline-only' as const };
      try {
        const origin = serverOrigin(req.url);
        if (!req.fingerprint) {
          const fingerprint = await probeFingerprint(origin);
          return {
            ok: false as const,
            error: 'Check the certificate fingerprint with your IT team before you connect.',
            fingerprint,
          };
        }
        const device = await deps.device();
        if (!device)
          return {
            ok: false as const,
            error:
              'This computer has no device key: the system vault is not available. Ask your IT team to check the Windows Credential Manager or the macOS Keychain.',
          };
        const client = createHttpClient({
          baseUrl: origin,
          fingerprint: req.fingerprint,
          signer: device.signer,
        });
        const health = await serverHealth(client);
        const r = await enrolDevice(client, req.code, device.record);
        const server: StoredServer = {
          id: r.server.id,
          url: origin,
          name: r.server.name,
          fingerprint: req.fingerprint,
          version: health.version,
          enrolledAt: now().toISOString(),
          role: r.role,
          cert: r.cert,
        };
        await write([...read().filter((s) => s.id !== server.id && s.url !== origin), server]);
        return { ok: true as const, server: publicInfo(server) };
      } catch (e) {
        return failure(e);
      }
    },

    async forget(id: string) {
      const servers = read();
      if (!servers.some((s) => s.id === id))
        return { ok: false as const, error: 'This server is not connected on this computer.' };
      await write(servers.filter((s) => s.id !== id));
      return { ok: true as const };
    },

    /** The sync transport of a server-mode project (T5), pinned to the accepted certificate. */
    async transport(serverId: string, teamProjectId: string): Promise<HttpTransport> {
      if (deps.offlineOnly()) throw new TeamServerError('unreachable', OFFLINE);
      const server = read().find((s) => s.id === serverId);
      if (!server)
        throw new TeamServerError('not-found', 'This server is not connected on this computer.');
      const device = await deps.device();
      if (!device) throw new TeamServerError('unauthorized', 'This computer has no device key.');
      return createHttpTransport({
        client: createHttpClient({
          baseUrl: server.url,
          fingerprint: server.fingerprint,
          signer: device.signer,
        }),
        teamProjectId,
      });
    },
  };
}

export interface TeamServerIpcDeps extends Partial<TeamServerDeps> {
  handle: Handle;
}

export function registerTeamServerIpc({ handle, ...deps }: TeamServerIpcDeps): void {
  if (!deps.userData || !deps.offlineOnly || !deps.device) {
    // not wired (tests of other modules): the T0 behaviour
    handle('server:enrol', () => notYet('The team server (preview)'));
    handle('server:list', () => ({ servers: [] }));
    handle('server:forget', () => notYet('The team server (preview)'));
    return;
  }
  const servers = teamServers({
    userData: deps.userData,
    offlineOnly: deps.offlineOnly,
    device: deps.device,
    ...(deps.now ? { now: deps.now } : {}),
  });
  handle('server:enrol', (req) => servers.enrol(req));
  handle('server:list', () => ({ servers: servers.list() }));
  handle('server:forget', (req) => servers.forget(req.id));
}

// ---- interim device key (until T2's identity provides the device key) ----

/** Vault account of the interim key. T2's `device-signing` replaces it at integration. */
export const INTERIM_DEVICE_ACCOUNT = 'team-server-device';

/** The slice of `@napi-rs/keyring` Entry used here (injectable for tests). */
export interface VaultEntry {
  setPassword(password: string): void;
  getPassword(): string | null;
}

const VaultValue = z.object({
  pkcs8: z.string().min(1),
  actor: z.string().regex(/^a_[a-z2-7]{26}$/),
});

/** Initials from a name: first letters of the first and last words (any script), at most 3. */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .map((w) => /\p{L}/u.exec(w)?.[0] ?? '')
    .filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words.slice(0, 1);
  const out = letters.join('').toUpperCase().slice(0, 3);
  return out || 'U';
}

/**
 * INTERIM (T7, until T2 lands): a device key of its own in the vault (account
 * `team-server-device`, service as the AI keys: `.isolated` in test runs), and the person's name
 * from T2's `identity.json` when it exists, else the OS account. At integration, pass T2's device
 * source to `registerTeamServerIpc` and delete this.
 */
export function interimDeviceSource(opts: {
  userData: () => string;
  vault: (account: string) => VaultEntry;
  app: AppStamp;
  /**
   * Test profiles only (`STRATLAS_USER_DATA`): when the vault cannot be used (a CI keychain),
   * keep a key for this run in memory instead of giving no device.
   */
  sessionKeyWithoutVault?: boolean;
}): DeviceSource {
  let cached: DeviceIdentity | null = null;
  return () => {
    if (cached) return Promise.resolve(cached);
    let stored: z.infer<typeof VaultValue>;
    try {
      const entry = opts.vault(INTERIM_DEVICE_ACCOUNT);
      const existing = VaultValue.safeParse(JSON.parse(entry.getPassword() ?? 'null'));
      if (existing.success) stored = existing.data;
      else {
        const pkcs8 = generateKeyPairSync('ed25519')
          .privateKey.export({ format: 'der', type: 'pkcs8' })
          .toString('base64');
        stored = { pkcs8, actor: randomId('a_', 26) };
        entry.setPassword(JSON.stringify(stored));
      }
    } catch (e) {
      console.warn(
        `Team server: the vault is not available (${e instanceof Error ? e.name : 'error'}).`,
      );
      if (!opts.sessionKeyWithoutVault) return Promise.resolve(null);
      const pkcs8 = generateKeyPairSync('ed25519')
        .privateKey.export({ format: 'der', type: 'pkcs8' })
        .toString('base64');
      stored = { pkcs8, actor: randomId('a_', 26) };
    }
    const signer = signerFromKey(
      createPrivateKey({ key: Buffer.from(stored.pkcs8, 'base64'), format: 'der', type: 'pkcs8' }),
    );
    let who = { actor: stored.actor, name: osName(), initials: '' };
    try {
      const id = Identity.safeParse(
        JSON.parse(readFileSync(join(opts.userData(), IDENTITY_FILE), 'utf8')),
      );
      if (id.success)
        who = { actor: id.data.actor, name: id.data.name, initials: id.data.initials };
    } catch {
      // no identity file yet (T2): the OS account name
    }
    const rec = {
      schema: 'aio.device/1' as const,
      id: signer.device,
      alg: 'ed25519' as const,
      key: signer.publicKey,
      actor: who.actor,
      name: who.name,
      initials: who.initials || initialsOf(who.name),
      app: opts.app,
      createdAt: new Date().toISOString(),
      certs: [],
    };
    cached = { signer, record: { ...rec, sig: signer.sign('aio.device/1', contentHash(rec)) } };
    return Promise.resolve(cached);
  };
}

function osName(): string {
  try {
    const n = userInfo().username.trim().slice(0, 80);
    return n || 'Reviewer';
  } catch {
    return 'Reviewer';
  }
}
