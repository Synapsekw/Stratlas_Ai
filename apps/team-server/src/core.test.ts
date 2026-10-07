import type { Op, Role } from '@aio/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeInvite } from './auth/enrol';
import { createCore, type Core } from './core';
import { ephemeralIdentity } from './identity';
import { createMemoryStore } from './store/memory';
import type { EnrolledDevice, Store } from './store/store';
import { ChainWriter, memberAdd, TEST_TEAM, testPeople, type Person } from './testkit';

function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('missing');
  return v;
}

const T0 = Date.parse('2026-10-01T09:00:00.000Z');
const NOW = new Date('2026-10-02T09:00:00.000Z');
const issue = { rec: 'issue', id: 'i_f01' };

describe('op checks (the server refuses what the desktop would quarantine)', () => {
  const people = testPeople();
  const { rana, omar, sami, lina } = people;
  let store: Store;
  let core: Core;
  const devices: Record<string, EnrolledDevice> = {};

  async function enrol(p: Person, role: Role) {
    const { code, invite } = makeInvite(role, null, NOW);
    await store.addInvite(invite);
    await core.enrol({ code, device: p.record }, p.signer.device);
    const d = await store.device(p.signer.device);
    if (!d) throw new Error('not enrolled');
    devices[p.name] = d;
    return d;
  }
  const push = (p: Person, ops: Op[]) => core.push(need(devices[p.name]), TEST_TEAM, ops);

  let R: ChainWriter;
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
      // history Rana wrote alone, before she shared the project
      R.next('issue.create', issue, { record: { id: 'i_f01', code: 'F01' } }),
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

  const codes = (r: { refused: { code: string }[] }) => r.refused.map((x) => x.code);

  it('accepts the history the owner wrote before sharing', async () => {
    expect((await store.heads(TEST_TEAM))[rana.chain]?.seq).toBe(5);
  });

  it('refuses a gap, a fork and an edited op', async () => {
    const O = new ChainWriter(omar, T0 + 3_600_000);
    const o1 = O.next('issue.patch', issue, { set: { severity: 3 } });
    const o2 = O.next('issue.patch', issue, { set: { severity: 4 } });
    expect(codes(await push(omar, [o2]))).toEqual(['gap']);
    expect((await push(omar, [o1])).accepted).toEqual([o1.id]);
    const fork = new ChainWriter(omar, T0 + 7_200_000).next('issue.patch', issue, {
      set: { severity: 5 },
    });
    expect(codes(await push(omar, [fork]))).toEqual(['chain']);
    const edited = { ...o2, payload: { set: { severity: 1 } } };
    expect(codes(await push(omar, [edited]))).toEqual(['hash']);
    const unsigned: Record<string, unknown> = { ...o2 };
    delete unsigned.sig;
    expect(codes(await push(omar, [unsigned as Op]))).toEqual(['signature']);
    expect((await push(omar, [o2])).accepted).toEqual([o2.id]);
  });

  it('refuses ops whose signature is from another key', async () => {
    const O = new ChainWriter(
      {
        ...omar,
        signer: { ...omar.signer, sign: (domain, hash) => lina.signer.sign(domain, hash) },
      },
      T0 + 3_600_000,
    );
    expect(
      codes(await push(omar, [O.next('issue.patch', issue, { set: { severity: 3 } })])),
    ).toEqual(['signature']);
  });

  it('refuses an op that is not an op, or a payload that does not fit its kind', async () => {
    const O = new ChainWriter(omar, T0 + 3_600_000);
    const bad = O.next('issue.status', issue, { nonsense: true });
    const r = await push(omar, [{ v: 2 } as unknown as Op, bad]);
    expect(codes(r)).toEqual(['schema', 'schema']);
  });

  it('checks the role at each op clock reading, whatever order ops arrive in', async () => {
    const O = new ChainWriter(omar, T0 + 3_600_000);
    const before = O.next('issue.patch', issue, { set: { severity: 3 } }); // 10:01
    const after = O.next('issue.patch', issue, { set: { severity: 4 } }, T0 + 3 * 3_600_000); // 12:00
    // Rana makes Omar a viewer at 11:00
    const demote = R.next(
      'member.role',
      { rec: 'member', id: omar.actor },
      { actor: omar.actor, role: 'viewer' },
      T0 + 2 * 3_600_000,
    );
    expect((await push(rana, [demote])).accepted).toEqual([demote.id]);
    const r = await push(omar, [after, before]);
    expect(r.accepted).toEqual([before.id]);
    expect(r.refused).toMatchObject([{ id: after.id, code: 'role' }]);
  });

  it('refuses ops from a device the journal revoked', async () => {
    const revoke = R.next(
      'device.revoke',
      { rec: 'device', id: omar.signer.device },
      { device: omar.signer.device },
      T0 + 2 * 3_600_000,
    );
    await push(rana, [revoke]);
    const O = new ChainWriter(omar, T0 + 3 * 3_600_000);
    const r = await push(omar, [O.next('issue.patch', issue, { set: { severity: 3 } })]);
    expect(codes(r)).toEqual(['revoked']);
    expect(r.forbidden).toBe(true);
  });

  it('refuses an author who is no member and a clock far ahead', async () => {
    const L = new ChainWriter(lina, T0 + 3_600_000);
    expect(
      codes(await push(rana, [L.next('issue.patch', issue, { set: { severity: 2 } })])),
    ).toEqual(['non-member']);
    const O = new ChainWriter(omar, NOW.getTime() + 2 * 86_400_000);
    expect(
      codes(await push(omar, [O.next('issue.patch', issue, { set: { severity: 2 } })])),
    ).toEqual(['clock-ahead']);
  });

  it('lets a viewer comment only when the policy allows it', async () => {
    const S = new ChainWriter(sami, T0 + 3 * 3_600_000);
    const comment = (id: string) =>
      S.next('comment.add', issue, {
        id,
        target: { kind: 'issue', id: 'i_f01' },
        text: 'Seen.',
        visibility: 'team',
        mentions: [],
      });
    const first = comment('cm_aaaaaaaaaaaaaaaa');
    expect(codes(await push(sami, [first]))).toEqual(['role']);
    const allow = R.next(
      'policy.set',
      { rec: 'policy', id: 'team' },
      { approval: { viewersMayComment: true } },
      T0 + 2 * 3_600_000,
    );
    await push(rana, [allow]);
    expect((await push(sami, [first])).accepted).toEqual([first.id]);
  });

  it('forwards ops of others and stores each once', async () => {
    const O = new ChainWriter(omar, T0 + 3_600_000);
    const o1 = O.next('issue.patch', issue, { set: { severity: 3 } });
    // Rana got Omar's op by USB and pushes it with her own
    const r1 = R.next('issue.patch', issue, { set: { title: 'Flange' } }, T0 + 3_700_000);
    const r = await push(rana, [r1, o1]);
    expect(r.accepted.sort()).toEqual([o1.id, r1.id].sort());
    expect((await push(omar, [o1])).duplicates).toEqual([o1.id]);
  });
});
