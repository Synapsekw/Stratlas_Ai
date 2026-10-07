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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Signer } from '@aio/journal';
import { DeviceCert, ServerInfo, type DeviceRecord } from '@aio/schema';
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

/** Gives the device identity; null when there is none (no vault): T2's `deviceSource`. */
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
        const health = await serverHealth(
          createHttpClient({
            baseUrl: server.url,
            fingerprint: server.fingerprint,
            signer: device.signer,
          }),
        );
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
