import { verifySignature, contentHash } from '@aio/journal';
import type { Op } from '@aio/schema';
import {
  createHttpClient,
  createHttpTransport,
  enrolDevice,
  serverHealth,
  type HttpTransport,
} from '@aio/sync/http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyReceipts } from './receipts';
import type { Store } from './store/store';
import {
  ChainWriter,
  memberAdd,
  startLoopbackServer,
  TEST_TEAM,
  testPeople,
  type LoopbackServer,
  type Person,
} from './testkit';

/** The route suite runs on every store: memory always, Postgres when DATABASE_URL is set. */
export function routeSuite(name: string, makeStore: () => Promise<Store>) {
  describe(`aio.sync/1 routes (${name} store)`, () => {
    const people = testPeople();
    const { rana, omar, sami, dana, lina } = people;
    let server: LoopbackServer;
    const issue = { rec: 'issue', id: 'i_f01' };
    const target = { kind: 'issue', id: 'i_f01' };
    const R = new ChainWriter(rana);
    // the others write after Rana has added them
    const later = Date.parse('2026-10-01T10:00:00.000Z');
    const O = new ChainWriter(omar, later);
    const S = new ChainWriter(sami, later);
    const D = new ChainWriter(dana, later);

    const transportFor = (p: Person, pageSize?: number): HttpTransport =>
      createHttpTransport({
        client: createHttpClient({
          baseUrl: server.origin,
          fingerprint: server.fingerprint,
          signer: p.signer,
        }),
        teamProjectId: TEST_TEAM,
        ...(pageSize ? { pageSize } : {}),
      });

    async function enrol(
      p: Person,
      role: Parameters<LoopbackServer['invite']>[0],
      project?: string,
    ) {
      const client = createHttpClient({
        baseUrl: server.origin,
        fingerprint: server.fingerprint,
        signer: p.signer,
      });
      return enrolDevice(client, await server.invite(role, project ?? null), p.record);
    }

    beforeAll(async () => {
      server = await startLoopbackServer({ store: await makeStore() });
    });
    afterAll(async () => {
      await server.close();
    });

    // the history Rana shares: the project, three members, an issue
    const shared: Op[] = [];

    it('answers health with its version and protocol range', async () => {
      const health = await serverHealth(
        createHttpClient({ baseUrl: server.origin, fingerprint: server.fingerprint }),
      );
      expect(health).toEqual({ ok: true, version: '0.1.0-test', protocol: { min: 1, max: 1 } });
    });

    it('enrols a device with an invite code and certifies it', async () => {
      const r = await enrol(rana, 'owner');
      expect(r.role).toBe('owner');
      expect(r.server).toMatchObject({ id: server.identity.id, fingerprint: server.fingerprint });
      const { sig, ...cert } = r.cert;
      expect(cert).toMatchObject({
        level: 'server',
        actor: rana.actor,
        device: rana.signer.device,
      });
      expect(verifySignature(server.identity.publicKey, 'aio.cert/1', contentHash(cert), sig)).toBe(
        true,
      );
      await enrol(omar, 'reviewer');
      await enrol(sami, 'viewer', TEST_TEAM);
      await enrol(dana, 'client', TEST_TEAM);
    });

    it('refuses a used, mistyped or foreign invite code', async () => {
      const code = await server.invite('reviewer');
      const client = createHttpClient({
        baseUrl: server.origin,
        fingerprint: server.fingerprint,
        signer: lina.signer,
      });
      await expect(enrolDevice(client, 'ABCD-EFGH-JKMN-PQRS', lina.record)).rejects.toMatchObject({
        code: 'forbidden',
      });
      // a request signed by someone else's key for Lina's record
      const forger = createHttpClient({
        baseUrl: server.origin,
        fingerprint: server.fingerprint,
        signer: omar.signer,
      });
      await expect(enrolDevice(forger, code, lina.record)).rejects.toMatchObject({
        code: 'unauthorized',
      });
      await enrolDevice(client, code, lina.record);
      await expect(enrolDevice(client, code, lina.record)).rejects.toMatchObject({
        code: 'forbidden',
      });
    });

    it('creates the project when its owner shares it, and countersigns every op', async () => {
      shared.push(
        R.next(
          'project.share',
          { rec: 'project', id: TEST_TEAM },
          {
            teamProjectId: TEST_TEAM,
            name: 'Demo site (synthetic)',
          },
        ),
        R.next('member.add', { rec: 'member', id: rana.actor }, memberAdd(rana, 'owner')),
        R.next('member.add', { rec: 'member', id: omar.actor }, memberAdd(omar, 'reviewer')),
        R.next('member.add', { rec: 'member', id: sami.actor }, memberAdd(sami, 'viewer')),
        R.next('member.add', { rec: 'member', id: dana.actor }, memberAdd(dana, 'client')),
        R.next('issue.create', issue, { record: { id: 'i_f01', code: 'F01', title: 'Flange' } }),
      );
      const r = await transportFor(rana).pushOps(shared);
      expect(r.refused).toEqual([]);
      expect(r.accepted).toEqual(shared.map((o) => o.id));
      expect(r.receipts.map((x) => x.op)).toEqual(r.accepted);
      const all = await server.store.receipts(0, 100);
      expect(verifyReceipts(all, server.identity.publicKey)).toEqual([]);
      expect(await server.store.project(TEST_TEAM)).toMatchObject({
        name: 'Demo site (synthetic)',
        createdBy: rana.actor,
      });
    });

    it('takes the same ops again as duplicates (idempotent push)', async () => {
      const before = (await server.store.lastReceipt())?.seq;
      const r = await transportFor(rana).pushOps(shared);
      expect(r.accepted).toEqual([]);
      expect(r.duplicates.sort()).toEqual(shared.map((o) => o.id).sort());
      expect((await server.store.lastReceipt())?.seq).toBe(before);
    });

    it('serves heads and pages of ops with a cursor', async () => {
      const t = transportFor(omar, 2);
      const heads = await t.heads();
      expect(heads[rana.chain]).toEqual({ seq: 6, id: shared[5]?.id });
      const got: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await t.pullOps({}, cursor);
        got.push(...page.ops.map((o) => o.id));
        cursor = page.cursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(got).toEqual(shared.map((o) => o.id));
      expect((await t.pullOps(heads)).ops).toEqual([]);
      const tail = await t.pullOps({ [rana.chain]: { seq: 4, id: shared[3]?.id ?? '' } });
      expect(tail.ops.map((o) => o.seq)).toEqual([5, 6]);
    });

    it('accepts a reviewer comment and keeps the op exactly as signed', async () => {
      const comment = O.next('comment.add', issue, {
        id: 'cm_aaaaaaaaaaaaaaaa',
        target,
        text: 'Weld seam looks pitted.',
        visibility: 'team',
        mentions: [],
      });
      const r = await transportFor(omar).pushOps([comment]);
      expect(r.accepted).toEqual([comment.id]);
      const page = await transportFor(rana).pullOps({ [rana.chain]: { seq: 6, id: '' } });
      expect(page.ops).toEqual([comment]);
    });

    it("refuses a viewer's write and a client's issue patch with 403", async () => {
      const viewerEdit = S.next('issue.patch', issue, { set: { severity: 4 } });
      const v = await transportFor(sami).pushOps([viewerEdit]);
      expect(v.accepted).toEqual([]);
      expect(v.refused).toMatchObject([{ id: viewerEdit.id, code: 'role' }]);
      const clientEdit = D.next('issue.patch', issue, { set: { severity: 1 } });
      const c = await transportFor(dana).pushOps([clientEdit]);
      expect(c.refused[0]).toMatchObject({ id: clientEdit.id, code: 'role' });
    });

    it('lets a client post only client comments and acceptances, and never pull', async () => {
      const D2 = new ChainWriter(
        { ...dana, chain: `${dana.signer.device}.r_cccccccccccccccc` },
        later,
      );
      const reply = D2.next('comment.add', issue, {
        id: 'cm_cccccccccccccccc',
        target,
        text: 'Please fix before handover.',
        visibility: 'client',
        mentions: [],
      });
      const r = await transportFor(dana).pushOps([reply]);
      expect(r.accepted).toEqual([reply.id]);
      await expect(transportFor(dana).pullOps({})).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('lists the members the server enforces', async () => {
      const members = await transportFor(omar).members();
      const byName = Object.fromEntries(members.map((m) => [m.name, m]));
      expect(byName['Rana Example']).toMatchObject({ role: 'owner', verification: 'server' });
      expect(byName['Sami Viewer']).toMatchObject({ role: 'viewer' });
      // Lina enrolled with a server-wide reviewer invite: a member by grant until an owner adds her
      expect(byName['Lina Test']).toMatchObject({ role: 'reviewer', addedBy: rana.actor });
    });

    it('answers 404 for a project it does not hold', async () => {
      const t = createHttpTransport({
        client: createHttpClient({
          baseUrl: server.origin,
          fingerprint: server.fingerprint,
          signer: rana.signer,
        }),
        teamProjectId: 't_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      });
      await expect(t.heads()).rejects.toMatchObject({ code: 'not-found' });
    });

    it('refuses a reviewer sharing a new project', async () => {
      const other = 't_bbbbbbbbbbbbbbbbbbbbbbbbbb';
      const W = new ChainWriter({ ...omar, chain: `${omar.signer.device}.r_dddddddddddddddd` });
      const share = W.next(
        'project.share',
        { rec: 'project', id: other },
        {
          teamProjectId: other,
          name: 'Not allowed',
        },
      );
      const t = createHttpTransport({
        client: createHttpClient({
          baseUrl: server.origin,
          fingerprint: server.fingerprint,
          signer: omar.signer,
        }),
        teamProjectId: other,
      });
      await expect(t.pushOps([share])).rejects.toMatchObject({ code: 'forbidden' });
      expect(await server.store.project(other)).toBeNull();
    });
  });
}
