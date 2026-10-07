/**
 * The Postgres store: runs when DATABASE_URL is set (the `team-server` CI job, with a postgres
 * service container) and skips cleanly otherwise. Each run uses throw-away schemas.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { makeInvite } from './auth/enrol';
import { backup, restore } from './backup';
import { createCore } from './core';
import { ephemeralIdentity } from './identity';
import { routeSuite } from './routeSuite';
import { createPostgresStore } from './store/postgres';
import { ChainWriter, memberAdd, TEST_TEAM, testPeople } from './testkit';

const url = process.env.DATABASE_URL;
const schemas: string[] = [];
const fresh = () => {
  const schema = `aio_test_${randomBytes(6).toString('hex')}`;
  schemas.push(schema);
  return createPostgresStore({ connectionString: url ?? '', schema, max: 4 });
};

if (url) routeSuite('postgres', () => Promise.resolve(fresh()));

describe.skipIf(!url)('Postgres store', () => {
  afterAll(async () => {
    const pool = new pg.Pool({ connectionString: url });
    for (const s of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await pool.end();
  });

  async function withOps() {
    const store = fresh();
    await store.init();
    const identity = ephemeralIdentity();
    const core = createCore({
      store,
      identity,
      name: 'pg',
      version: '0',
      fingerprint: '0'.repeat(64),
    });
    const { rana } = testPeople();
    const { code, invite } = makeInvite('owner', null, new Date());
    await store.addInvite(invite);
    await core.enrol({ code, device: rana.record }, rana.signer.device);
    const d = await store.device(rana.signer.device);
    if (!d) throw new Error('not enrolled');
    const R = new ChainWriter(rana);
    const r = await core.push(d, TEST_TEAM, [
      R.next(
        'project.share',
        { rec: 'project', id: TEST_TEAM },
        { teamProjectId: TEST_TEAM, name: 'Demo' },
      ),
      R.next('member.add', { rec: 'member', id: rana.actor }, memberAdd(rana, 'owner')),
      R.next('issue.create', { rec: 'issue', id: 'i_1' }, { record: { id: 'i_1', code: 'F01' } }),
    ]);
    expect(r.accepted).toHaveLength(3);
    return { store, identity };
  }

  it('migrates an empty database once', async () => {
    const store = fresh();
    await store.init();
    await store.init();
    const versions = await store.pool.query<{ version: string }>(
      'SELECT version FROM schema_migrations',
    );
    expect(versions.rows.map((r) => r.version)).toEqual(['001_init']);
    await store.close();
  });

  it('refuses UPDATE, DELETE and TRUNCATE on ops and receipts', async () => {
    const { store } = await withOps();
    for (const sql of [
      "UPDATE ops SET raw = '{}'",
      'DELETE FROM ops',
      'TRUNCATE ops CASCADE',
      "UPDATE receipts SET raw = '{}'",
      'DELETE FROM receipts',
      'TRUNCATE receipts',
    ]) {
      await expect(store.pool.query(sql), sql).rejects.toThrow(/append-only/);
    }
    expect(Object.keys(await store.heads(TEST_TEAM))).toHaveLength(1);
    await store.close();
  });

  it('backs up and restores into an empty database', async () => {
    const { store, identity } = await withOps();
    const file = join(mkdtempSync(join(tmpdir(), 'aio-pg-')), 'backup.jsonl');
    await backup(store, file, { id: identity.id, publicKey: identity.publicKey, version: '0' });
    const target = fresh();
    await target.init();
    const counts = await restore(target, file);
    expect(counts).toMatchObject({ projects: 1, ops: 3, receipts: 3, devices: 1 });
    expect(await target.heads(TEST_TEAM)).toEqual(await store.heads(TEST_TEAM));
    expect(await target.receipts(0, 10)).toEqual(await store.receipts(0, 10));
    const ops: unknown[] = [];
    for await (const op of target.allOps(TEST_TEAM)) ops.push(op);
    const before: unknown[] = [];
    for await (const op of store.allOps(TEST_TEAM)) before.push(op);
    expect(ops).toEqual(before);
    await store.close();
    await target.close();
  });
});
