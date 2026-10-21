/**
 * Attacks on the server core (security review 2026-10-21): each test reproduces one way a device
 * could get more than its invite and the journal give it.
 */
import { certifyDevice, signerFromSeed, contentHash } from '@aio/journal';
import type { DeviceCert, Op, Role } from '@aio/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeInvite } from './auth/enrol';
import { createCore, ServerRefusal, type Core } from './core';
import { ephemeralIdentity } from './identity';
import { createMemoryStore } from './store/memory';
import type { EnrolledDevice, Store } from './store/store';
import {
  ChainWriter,
  deviceRecord,
  memberAdd,
  TEST_TEAM,
  testPeople,
  type Person,
} from './testkit';

const T0 = Date.parse('2026-10-01T09:00:00.000Z');
const NOW = new Date('2026-10-02T09:00:00.000Z');
const issue = { rec: 'issue', id: 'i_f01' };
const HOUR = 3_600_000;

/** A second device (another key) that claims to be `who`, with optional certificates. */
function impostor(label: string, who: Person, certs: DeviceCert[] = []): Person {
  const signer = signerFromSeed(contentHash(`aio-test-impostor:${label}`));
  const base = deviceRecord(signer, who);
  const body: Record<string, unknown> = { ...base, certs };
  delete body.sig;
  const record = { ...base, certs, sig: signer.sign('aio.device/1', contentHash(body)) };
  return {
    ...who,
    signer,
    record,
    chain: `${signer.device}.r_${label.padEnd(16, 'x').slice(0, 16)}`,
  };
}

const codes = (r: { refused: { code: string }[] }) => r.refused.map((x) => x.code);

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServerRefusal) return { status: e.status, code: e.code };
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('security: who a device may be, and what it may do', () => {
  const { rana, omar, sami, lina } = testPeople();
  let store: Store;
  let core: Core;
  let R: ChainWriter;

  async function enrol(p: Person, role: Role, project: string | null = null) {
    const { code, invite } = makeInvite(role, project, NOW);
    await store.addInvite(invite);
    return core.enrol({ code, device: p.record }, p.signer.device);
  }
  async function dev(p: Person): Promise<EnrolledDevice> {
    const d = await core.device(p.signer.device);
    if (!d) throw new Error(`${p.name} not enrolled`);
    return d;
  }
  const push = async (p: Person, ops: Op[]) => core.push(await dev(p), TEST_TEAM, ops);

  beforeEach(async () => {
    store = createMemoryStore();
    core = createCore({
      store,
      identity: ephemeralIdentity(),
      name: 'Test',
      version: '0',
      fingerprint: '0'.repeat(64),
      now: () => NOW,
    });
    await enrol(rana, 'owner');
    await enrol(omar, 'reviewer');
    await enrol(sami, 'viewer');
    R = new ChainWriter(rana, T0);
    const r = await push(rana, [
      R.next(
        'project.share',
        { rec: 'project', id: TEST_TEAM },
        { teamProjectId: TEST_TEAM, name: 'Demo' },
      ),
      R.next('member.add', { rec: 'member', id: rana.actor }, memberAdd(rana, 'owner')),
      R.next('member.add', { rec: 'member', id: omar.actor }, memberAdd(omar, 'reviewer')),
      R.next('member.add', { rec: 'member', id: sami.actor }, memberAdd(sami, 'viewer')),
    ]);
    expect(r.refused).toEqual([]);
  });

  describe('finding 1: an invitee claims another actor', () => {
    it('refuses a viewer invite that claims the owner actor', async () => {
      const mallory = impostor('mallory', rana);
      expect(await refusal(enrol(mallory, 'viewer'))).toEqual({ status: 403, code: 'actor' });
      expect(await store.device(mallory.signer.device)).toBeNull();
    });

    it('refuses a claim on an actor the journal names with other devices', async () => {
      // Lina is in the journal (added from her card) but has not enrolled yet
      const add = R.next('member.add', { rec: 'member', id: lina.actor }, memberAdd(lina, 'owner'));
      expect((await push(rana, [add])).accepted).toEqual([add.id]);
      const mallory = impostor('mallory', lina);
      expect(await refusal(enrol(mallory, 'viewer', TEST_TEAM))).toEqual({
        status: 403,
        code: 'actor',
      });
      // her own device, listed in the journal, enrols
      await enrol(lina, 'viewer', TEST_TEAM);
      expect((await dev(lina)).actor).toBe(lina.actor);
    });

    it('gives an actor squatted before this fix nothing of the journal role', async () => {
      // an enrolment made by an older server: a viewer device bound to Rana's actor
      const mallory = impostor('mallory', rana);
      await store.putDevice({
        device: mallory.signer.device,
        actor: rana.actor,
        key: mallory.signer.publicKey,
        name: 'Mallory',
        initials: 'MA',
        role: 'viewer',
        project: TEST_TEAM,
        enrolledAt: NOW.toISOString(),
        revokedAt: null,
        revokeReason: null,
        record: mallory.record,
      });
      const m = await dev(mallory);
      expect(await refusal(core.heads(m, TEST_TEAM))).toMatchObject({ status: 403 });
      expect(await refusal(core.pull(m, TEST_TEAM, undefined, 100))).toMatchObject({
        status: 403,
      });
      const M = new ChainWriter(mallory, T0 + 2 * HOUR);
      const promote = M.next(
        'member.add',
        { rec: 'member', id: rana.actor },
        { ...memberAdd(mallory, 'owner'), actor: rana.actor },
      );
      expect(await refusal(core.push(m, TEST_TEAM, [promote]))).toMatchObject({ status: 403 });
      // nor does anyone else get it in for it
      const r = await push(omar, [promote]);
      expect(codes(r)).toEqual(['non-member']);
    });

    it('refuses a forwarded op whose device the journal gives to someone else', async () => {
      const mallory = impostor('mallory', rana);
      await store.putDevice({
        device: mallory.signer.device,
        actor: rana.actor,
        key: mallory.signer.publicKey,
        name: 'Mallory',
        initials: 'MA',
        role: 'owner',
        project: null,
        enrolledAt: NOW.toISOString(),
        revokedAt: null,
        revokeReason: null,
        record: mallory.record,
      });
      const M = new ChainWriter(mallory, T0 + 2 * HOUR);
      const demote = M.next(
        'member.role',
        { rec: 'member', id: omar.actor },
        { actor: omar.actor, role: 'viewer' },
      );
      // Omar forwards it as if it were Rana's
      const r = await push(omar, [demote]);
      expect(codes(r)).toEqual(['non-member']);
    });

    it('accepts a second device an owner listed for the person in the journal', async () => {
      const second = impostor('omarlaptop', omar);
      const add = R.next(
        'member.add',
        { rec: 'member', id: omar.actor },
        {
          ...memberAdd(omar, 'reviewer'),
          devices: [
            { id: omar.signer.device, key: omar.signer.publicKey },
            { id: second.signer.device, key: second.signer.publicKey },
          ],
        },
      );
      expect((await push(rana, [add])).accepted).toEqual([add.id]);
      await enrol(second, 'viewer');
      const d = await dev(second);
      const W = new ChainWriter(second, T0 + 2 * HOUR);
      const op = W.next('issue.patch', issue, { set: { severity: 2 } });
      expect((await core.push(d, TEST_TEAM, [op])).accepted).toEqual([op.id]);
    });

    it("accepts a second device certified by one of the person's own devices", async () => {
      const cert = certifyDevice(
        rana.signer,
        rana.actor,
        rana.actor,
        impostor('rana2', rana).signer.device,
        NOW.toISOString(),
      );
      const second = impostor('rana2', rana, [cert]);
      await enrol(second, 'viewer');
      const d = await dev(second);
      expect(d.actor).toBe(rana.actor);
      await expect(core.heads(d, TEST_TEAM)).resolves.toMatchObject({ project: TEST_TEAM });
      const S2 = new ChainWriter(second, T0 + 2 * HOUR);
      const op = S2.next('issue.patch', issue, { set: { severity: 2 } });
      expect((await core.push(d, TEST_TEAM, [op])).accepted).toEqual([op.id]);
    });

    it('accepts a device an owner certified, and refuses one a viewer certified', async () => {
      const omar2 = impostor('omar2', omar);
      const byOwner = certifyDevice(
        rana.signer,
        rana.actor,
        omar.actor,
        omar2.signer.device,
        NOW.toISOString(),
      );
      const ok = impostor('omar2', omar, [byOwner]);
      await enrol(ok, 'viewer');
      const d = await dev(ok);
      // the journal role applies: a reviewer
      const O2 = new ChainWriter(ok, T0 + 2 * HOUR);
      const op = O2.next('issue.patch', issue, { set: { severity: 2 } });
      expect((await core.push(d, TEST_TEAM, [op])).accepted).toEqual([op.id]);

      const omar3 = impostor('omar3', omar);
      const byViewer = certifyDevice(
        sami.signer,
        sami.actor,
        omar.actor,
        omar3.signer.device,
        NOW.toISOString(),
      );
      expect(await refusal(enrol(impostor('omar3', omar, [byViewer]), 'viewer'))).toEqual({
        status: 403,
        code: 'actor',
      });
    });

    it('refuses a certificate that does not verify', async () => {
      const rana3 = impostor('rana3', rana);
      const cert = certifyDevice(
        rana.signer,
        rana.actor,
        rana.actor,
        rana3.signer.device,
        NOW.toISOString(),
      );
      const forged = { ...cert, issuedAt: '2026-10-02T10:00:00.000Z' };
      expect(await refusal(enrol(impostor('rana3', rana, [forged]), 'owner'))).toEqual({
        status: 403,
        code: 'actor',
      });
    });
  });

  describe('finding 10: enrolling the same device again', () => {
    it('keeps the actor and the role of an enrolled device', async () => {
      const again = await enrol(sami, 'owner');
      expect(again.role).toBe('viewer');
      expect((await dev(sami)).role).toBe('viewer');
      const other = { ...testPeople().sami };
      const claimsRana = deviceRecord(other.signer, {
        actor: rana.actor,
        name: rana.name,
        initials: rana.initials,
      });
      const { code, invite } = makeInvite('owner', null, NOW);
      await store.addInvite(invite);
      expect(
        await refusal(core.enrol({ code, device: claimsRana }, sami.signer.device)),
      ).toMatchObject({ status: 403 });
      expect((await dev(sami)).actor).toBe(sami.actor);
    });
  });

  describe('finding 2: a device the journal revoked', () => {
    it('reads nothing and pushes nothing', async () => {
      const revoke = R.next(
        'device.revoke',
        { rec: 'device', id: sami.signer.device },
        { device: sami.signer.device },
        T0 + 2 * HOUR,
      );
      expect((await push(rana, [revoke])).accepted).toEqual([revoke.id]);
      const s = await dev(sami);
      expect(await refusal(core.heads(s, TEST_TEAM))).toMatchObject({ status: 403 });
      expect(await refusal(core.pull(s, TEST_TEAM, undefined, 10))).toMatchObject({
        status: 403,
      });
      expect(await refusal(core.members(s, TEST_TEAM))).toMatchObject({ status: 403 });
      // nor forwards someone else's op
      const O = new ChainWriter(omar, T0 + 3 * HOUR);
      expect(await refusal(push(sami, [O.next('issue.patch', issue, { set: { a: 1 } })]))).toEqual({
        status: 403,
        code: 'forbidden',
      });
    });
  });

  describe('finding 3: backdated clock readings', () => {
    it('refuses an op whose clock goes back in its own chain', async () => {
      const O = new ChainWriter(omar, T0 + 2 * HOUR);
      const first = O.next('issue.patch', issue, { set: { severity: 3 } });
      const back = O.next('issue.patch', issue, { set: { severity: 4 } }, T0 + HOUR);
      expect((await push(omar, [first])).accepted).toEqual([first.id]);
      expect(codes(await push(omar, [back]))).toEqual(['chain']);
    });

    it('judges ops received after a demotion with the role the server knows now', async () => {
      const O = new ChainWriter(omar, T0 + HOUR);
      const early = O.next('issue.patch', issue, { set: { severity: 3 } });
      expect((await push(omar, [early])).accepted).toEqual([early.id]);
      const demote = R.next(
        'member.role',
        { rec: 'member', id: omar.actor },
        { actor: omar.actor, role: 'viewer' },
        T0 + 3 * HOUR,
      );
      expect((await push(rana, [demote])).accepted).toEqual([demote.id]);
      // written after the demotion, dated before it
      const backdated = O.next('issue.patch', issue, { set: { severity: 1 } }, T0 + 2 * HOUR);
      const r = await push(omar, [backdated]);
      expect(codes(r)).toEqual(['role']);
    });

    it('refuses every new op of a revoked device, whatever its clock says', async () => {
      const revoke = R.next(
        'device.revoke',
        { rec: 'device', id: omar.signer.device },
        { device: omar.signer.device },
        T0 + 3 * HOUR,
      );
      expect((await push(rana, [revoke])).accepted).toEqual([revoke.id]);
      const O = new ChainWriter(omar, T0 + HOUR);
      const backdated = O.next('issue.patch', issue, { set: { severity: 1 } });
      // Rana forwards it (Omar's own device may no longer push)
      expect(codes(await push(rana, [backdated]))).toEqual(['revoked']);
    });

    it('refuses new ops of a device revoked on the server, whatever its clock says', async () => {
      await store.revokeDevice(omar.signer.device, NOW.toISOString(), 'lost');
      const O = new ChainWriter(omar, T0 + HOUR);
      const backdated = O.next('issue.patch', issue, { set: { severity: 1 } });
      expect(codes(await push(rana, [backdated]))).toEqual(['revoked']);
    });
  });
});
