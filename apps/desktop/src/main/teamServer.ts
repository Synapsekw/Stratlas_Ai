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
 *
 * The server's signing key (2026-10-21) is pinned too: at enrolment, or for an enrolment from an
 * older server, on the next contact once the server names it. Push receipts are then checked
 * against it, and a server that later names another key is refused.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Signer } from '@aio/journal';
import {
  DeviceCert,
  PublicKeyB64,
  ServerInfo,
  type DeviceRecord,
  type ServerKey,
} from '@aio/schema';
import {
  createHttpClient,
  createHttpTransport,
  enrolDevice,
  probeFingerprint,
  serverCertProblem,
  serverHealth,
  serverIdFromKey,
  serverOrigin,
  TeamServerError,
  type HttpClient,
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

/** Gives the device identity; null when there is none (no vault): T2's `deviceSource`. */
export type DeviceSource = () => Promise<DeviceIdentity | null>;

export const SERVERS_FILE = join('team', 'servers.json');
export const SERVERS_SCHEMA = 'aio.team-servers/1';

const StoredServer = ServerInfo.extend({
  cert: DeviceCert,
  /** The server's signing key (absent for an enrolment from an older server, until pinned). */
  publicKey: PublicKeyB64.optional(),
});
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

const KEY_CHANGED =
  "This team server's signing key changed since this computer connected to it. Ask your IT team before you connect again.";

const ENROL_KEY_MISMATCH =
  'This team server named two different signing keys while connecting. Ask your IT team before you connect.';

/**
 * The signing key a new enrolment pins: the enrol answer's, else the one health named. Both must
 * agree and belong to the enrolled server id; a key only health named must have signed the
 * device certificate (the enrol answer's own key is checked by `enrolDevice`).
 */
function enrolKey(
  enrolled: { id: string; publicKey?: string | undefined },
  named: ServerKey | undefined,
  cert: DeviceCert,
  record: DeviceRecord,
): string | undefined {
  if (named && named.id !== enrolled.id) throw new TeamServerError('protocol', ENROL_KEY_MISMATCH);
  if (enrolled.publicKey && named && named.publicKey !== enrolled.publicKey)
    throw new TeamServerError('protocol', ENROL_KEY_MISMATCH);
  const publicKey = enrolled.publicKey ?? named?.publicKey;
  if (publicKey === undefined) return undefined;
  if (serverIdFromKey(publicKey) !== enrolled.id)
    throw new TeamServerError('protocol', ENROL_KEY_MISMATCH);
  const problem = serverCertProblem({ id: enrolled.id, publicKey }, cert, record);
  if (problem) {
    throw new TeamServerError(
      'protocol',
      `The team server sent a device certificate that does not verify: ${problem}. Ask your IT team before you connect.`,
    );
  }
  return publicKey;
}

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
    delete info.publicKey;
    return ServerInfo.parse(info);
  };

  const clientFor = (server: StoredServer, signer: Signer): HttpClient =>
    createHttpClient({ baseUrl: server.url, fingerprint: server.fingerprint, signer });

  /**
   * Health over the pinned certificate, holding the server to its signing key: a server that names
   * another id or key than the pinned one is refused; an enrolment without a pinned key pins the
   * key the server names for its own id.
   */
  async function healthPinned(server: StoredServer, client: HttpClient) {
    const health = await serverHealth(client);
    const named = health.server;
    if (!named) return { health, server };
    if (named.id !== server.id || (server.publicKey && named.publicKey !== server.publicKey))
      throw new TeamServerError('fingerprint', KEY_CHANGED);
    if (server.publicKey) return { health, server };
    const pinned: StoredServer = { ...server, publicKey: named.publicKey };
    await write(read().map((s) => (s.id === server.id ? pinned : s)));
    return { health, server: pinned };
  }

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
        const pinned = req.fingerprint;
        const connect = (coverHeaders: boolean) =>
          createHttpClient({
            baseUrl: origin,
            fingerprint: pinned,
            signer: device.signer,
            coverHeaders,
          });
        const health = await serverHealth(connect(false));
        // a server that names its signing key also checks signed content types
        const r = await enrolDevice(connect(health.server !== undefined), req.code, device.record);
        const publicKey = enrolKey(r.server, health.server, r.cert, device.record);
        const server: StoredServer = {
          id: r.server.id,
          url: origin,
          name: r.server.name,
          fingerprint: req.fingerprint,
          version: health.version,
          enrolledAt: now().toISOString(),
          role: r.role,
          cert: r.cert,
          ...(publicKey ? { publicKey } : {}),
        };
        await write([...read().filter((s) => s.id !== server.id && s.url !== origin), server]);
        return { ok: true as const, server: publicInfo(server) };
      } catch (e) {
        return failure(e);
      }
    },

    /** Is the server reachable now: its health, over a request signed by this device. */
    async check(id: string) {
      const server = read().find((s) => s.id === id);
      if (!server)
        return { ok: false as const, error: 'This server is not connected on this computer.' };
      const checkedAt = now().toISOString();
      if (deps.offlineOnly()) {
        return {
          ok: true as const,
          server: { ...publicInfo(server), reachable: false, checkedAt },
        };
      }
      const device = await deps.device();
      if (!device) return { ok: false as const, error: 'This computer has no device key.' };
      try {
        const { health } = await healthPinned(server, clientFor(server, device.signer));
        return {
          ok: true as const,
          server: { ...publicInfo(server), version: health.version, reachable: true, checkedAt },
        };
      } catch {
        return {
          ok: true as const,
          server: { ...publicInfo(server), reachable: false, checkedAt },
        };
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
      const stored = read().find((s) => s.id === serverId);
      if (!stored)
        throw new TeamServerError('not-found', 'This server is not connected on this computer.');
      const device = await deps.device();
      if (!device) throw new TeamServerError('unauthorized', 'This computer has no device key.');
      const { server } = await healthPinned(stored, clientFor(stored, device.signer));
      return createHttpTransport({
        // a server that names its signing key also checks signed content types and ranges
        client: createHttpClient({
          baseUrl: stored.url,
          fingerprint: stored.fingerprint,
          signer: device.signer,
          coverHeaders: server.publicKey !== undefined,
        }),
        teamProjectId,
        ...(server.publicKey ? { server: { id: server.id, publicKey: server.publicKey } } : {}),
      });
    },
  };
}

export type TeamServers = ReturnType<typeof teamServers>;

export interface TeamServerIpcDeps extends Partial<TeamServerDeps> {
  handle: Handle;
  /** The servers main already made (shared with sync); else made from the deps. */
  servers?: TeamServers;
}

export function registerTeamServerIpc({
  handle,
  servers: given,
  ...deps
}: TeamServerIpcDeps): void {
  const servers =
    given ??
    (deps.userData && deps.offlineOnly && deps.device
      ? teamServers({
          userData: deps.userData,
          offlineOnly: deps.offlineOnly,
          device: deps.device,
          ...(deps.now ? { now: deps.now } : {}),
        })
      : null);
  if (!servers) {
    // not wired (tests of other modules): the T0 behaviour
    handle('server:enrol', () => notYet('The team server (preview)'));
    handle('server:list', () => ({ servers: [] }));
    handle('server:check', () => notYet('The team server (preview)'));
    handle('server:forget', () => notYet('The team server (preview)'));
    return;
  }
  handle('server:enrol', (req) => servers.enrol(req));
  handle('server:list', () => ({ servers: servers.list() }));
  handle('server:check', (req) => servers.check(req.id));
  handle('server:forget', (req) => servers.forget(req.id));
}
