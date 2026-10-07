import { describe, expect, it } from 'vitest';
import { indexOps } from './causal';
import { TeamSim } from './testing/generator';

const t = { rec: 'issue', id: 'i_1' };

describe('indexOps', () => {
  it('orders by clock reading and tells later ops from concurrent ones', () => {
    const sim = new TeamSim({ people: 2 });
    const a1 = sim.write(0, 'issue.patch', t, { set: { note: 'a' } });
    sim.sync(0, 1);
    const b1 = sim.write(1, 'issue.patch', t, { set: { note: 'b' } }); // saw a1
    const a2 = sim.write(0, 'issue.patch', t, { set: { note: 'c' } }); // did not see b1
    const idx = indexOps([a2, b1, a1]);
    const n = (id: string) => idx.byId.get(id) ?? expect.fail(id);
    expect(idx.nodes.map((x) => x.op.id)).toEqual([a1.id, b1.id, a2.id]);
    expect(idx.before(n(a1.id), n(b1.id))).toBe(true);
    expect(idx.before(n(a1.id), n(a2.id))).toBe(true);
    expect(idx.concurrent(n(b1.id), n(a2.id))).toBe(true);
    expect(idx.before(n(b1.id), n(a1.id))).toBe(false);
    expect(idx.held).toEqual([]);
  });

  it('dedupes by id and holds ops whose prev or deps are missing', () => {
    const sim = new TeamSim({ people: 2 });
    const a1 = sim.write(0, 'issue.patch', t, { set: { note: 'a' } });
    const a2 = sim.write(0, 'issue.patch', t, { set: { note: 'b' } });
    sim.sync(0, 1);
    const b1 = sim.write(1, 'issue.patch', t, { set: { note: 'c' } });
    const idx = indexOps([a2, b1, a2, b1]);
    expect(idx.nodes).toHaveLength(2);
    expect(idx.held.map((h) => h.op).sort()).toEqual([a2.id, b1.id].sort());
    const h = idx.held.find((x) => x.op === a2.id);
    expect(h?.missing).toEqual([{ chain: a1.chain, op: a1.id, seq: 1 }]);
    expect(indexOps([a1, a2, b1]).held).toEqual([]);
  });

  it('gives the same index whatever the arrival order', () => {
    const sim = new TeamSim({ people: 3 });
    const ops = [];
    for (let i = 0; i < 12; i += 1) {
      ops.push(sim.write(i % 3, 'issue.patch', t, { set: { severity: i } }));
      if (i % 4 === 0) sim.sync(i % 3, (i + 1) % 3);
    }
    const a = indexOps(ops);
    const b = indexOps([...ops].reverse());
    expect(b.nodes.map((x) => [x.op.id, [...(x.vc ?? [])]])).toEqual(
      a.nodes.map((x) => [x.op.id, [...(x.vc ?? [])]]),
    );
  });
});
