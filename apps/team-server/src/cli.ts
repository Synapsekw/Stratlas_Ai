/**
 * The admin command line (no web UI in M9):
 *
 *   serve                         start the server (the image's default command)
 *   migrate                       bring the database up to date
 *   create-team --name <name>     name this server and print the first owner invite
 *   invite --role <role> [--project <t_...>] [--days <n>]
 *   devices                       list enrolled devices
 *   revoke-device <d_...> [--reason <text>]
 *   export-audit --project <t_...> --out <folder>
 *   verify <folder>               check an audit export
 *   backup --out <file>           write a backup of the database
 *   restore --in <file>           restore a backup into an empty database
 *   version
 *
 * Settings come from the environment (`config.ts`); `serve --memory` runs a throw-away trial.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { Role, TeamProjectId } from '@aio/schema';
import { exportAudit, verifyAuditExport } from './audit';
import { makeInvite } from './auth/enrol';
import { backup, restore } from './backup';
import { createFsBlobStore } from './blobs/fs';
import { createS3BlobStore } from './blobs/s3';
import { ConfigError, readConfig, requireTls, type ServerConfig } from './config';
import { ephemeralIdentity, loadOrCreateIdentity } from './identity';
import { productName } from './preview';
import { buildServer } from './server';
import { createMemoryStore } from './store/memory';
import { createPostgresStore } from './store/postgres';
import type { Store } from './store/store';
import { SERVER_VERSION } from './version';

export interface CliIo {
  env: NodeJS.ProcessEnv;
  print: (line: string) => void;
  error: (line: string) => void;
  /** Tests pass a store; otherwise DATABASE_URL (or `--memory` for serve). */
  store?: Store;
}

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): Args {
  const [command = 'serve', ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a.startsWith('--')) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(a.slice(2), next);
        i++;
      } else flags.set(a.slice(2), true);
    } else positional.push(a);
  }
  return { command, positional, flags };
}

class UsageError extends Error {}

const text = (args: Args, name: string): string | null => {
  const v = args.flags.get(name);
  if (v === true) throw new UsageError(`--${name} needs a value.`);
  return v ?? null;
};
const required = (args: Args, name: string): string => {
  const v = text(args, name);
  if (v === null) throw new UsageError(`--${name} is required.`);
  return v;
};

function openStore(config: ServerConfig, io: CliIo, memory: boolean): Store {
  if (io.store) return io.store;
  if (memory) return createMemoryStore();
  if (!config.databaseUrl)
    throw new ConfigError(
      'Set DATABASE_URL to the Postgres database (or run serve --memory for a trial).',
    );
  return createPostgresStore({ connectionString: config.databaseUrl });
}

async function serve(config: ServerConfig, store: Store, memory: boolean, io: CliIo) {
  requireTls(config);
  const identity = memory ? ephemeralIdentity() : loadOrCreateIdentity(config.keyFile);
  const blobs =
    config.blobStore === 's3'
      ? createS3BlobStore({
          endpoint: io.env.AIO_S3_ENDPOINT ?? '',
          bucket: io.env.AIO_S3_BUCKET ?? '',
        })
      : createFsBlobStore(config.blobDir);
  const app = buildServer({
    store,
    blobs,
    identity,
    version: SERVER_VERSION,
    name: (await store.meta('name')) ?? config.name,
    ...(config.tls ? { https: { cert: config.tls.cert, key: config.tls.key } } : {}),
    ...(config.fingerprint ? { fingerprint: config.fingerprint } : {}),
    ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
    trustProxy: config.behindProxy,
    logger: config.log,
  });
  await app.listen({ host: config.host, port: config.port });
  io.print(
    `${productName()} ${SERVER_VERSION} listening on ${config.tls ? 'https' : 'http'}://${config.host}:${config.port} (${store.kind} store${memory ? ': data is lost when it stops' : ''}).`,
  );
  if (config.fingerprint) io.print(`Certificate fingerprint (SHA-256): ${config.fingerprint}`);
  const stop = () => {
    void app.close().then(() => store.close());
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

/** Run one command; returns the exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const args = parseArgs(argv);
  let store: Store | null = null;
  try {
    if (args.command === 'version') {
      io.print(`${productName()} ${SERVER_VERSION}`);
      return 0;
    }
    if (args.command === 'verify') {
      const dir = args.positional[0];
      if (!dir) throw new UsageError('verify <folder>');
      const v = verifyAuditExport(dir);
      io.print(`${v.ops} ops in ${v.chains} chains, ${v.receipts} countersigned.`);
      for (const p of v.problems) io.print(`  problem: ${p}`);
      io.print(v.ok ? 'Verified: no problems.' : `Not verified: ${v.problems.length} problems.`);
      return v.ok ? 0 : 1;
    }
    const config = readConfig(io.env);
    const memory = args.flags.get('memory') === true;
    store = openStore(config, io, memory);
    await store.init();

    switch (args.command) {
      case 'serve':
        await serve(config, store, memory, io);
        store = null; // closed when the server stops
        return 0;
      case 'migrate':
        io.print(`The database is up to date (${store.kind}).`);
        return 0;
      case 'create-team': {
        const name = required(args, 'name').trim();
        if (!name || name.length > 200) throw new UsageError('--name is 1 to 200 characters.');
        await store.setMeta('name', name);
        const { code, invite } = makeInvite('owner', null, new Date());
        await store.addInvite(invite);
        io.print(`This server is now "${name}".`);
        io.print(`Owner invite code (valid 7 days, one use): ${code}`);
        return 0;
      }
      case 'invite': {
        const role = Role.safeParse(required(args, 'role'));
        if (!role.success) throw new UsageError('--role is owner, reviewer, viewer or client.');
        const projectArg = text(args, 'project');
        const project = projectArg === null ? null : TeamProjectId.safeParse(projectArg);
        if (project && !project.success)
          throw new UsageError('--project is a team project id (t_...).');
        const days = Number(text(args, 'days') ?? 7);
        if (!Number.isInteger(days) || days < 1 || days > 90)
          throw new UsageError('--days is 1 to 90.');
        const { code, invite } = makeInvite(role.data, project?.data ?? null, new Date(), days);
        await store.addInvite(invite);
        io.print(
          `Invite code for a ${role.data}${project ? ` of ${project.data}` : ''} (valid ${days} days, one use): ${code}`,
        );
        return 0;
      }
      case 'devices': {
        for (const d of await store.devices())
          io.print(
            `${d.device}  ${d.name} (${d.initials})  ${d.role}${d.project ? ` of ${d.project}` : ''}  enrolled ${d.enrolledAt}${d.revokedAt ? `  REVOKED ${d.revokedAt}` : ''}`,
          );
        return 0;
      }
      case 'revoke-device': {
        const id = args.positional[0];
        if (!id) throw new UsageError('revoke-device <device id>');
        const ok = await store.revokeDevice(id, new Date().toISOString(), text(args, 'reason'));
        if (!ok) throw new UsageError(`No enrolled device ${id}.`);
        io.print(`Revoked ${id}. Its requests are refused from now on.`);
        return 0;
      }
      case 'export-audit': {
        const project = required(args, 'project');
        const out = required(args, 'out');
        if (existsSync(out) && readdirSync(out).length > 0)
          throw new UsageError(`${out} is not empty.`);
        mkdirSync(out, { recursive: true });
        const s = await exportAudit(store, loadOrCreateIdentity(config.keyFile), project, out);
        io.print(`Exported ${s.ops} ops in ${s.chains} chains and their receipts to ${out}.`);
        return 0;
      }
      case 'backup': {
        const out = required(args, 'out');
        const identity = loadOrCreateIdentity(config.keyFile);
        const c = await backup(store, out, {
          id: identity.id,
          publicKey: identity.publicKey,
          version: SERVER_VERSION,
        });
        io.print(
          `Backed up ${c.projects} projects, ${c.ops} ops, ${c.receipts} receipts and ${c.devices} devices to ${out}.`,
        );
        io.print('Back up the blob folder and the server key file as well.');
        return 0;
      }
      case 'restore': {
        const c = await restore(store, required(args, 'in'));
        io.print(
          `Restored ${c.projects} projects, ${c.ops} ops and ${c.receipts} receipts; the receipt chain verifies.`,
        );
        return 0;
      }
      default:
        throw new UsageError(
          `Unknown command ${args.command}. Commands: serve, migrate, create-team, invite, devices, revoke-device, export-audit, verify, backup, restore, version.`,
        );
    }
  } catch (e) {
    io.error(e instanceof Error ? e.message : String(e));
    return e instanceof UsageError || e instanceof ConfigError ? 2 : 1;
  } finally {
    if (store && !io.store) await store.close();
  }
}
