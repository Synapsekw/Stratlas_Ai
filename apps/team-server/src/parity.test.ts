/**
 * The server and the app reach the same verdict on the same ops (security review 2026-10-21): the
 * server judges with the journal's own team logic (`judgeOp`, `orderForTeam`, `teamFences`) and
 * the genesis it pinned, so whatever order ops reach it in, what it accepts is exactly what
 * `replayTeam` (the app's quarantine) lets apply. The one difference is in time, not logic: an op
 * that reaches the server before the revocation or demotion that fences it is already stored when
 * the fence arrives (the app quarantines it then; the server cannot take it back).
 */
import { pinOf, replayTeam } from '@aio/journal';
import type { Op, Role } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { makeInvite } from './auth/enrol';
import { createCore } from './core';
import { ephemeralIdentity } from './identity';
import { createMemoryStore } from './store/memory';
import { ChainWriter, memberAdd, TEST_TEAM, testPeople, type Person } from './testkit';

const T0 = Date.parse('2026-10-01T09:00:00.000Z');
const NOW = new Date('2026-10-02T09:00:00.000Z');
const MIN = 60_000;
const issue = { rec: 'issue', id: 'i_f01' };
const raw = (op: Op) => op as unknown as Record<string, unknown>;

/** A small deterministic generator (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The history: a shared project, honest and backdated ops, a demotion and a revocation. */
function history() {
  const { rana, omar, lina, sami } = testPeople();
  const R = new ChainWriter(rana, T0);
  const shared = [
    R.next('issue.create', issue, { record: { id: 'i_f01', code: 'F01' } }),
    R.next(
      'project.share',
      { rec: 'project', id: TEST_TEAM },
      { teamProjectId: TEST_TEAM, name: 'Demo' },
    ),
    R.next('member.add', { rec: 'member', id: rana.actor }, memberAdd(rana, 'owner')),
    R.next('member.add', { rec: 'member', id: omar.actor }, memberAdd(omar, 'reviewer')),
    R.next('member.add', { rec: 'member', id: lina.actor }, memberAdd(lina, 'reviewer')),
    R.next('member.add', { rec: 'member', id: sami.actor }, memberAdd(sami, 'viewer')),
  ];
  const genesis = shared[2]?.id ?? '';
  const O = new ChainWriter(omar, T0 + 60 * MIN);
  const o1 = O.next('issue.patch', issue, { set: { severity: 1 } }, T0 + 60 * MIN);
  const o2 = O.next('issue.patch', issue, { set: { severity: 2 } }, T0 + 90 * MIN);
  const o3 = O.next('issue.patch', issue, { set: { severity: 3 } }, T0 + 180 * MIN);
  // a new chain of Omar's, dated before his demotion, that it did not see
  const O2 = new ChainWriter({ ...omar, chain: `${omar.signer.device}.r_bbbbbbbbbbbbbbbb` });
  const p1 = O2.next('issue.patch', issue, { set: { severity: 4 } }, T0 + 75 * MIN);
  const L = new ChainWriter(lina, T0 + 30 * MIN);
  const l1 = L.next('issue.patch', issue, { set: { title: 'Flange' } }, T0 + 30 * MIN);
  const l2 = L.next('issue.patch', issue, { set: { title: 'Weld' } }, T0 + 100 * MIN);
  const S = new ChainWriter(sami, T0 + 70 * MIN);
  const s1 = S.next('issue.patch', issue, { set: { severity: 5 } }, T0 + 70 * MIN);
  // Rana makes Omar a viewer having seen o1 only, then revokes Lina's laptop having seen l1
  const demote = R.next(
    'member.role',
    { rec: 'member', id: omar.actor },
    { actor: omar.actor, role: 'viewer', seen: { [omar.chain]: 1 } },
    T0 + 120 * MIN,
  );
  const revoke = R.next(
    'device.revoke',
    { rec: 'device', id: lina.signer.device },
    { device: lina.signer.device, seen: { [lina.chain]: 1 } },
    T0 + 130 * MIN,
  );
  const queues: Op[][] = [[demote, revoke], [o1, o2, o3], [p1], [l1, l2], [s1]];
  // which ops a fence did not see: they reach the server after it
  const after = new Map<string, string>([
    [o2.id, demote.id],
    [o3.id, demote.id],
    [p1.id, demote.id],
    [l2.id, revoke.id],
  ]);
  return { people: { rana, omar, lina, sami }, shared, genesis, queues, after };
}

async function server(people: Record<string, Person>) {
  const store = createMemoryStore();
  const core = createCore({
    store,
    identity: ephemeralIdentity(),
    name: 'Parity',
    version: '0',
    fingerprint: '0'.repeat(64),
    now: () => NOW,
  });
  const roles: Record<string, Role> = { rana: 'owner', omar: 'reviewer', lina: 'reviewer' };
  for (const [name, p] of Object.entries(people)) {
    const { code, invite } = makeInvite(roles[name] ?? 'viewer', null, NOW);
    await store.addInvite(invite);
    await core.enrol({ code, device: p.record }, p.signer.device);
  }
  const owner = await store.device(people.rana?.signer.device ?? '');
  if (!owner) throw new Error('not enrolled');
  return { store, core, owner };
}

describe('the server and the app judge the same ops the same way', () => {
  const h = history();
  const all = [...h.shared, ...h.queues.flat()];
  const pin = pinOf(h.shared.map(raw), h.genesis);
  const app = replayTeam(all.map(raw), { verdicts: 'all', pin });
  const appAccepts = new Set(
    all.filter((o) => app.verdicts.get(o.id)?.ok === true).map((o) => o.id),
  );

  it('the history has ops the app refuses, honest and backdated alike', () => {
    expect(app.quarantined.map((q) => q.op).sort()).toEqual(
      [h.queues[1]?.[1], h.queues[1]?.[2], h.queues[2]?.[0], h.queues[3]?.[1], h.queues[4]?.[0]]
        .map((o) => o?.id ?? '')
        .sort(),
    );
    // honest offline work the fences had seen keeps its role
    expect(appAccepts.has(h.queues[1]?.[0]?.id ?? '')).toBe(true);
    expect(appAccepts.has(h.queues[3]?.[0]?.id ?? '')).toBe(true);
  });

  for (let seed = 1; seed <= 25; seed++) {
    it(`accepts exactly what the app accepts (arrival order ${seed})`, async () => {
      const next = random(seed);
      const { store, core, owner } = await server(h.people);
      expect((await core.push(owner, TEST_TEAM, h.shared)).refused).toEqual([]);
      expect((await store.project(TEST_TEAM))?.genesis?.op).toBe(h.genesis);
      // a random interleaving of the chains (each in its own order), fences before what they fence
      const queues = h.queues.map((q) => [...q]);
      const arrived = new Set<string>();
      const accepted = new Set(h.shared.map((o) => o.id));
      while (queues.some((q) => q.length > 0)) {
        const ready = queues.filter((q) => {
          const head = q[0];
          const fence = head ? h.after.get(head.id) : undefined;
          return head !== undefined && (fence === undefined || arrived.has(fence));
        });
        const q = ready[Math.floor(next() * ready.length)];
        const op = q?.shift();
        if (!op) throw new Error('no op ready');
        arrived.add(op.id);
        // the owner forwards everything (as a sync of her copy would)
        const r = await core.push(owner, TEST_TEAM, [op]);
        for (const id of r.accepted) accepted.add(id);
      }
      expect([...accepted].sort()).toEqual([...appAccepts].sort());
    });
  }

  it('differs only in time: an op stored before the fence that did not see it', async () => {
    const { core, owner } = await server(h.people);
    await core.push(owner, TEST_TEAM, h.shared);
    const [, o2] = h.queues[1] ?? [];
    const [demote] = h.queues[0] ?? [];
    const o1 = h.queues[1]?.[0];
    if (!o1 || !o2 || !demote) throw new Error('history');
    // o2 reaches the server before the demotion that did not see it: it is stored
    expect((await core.push(owner, TEST_TEAM, [o1, o2])).accepted).toEqual([o1.id, o2.id]);
    expect((await core.push(owner, TEST_TEAM, [demote])).accepted).toEqual([demote.id]);
    // the app, with every op, quarantines it
    expect(appAccepts.has(o2.id)).toBe(false);
  });
});
