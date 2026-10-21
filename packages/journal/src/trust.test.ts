import type { Op } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { randomId } from './hash';
import { pinOf, replayTeam, type TeamPin } from './members';
import { sealOp } from './op';
import { signerFromSeed, type Signer } from './sign';

/**
 * Attacks on the shared history (security review, Oct 2026): a copy is only as safe as the team it
 * replays. Each test writes the attack as a folder or exchange file could deliver it and checks the
 * replay holds it, and that an honest history still replays as before.
 */

// TEST-ONLY seeds: fictional people, never real devices.
interface Person {
  actor: string;
  name: string;
  initials: string;
  signer: Signer;
}
const person = (name: string, initials: string, seed: string): Person => ({
  actor: randomId('a_', 26),
  name,
  initials,
  signer: signerFromSeed(seed),
});

const T0 = 1_790_000_000_000;

function journal() {
  const ops: Op[] = [];
  const heads = new Map<string, { seq: number; id: string }>();
  let ms = T0;
  return {
    ops,
    write(
      by: Person,
      kind: string,
      payload: unknown,
      opts: { ms?: number; replica?: string; target?: { rec: string; id: string } } = {},
    ): Op {
      const chain = `${by.signer.device}.r_${(opts.replica ?? 'a').repeat(16)}`;
      const head = heads.get(chain);
      if (opts.ms === undefined) ms += 1000;
      const op = sealOp(
        {
          v: 1,
          chain,
          dev: by.signer.device,
          act: by.actor,
          seq: (head?.seq ?? 0) + 1,
          hlc: `${String(opts.ms ?? ms).padStart(13, '0')}.0000.${by.signer.device}`,
          prev: head?.id ?? null,
          kind,
          target: opts.target ?? { rec: 'member', id: by.actor },
        },
        payload,
        by.signer,
      );
      heads.set(chain, { seq: op.seq, id: op.id });
      ops.push(op);
      return op;
    },
    /** What this copy has seen of a device's chains: seq per chain. */
    seenOf(...devices: string[]): Record<string, number> {
      return Object.fromEntries(
        [...heads]
          .filter(([c]) => devices.includes(c.split('.')[0] ?? ''))
          .map(([c, h]) => [c, h.seq]),
      );
    },
  };
}

const card = (p: Person, role: string) => ({
  actor: p.actor,
  name: p.name,
  initials: p.initials,
  role,
  devices: [{ id: p.signer.device, key: p.signer.publicKey }],
});

const issue = { rec: 'issue', id: 'i1' };
const patch = { set: { severity: 3 } };

function team() {
  const rana = person('Rana Example', 'RE', '11'.repeat(32));
  const omar = person('Omar Sample', 'OS', '22'.repeat(32));
  const mallory = person('Mallory Example', 'ME', '66'.repeat(32));
  const j = journal();
  // private history, then the share: project.share and the owner adding themself
  const draft = j.write(rana, 'issue.patch', patch, { target: issue });
  j.write(
    rana,
    'project.share',
    { teamProjectId: `t_${'a'.repeat(26)}`, name: 'P' },
    {
      target: { rec: 'project', id: 'p' },
    },
  );
  const genesis = j.write(rana, 'member.add', card(rana, 'owner'));
  const pin: TeamPin | null = pinOf(j.ops, genesis.id);
  if (!pin) throw new Error('No genesis to pin');
  return { rana, omar, mallory, j, draft, genesis, pin };
}

describe('pinned genesis (backdated owner takeover)', () => {
  it('without a pin, a 1970 self-made owner takes the team (the attack this closes)', () => {
    const { mallory, j } = team();
    j.write(mallory, 'member.add', card(mallory, 'owner'), { ms: 1000 });
    const r = replayTeam(j.ops);
    expect(r.members.map((m) => m.name)).toEqual(['Mallory Example']);
  });

  it('with the pin, only the pinned op makes the first owner', () => {
    const { rana, mallory, j, pin } = team();
    const fake = j.write(mallory, 'member.add', card(mallory, 'owner'), { ms: 1000 });
    const edit = j.write(mallory, 'issue.patch', patch, { ms: 2000, target: issue });
    const r = replayTeam(j.ops, { verdicts: 'all', pin });
    expect(r.members.map((m) => m.actor)).toEqual([rana.actor]);
    expect(r.verdicts.get(fake.id)).toMatchObject({ ok: false, code: 'not-member' });
    expect(r.verdicts.get(edit.id)).toMatchObject({ ok: false, code: 'not-member' });
  });

  it('keeps the private history the project was shared with', () => {
    const { draft, j, pin } = team();
    const r = replayTeam(j.ops, { verdicts: 'all', pin });
    expect(r.shared).toBe(true);
    expect(r.verdicts.get(draft.id)).toEqual({ ok: true });
  });

  it('holds a backdated op on a chain the pin does not cover, even with no member.add', () => {
    const { mallory, j, pin } = team();
    const early = j.write(mallory, 'issue.patch', patch, { ms: 5000, target: issue });
    const r = replayTeam(j.ops, { verdicts: 'all', pin });
    expect(r.verdicts.get(early.id)).toMatchObject({ ok: false });
  });

  it('pins the heads of the history before the genesis', () => {
    const { rana, genesis, j, pin } = team();
    expect(pin.op).toBe(genesis.id);
    expect(pin.heads).toEqual({ [`${rana.signer.device}.r_${'a'.repeat(16)}`]: 3 });
    expect(pinOf(j.ops, 'missing')).toBeNull();
  });
});

describe('clock readings along a chain', () => {
  it('holds an op whose clock goes back from the op before it in its chain', () => {
    const { rana, j, pin } = team();
    const back = j.write(rana, 'issue.patch', patch, { ms: 1000, target: issue });
    const r = replayTeam(j.ops, { verdicts: 'all', pin });
    expect(r.verdicts.get(back.id)).toMatchObject({ ok: false, code: 'clock-back' });
    // the same check without a pin
    expect(replayTeam(j.ops, { verdicts: 'all' }).verdicts.get(back.id)).toMatchObject({
      ok: false,
      code: 'clock-back',
    });
  });
});

describe('revocation, removal and demotion cannot be dodged by backdating', () => {
  function withOmar() {
    const t = team();
    t.j.write(t.rana, 'member.add', card(t.omar, 'reviewer'));
    const seen1 = t.j.write(t.omar, 'issue.patch', patch, { target: issue });
    return { ...t, seen1 };
  }

  it('a revoked device writing just before the revocation is held', () => {
    const { rana, omar, j, pin, seen1 } = withOmar();
    const revoke = j.write(rana, 'device.revoke', {
      device: omar.signer.device,
      seen: j.seenOf(omar.signer.device),
    });
    const ms = Number(revoke.hlc.slice(0, 13)) - 1;
    const dodge = j.write(omar, 'issue.patch', patch, { ms, target: issue });
    // a new replica chain, dated long before the revocation
    const fresh = j.write(omar, 'issue.patch', patch, {
      ms: ms - 500,
      replica: 'b',
      target: issue,
    });
    for (const opts of [{ pin }, {}]) {
      const r = replayTeam(j.ops, { verdicts: 'all', ...opts });
      expect(r.verdicts.get(seen1.id)).toEqual({ ok: true });
      expect(r.verdicts.get(dodge.id)).toMatchObject({ ok: false, code: 'revoked-device' });
      expect(r.verdicts.get(fresh.id)).toMatchObject({ ok: false, code: 'revoked-device' });
    }
  });

  it('a removed member writing just before the removal is held', () => {
    const { rana, omar, j, pin, seen1 } = withOmar();
    const remove = j.write(rana, 'member.remove', {
      actor: omar.actor,
      seen: j.seenOf(omar.signer.device),
    });
    const ms = Number(remove.hlc.slice(0, 13)) - 1;
    const dodge = j.write(omar, 'issue.patch', patch, { ms, target: issue });
    const r = replayTeam(j.ops, { verdicts: 'all', pin });
    expect(r.verdicts.get(seen1.id)).toEqual({ ok: true });
    expect(r.verdicts.get(dodge.id)).toMatchObject({ ok: false, code: 'not-member' });
  });

  it('a demoted member writing as their old role just before the demotion is held', () => {
    const { rana, omar, j, pin } = withOmar();
    const demote = j.write(rana, 'member.role', {
      actor: omar.actor,
      role: 'viewer',
      seen: j.seenOf(omar.signer.device),
    });
    const ms = Number(demote.hlc.slice(0, 13)) - 1;
    const dodge = j.write(omar, 'issue.patch', patch, { ms, target: issue });
    const r = replayTeam(j.ops, { verdicts: 'all', pin });
    expect(r.verdicts.get(dodge.id)).toMatchObject({ ok: false, code: 'role' });
  });

  it('a promotion moves nothing: ops before it keep the role they were written under', () => {
    const { rana, omar, j, pin } = withOmar();
    j.write(rana, 'member.role', { actor: omar.actor, role: 'viewer' });
    const asViewer = j.write(omar, 'issue.patch', patch, { target: issue });
    j.write(rana, 'member.role', { actor: omar.actor, role: 'reviewer', seen: {} });
    const r = replayTeam(j.ops, { verdicts: 'all', pin });
    expect(r.verdicts.get(asViewer.id)).toMatchObject({ ok: false, code: 'role' });
  });

  it('an older revocation without `seen` keeps judging by clock reading (compatibility)', () => {
    const { rana, omar, j, seen1 } = withOmar();
    const revoke = j.write(rana, 'device.revoke', { device: omar.signer.device });
    const ms = Number(revoke.hlc.slice(0, 13)) - 1;
    const before = j.write(omar, 'issue.patch', patch, { ms, target: issue });
    const r = replayTeam(j.ops, { verdicts: 'all' });
    expect(r.verdicts.get(seen1.id)).toEqual({ ok: true });
    expect(r.verdicts.get(before.id)).toEqual({ ok: true });
  });

  it('a revoked owner cannot revoke back with a backdated revocation', () => {
    const t = team();
    const { rana, omar, j, pin } = t;
    j.write(rana, 'member.add', card(omar, 'owner'));
    const revoke = j.write(rana, 'device.revoke', {
      device: omar.signer.device,
      seen: j.seenOf(omar.signer.device),
    });
    const ms = Number(revoke.hlc.slice(0, 13)) - 1;
    const back = j.write(omar, 'device.revoke', { device: rana.signer.device, seen: {} }, { ms });
    const r = replayTeam(j.ops, { verdicts: 'all', pin });
    expect(r.verdicts.get(revoke.id)).toEqual({ ok: true });
    expect(r.verdicts.get(back.id)).toMatchObject({ ok: false, code: 'revoked-device' });
    expect(r.members.find((m) => m.actor === rana.actor)?.devices[0]?.revoked).toBe(false);
  });

  it('converges whatever order the ops arrive in', () => {
    const { rana, omar, j, pin } = withOmar();
    const revoke = j.write(rana, 'device.revoke', {
      device: omar.signer.device,
      seen: j.seenOf(omar.signer.device),
    });
    j.write(omar, 'issue.patch', patch, { ms: Number(revoke.hlc.slice(0, 13)) - 1, target: issue });
    const a = replayTeam(j.ops, { verdicts: 'all', pin });
    const b = replayTeam([...j.ops].reverse(), { verdicts: 'all', pin });
    expect([...b.verdicts.entries()].sort()).toEqual([...a.verdicts.entries()].sort());
  });
});
