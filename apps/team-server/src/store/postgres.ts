/**
 * The Postgres store (the only database the Team Server supports; no PostGIS). Migrations in
 * `migrations/*.sql` run in order inside one transaction each, under an advisory lock, and are
 * recorded in `schema_migrations`. Ops and receipts are append-only (trigger and grants).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Heads, Op, Receipt, TeamProject } from '@aio/schema';
import pg from 'pg';
import type { EnrolledDevice, Invite, Store } from './store';

/** Where the SQL files are: next to the source (development) or next to the bundle (image). */
export function migrationsDir(): string {
  const fromEnv = process.env.AIO_MIGRATIONS_DIR;
  if (fromEnv) return fromEnv;
  for (const rel of ['../../migrations/', '../migrations/', './migrations/']) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(join(dir, '001_init.sql'))) return dir;
  }
  throw new Error('The migrations folder was not found (set AIO_MIGRATIONS_DIR).');
}

export interface PostgresOptions {
  connectionString: string;
  /** Run in this schema (tests use a throw-away schema per run). */
  schema?: string;
  migrations?: string;
  max?: number;
}

/** Apply the migrations not applied yet; returns the versions applied now. */
export async function migrate(pool: pg.Pool, dir = migrationsDir()): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7349021)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set(
      (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
        (r) => r.version,
      ),
    );
    const applied: string[] = [];
    for (const file of readdirSync(dir)
      .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
      .sort()) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
      applied.push(version);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(7349021)').catch(() => undefined);
    client.release();
  }
}

const parseOp = (raw: string) => JSON.parse(raw) as Op;

interface DeviceRow {
  raw: EnrolledDevice;
  revoked_at: string | null;
  revoke_reason: string | null;
}
const toDevice = (r: DeviceRow): EnrolledDevice => ({
  ...r.raw,
  revokedAt: r.revoked_at,
  revokeReason: r.revoke_reason,
});

interface InviteRow {
  code_hash: string;
  role: Invite['role'];
  project: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
}
const toInvite = (r: InviteRow): Invite => ({
  codeHash: r.code_hash,
  role: r.role,
  project: r.project,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  usedAt: r.used_at,
  usedBy: r.used_by,
});

export function createPostgresStore(options: PostgresOptions): Store & { pool: pg.Pool } {
  if (options.schema !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(options.schema))
    throw new Error('A schema name is lower-case letters, digits and underscores.');
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
  });
  const q = <R extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
    pool.query<R>(text, values);

  return {
    kind: 'postgres',
    pool,
    async init() {
      if (options.schema) await q(`CREATE SCHEMA IF NOT EXISTS ${options.schema}`);
      await migrate(pool, options.migrations);
    },
    close: () => pool.end(),

    async meta(key) {
      return (
        (await q<{ value: string }>('SELECT value FROM meta WHERE key = $1', [key])).rows[0]
          ?.value ?? null
      );
    },
    async setMeta(key, value) {
      await q(
        'INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [key, value],
      );
    },

    async projects() {
      const rows = await q<{
        team_project_id: string;
        name: string;
        created_at: string;
        created_by: string;
      }>(
        'SELECT team_project_id, name, created_at, created_by FROM projects ORDER BY team_project_id',
      );
      return rows.rows.map((r): TeamProject => ({
        schema: 'aio.team/1',
        teamProjectId: r.team_project_id,
        name: r.name,
        createdAt: r.created_at,
        createdBy: r.created_by,
      }));
    },
    async project(id) {
      const r = await q<{ name: string; created_at: string; created_by: string }>(
        'SELECT name, created_at, created_by FROM projects WHERE team_project_id = $1',
        [id],
      );
      const row = r.rows[0];
      return row
        ? {
            schema: 'aio.team/1' as const,
            teamProjectId: id,
            name: row.name,
            createdAt: row.created_at,
            createdBy: row.created_by,
          }
        : null;
    },
    async createProject(p) {
      await q(
        'INSERT INTO projects (team_project_id, name, created_at, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [p.teamProjectId, p.name, p.createdAt, p.createdBy],
      );
    },

    async heads(id) {
      const rows = await q<{ chain: string; seq: number; id: string }>(
        'SELECT DISTINCT ON (chain) chain, seq, id FROM ops WHERE project = $1 ORDER BY chain, seq DESC',
        [id],
      );
      const out: Heads = {};
      for (const r of rows.rows) out[r.chain] = { seq: r.seq, id: r.id };
      return out;
    },
    async hasOps(id, ids) {
      if (ids.length === 0) return new Set();
      const rows = await q<{ id: string }>(
        'SELECT id FROM ops WHERE project = $1 AND id = ANY($2::text[])',
        [id, [...ids]],
      );
      return new Set(rows.rows.map((r) => r.id));
    },
    async appendOps(id, ops) {
      const client = await pool.connect();
      const stored: string[] = [];
      const duplicates: string[] = [];
      try {
        await client.query('BEGIN');
        for (const op of ops) {
          const r = await client.query(
            'INSERT INTO ops (project, id, chain, seq, kind, raw) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (project, id) DO NOTHING RETURNING id',
            [id, op.id, op.chain, op.seq, op.kind, JSON.stringify(op)],
          );
          if (r.rowCount === 1) stored.push(op.id);
          else duplicates.push(op.id);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return { stored, duplicates };
    },
    async opsSince(id, since, limit) {
      const chains = Object.keys(since);
      const rows = await q<{ raw: string }>(
        `SELECT o.raw FROM ops o
           LEFT JOIN unnest($2::text[], $3::int[]) AS s (chain, seq) ON s.chain = o.chain
          WHERE o.project = $1 AND o.seq > COALESCE(s.seq, 0)
          ORDER BY o.pos LIMIT $4`,
        [id, chains, chains.map((c) => since[c] ?? 0), limit + 1],
      );
      const ops = rows.rows.slice(0, limit).map((r) => parseOp(r.raw));
      return { ops, more: rows.rows.length > limit };
    },
    async *allOps(id) {
      let after = 0;
      for (;;) {
        const rows = await q<{ pos: string; raw: string }>(
          'SELECT pos, raw FROM ops WHERE project = $1 AND pos > $2 ORDER BY pos LIMIT 1000',
          [id, after],
        );
        for (const r of rows.rows) yield parseOp(r.raw);
        const last = rows.rows[rows.rows.length - 1];
        if (!last || rows.rows.length < 1000) return;
        after = Number(last.pos);
      }
    },

    async appendReceipts(receipts) {
      if (receipts.length === 0) return;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const r of receipts)
          await client.query('INSERT INTO receipts (seq, id, op, raw) VALUES ($1, $2, $3, $4)', [
            r.seq,
            r.id,
            r.op,
            JSON.stringify(r),
          ]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async lastReceipt() {
      const r = await q<{ raw: string }>('SELECT raw FROM receipts ORDER BY seq DESC LIMIT 1');
      const row = r.rows[0];
      return row ? (JSON.parse(row.raw) as Receipt) : null;
    },
    async receipts(afterSeq, limit) {
      const r = await q<{ raw: string }>(
        'SELECT raw FROM receipts WHERE seq > $1 ORDER BY seq LIMIT $2',
        [afterSeq, limit],
      );
      return r.rows.map((row) => JSON.parse(row.raw) as Receipt);
    },

    async addInvite(i) {
      await q(
        'INSERT INTO invites (code_hash, role, project, created_at, expires_at, used_at, used_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [i.codeHash, i.role, i.project, i.createdAt, i.expiresAt, i.usedAt, i.usedBy],
      );
    },
    async takeInvite(codeHash, now, device) {
      const r = await q<InviteRow>(
        'UPDATE invites SET used_at = $2, used_by = $3 WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING *',
        [codeHash, now, device],
      );
      const row = r.rows[0];
      return row ? toInvite(row) : null;
    },
    async invites() {
      return (await q<InviteRow>('SELECT * FROM invites ORDER BY created_at')).rows.map(toInvite);
    },

    async putDevice(d) {
      const { revokedAt, revokeReason, ...rest } = d;
      await q(
        `INSERT INTO devices (device, actor, raw, revoked_at, revoke_reason) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (device) DO UPDATE SET actor = EXCLUDED.actor, raw = EXCLUDED.raw,
           revoked_at = EXCLUDED.revoked_at, revoke_reason = EXCLUDED.revoke_reason`,
        [d.device, d.actor, JSON.stringify(rest), revokedAt, revokeReason],
      );
    },
    async device(id) {
      const r = await q<DeviceRow>(
        'SELECT raw, revoked_at, revoke_reason FROM devices WHERE device = $1',
        [id],
      );
      const row = r.rows[0];
      return row ? toDevice(row) : null;
    },
    async devices() {
      return (
        await q<DeviceRow>('SELECT raw, revoked_at, revoke_reason FROM devices ORDER BY device')
      ).rows.map(toDevice);
    },
    async revokeDevice(id, at, reason) {
      const r = await q(
        'UPDATE devices SET revoked_at = COALESCE(revoked_at, $2), revoke_reason = COALESCE(revoke_reason, $3) WHERE device = $1',
        [id, at, reason],
      );
      return (r.rowCount ?? 0) > 0;
    },
  };
}
