import { ProcModel, type Assembly, type EvidencePack } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { component, engineeringModel, stackEvidence } from '../fixtures';
import { mergeModels } from './merge';
import { assembleStack, byId, byKind, must, withStatus } from './testAssemble';

const engineer = (a: Assembly): Assembly => ({ ...a, origin: { by: 'engineer', runId: 'run-a' } });
const flue = (id: string, x: number, status: Assembly['status'] = 'draft'): Assembly =>
  engineer(
    component(
      'flue',
      id,
      'Flues',
      { centre: [x, 10, 0], rOuter: 0.5, rInner: 0.4, height: 3 },
      { status, quality: { centre: { basis: 'observed' } } },
    ),
  );

describe('mergeModels', () => {
  it('keeps the previous object when the regenerated one is the same, whatever run made it', () => {
    const prev = engineeringModel('m', 'M', [flue('flue-1', 1)]);
    const again = { ...flue('flue-1', 1), origin: { by: 'engineer' as const, runId: 'run-b' } };
    const r = mergeModels(prev, [again]);
    expect(r.assemblies[0]).toBe(prev.assemblies[0]);
    expect(r.kept).toEqual(['flue-1']);
    expect(r.changed).toEqual([]);
  });

  it('replaces a changed draft, drops a draft no longer made, and keeps manual ones', () => {
    const manual = component('cabinet', 'cabinet-9', 'Equipment', {
      base: [5, 0, 0],
      size: [1, 2, 1],
      yawDeg: 0,
    });
    const prev = engineeringModel('m', 'M', [flue('flue-1', 1), flue('flue-2', 2), manual]);
    const r = mergeModels(prev, [flue('flue-1', 1.5)]);
    expect(r.assemblies.map((a) => a.id)).toEqual(['flue-1', 'cabinet-9']);
    expect(r.changed.sort()).toEqual(['flue-1', 'flue-2']);
    expect(r.kept).toEqual(['cabinet-9']);
  });

  it('keeps an accepted component over its regenerated values and flags the difference', () => {
    const prev = engineeringModel('m', 'M', [flue('flue-1', 1, 'accepted')]);
    const r = mergeModels(prev, [flue('flue-1', 3)]);
    const kept = must(r.assemblies[0]);
    expect(kept.status).toBe('accepted');
    expect(kept.kind === 'flue' && kept.params).toEqual(must(prev.assemblies[0]).params);
    expect(r.flagged.map((f) => f.id)).toEqual(['flue-1']);
  });

  it('flags an accepted difference once, not again on the next run with the same values', () => {
    const prev = engineeringModel('m', 'M', [flue('flue-1', 1, 'accepted')]);
    const first = mergeModels(prev, [flue('flue-1', 3)]);
    expect(first.flagged.map((f) => f.id)).toEqual(['flue-1']);
    // recorded in its own field; the evidence references are left alone
    const stamped = must(first.assemblies[0]);
    expect(stamped.reviewed).toEqual({
      hash: expect.stringMatching(/^[0-9a-f]{8}$/) as string,
      runId: 'run-a',
    });
    expect(stamped.sources).toEqual(must(prev.assemblies[0]).sources);
    expect(ProcModel.safeParse(engineeringModel('m', 'M', first.assemblies)).success).toBe(true);
    const again = engineeringModel('m', 'M', first.assemblies);
    const second = mergeModels(again, [flue('flue-1', 3)]);
    expect(second.flagged).toEqual([]);
    expect(second.assemblies[0]).toBe(again.assemblies[0]);
    // run values that change once more are flagged again
    const third = mergeModels(again, [flue('flue-1', 4)]);
    expect(third.flagged.map((f) => f.id)).toEqual(['flue-1']);
  });

  it('does not flag an accepted component the run regenerates as it was accepted', () => {
    const prev = engineeringModel('m', 'M', [flue('flue-1', 1, 'accepted')]);
    const r = mergeModels(prev, [flue('flue-1', 1)]);
    expect(r.flagged).toEqual([]);
    expect(r.assemblies[0]).toBe(prev.assemblies[0]);
  });

  it('takes a person value onto an accepted component and keeps it accepted', () => {
    const prev = engineeringModel('m', 'M', [flue('flue-1', 1, 'accepted')]);
    const next = flue('flue-1', 3);
    if (next.kind !== 'flue') throw new Error('test: flue');
    const edited: Assembly = {
      ...next,
      params: { ...next.params, rOuter: 0.7 },
      quality: { ...next.quality, rOuter: { basis: 'user' } },
    };
    const r = mergeModels(prev, [edited]);
    const a = must(r.assemblies[0]);
    expect(a.status).toBe('accepted');
    expect(a.kind === 'flue' && a.params.rOuter).toBe(0.7);
    expect(a.kind === 'flue' && a.params.centre).toEqual([1, 10, 0]);
    expect(a.quality.rOuter).toEqual({ basis: 'user' });
    expect(r.changed).toEqual(['flue-1']);
  });

  it('carries person values of a draft forward when the new run does not repeat them', () => {
    const prev = flue('flue-1', 1);
    if (prev.kind !== 'flue') throw new Error('test: flue');
    const edited: Assembly = {
      ...prev,
      params: { ...prev.params, rOuter: 0.7 },
      quality: { ...prev.quality, rOuter: { basis: 'user' } },
    };
    const r = mergeModels(engineeringModel('m', 'M', [edited]), [flue('flue-1', 1)]);
    expect(r.assemblies[0]).toBe(edited);
  });

  it('flags an accepted component the person removed and keeps it', () => {
    const prev = engineeringModel('m', 'M', [flue('flue-1', 1, 'accepted')]);
    const r = mergeModels(prev, [], { removedRoles: ['flue'] });
    expect(r.assemblies.map((a) => a.id)).toEqual(['flue-1']);
    expect(r.flagged.map((f) => f.id)).toEqual(['flue-1']);
    expect(r.flagged[0]?.reason).toContain('removed');
  });
});

describe('regenerating through assemble', () => {
  it('accepted component survives a lowered count and is flagged', () => {
    const prev = withStatus(assembleStack({ flues: 3 }).model, 'flue-3', 'accepted');
    const next = assembleStack({ flues: 2, previous: prev });
    expect(next.model.assemblies.find((a) => a.id === 'flue-3')?.status).toBe('accepted');
    expect(next.flagged.find((f) => f.id === 'flue-3')?.reason).toContain('count');
    expect(byKind(next.model, 'flue').map((a) => a.id)).toEqual(['flue-1', 'flue-2', 'flue-3']);
    // the deck keeps its opening for the accepted flue it still carries
    const deck = must(byKind(next.model, 'deck')[0]);
    expect(deck.params.openings).toHaveLength(3);
    expect(ProcModel.safeParse(next.model).success).toBe(true);
  });

  it('raising a count adds new ids at the end and keeps the others byte-identical', () => {
    const prev = assembleStack({ flues: 3 });
    const next = assembleStack({ flues: 4, previous: prev.model });
    expect(next.model.assemblies.filter((a) => a.kind === 'flue').map((a) => a.id)).toEqual([
      'flue-1',
      'flue-2',
      'flue-3',
      'flue-4',
    ]);
    for (const id of ['shaft-1', 'light-l1-1', 'band-1'])
      expect(byId(next.model, id)).toEqual(byId(prev.model, id));
  });

  it('three flues to four regenerates only the flues and the deck, keeping accepted edits', () => {
    const first = assembleStack({ user: { params: { 'light-l2-1': { size: 0.5 } } } });
    const prev = withStatus(withStatus(first.model, 'shaft-1', 'accepted'), 'flue-2', 'accepted');
    const next = assembleStack({
      flues: 4,
      previous: prev,
      user: { params: { 'light-l2-1': { size: 0.5 } } },
    });
    expect(next.changed.length).toBeGreaterThan(0);
    expect(next.changed.every((id) => id.startsWith('flue-') || id === 'deck-1')).toBe(true);
    expect(next.changed).toContain('flue-4');
    expect(byId(next.model, 'flue-2')).toBe(byId(prev, 'flue-2'));
    expect(byId(next.model, 'shaft-1')).toBe(byId(prev, 'shaft-1'));
    const light = byId(next.model, 'light-l2-1');
    expect(light.kind === 'warningLight' && light.params.size).toBe(0.5);
    expect(light.quality.size).toEqual({ basis: 'user' });
    const kept = prev.assemblies.filter((a) => !next.changed.includes(a.id)).map((a) => a.id);
    for (const id of kept) expect(byId(next.model, id)).toEqual(byId(prev, id));
  });

  it('a user value wins over measured and is kept across regeneration', () => {
    const prev = assembleStack({ user: { params: { 'shaft-1': { wall: 0.5 } } } });
    const next = assembleStack({
      previous: prev.model,
      user: { params: { 'shaft-1': { wall: 0.5 } } },
    });
    expect(byId(next.model, 'shaft-1').quality.wall).toEqual({ basis: 'user' });
    const s = byId(next.model, 'shaft-1');
    expect(s.kind === 'shaft' && s.params.wall).toBe(0.5);
  });

  it('moving one light level regenerates only that level', () => {
    const prev = assembleStack({});
    const next = assembleStack({ previous: prev.model, user: { levels: { 'light-l1': [45] } } });
    expect(next.changed.length).toBeGreaterThan(0);
    expect(next.changed.every((id) => id.startsWith('light-l1-'))).toBe(true);
    for (const l of byKind(next.model, 'warningLight').filter((a) => a.id.startsWith('light-l1-')))
      expect(l.params.centre[1]).toBeCloseTo(45, 6);
  });

  it('moving a light level keeps accepted lights accepted and the edits of the other levels', () => {
    const user = { params: { 'light-l2-2': { fixture: 'beacon' } } };
    const first = assembleStack({ user });
    const prev = withStatus(
      withStatus(first.model, 'light-l1-2', 'accepted'),
      'light-l2-2',
      'accepted',
    );
    const next = assembleStack({
      previous: prev,
      user: { ...user, levels: { 'light-l1': [45] } },
    });
    // the person's correction lands on the accepted light of that level, which stays accepted
    const moved = byId(next.model, 'light-l1-2');
    expect(moved.status).toBe('accepted');
    expect(moved.kind === 'warningLight' && moved.params.centre[1]).toBeCloseTo(45, 6);
    expect(moved.quality.centre).toEqual({ basis: 'user', note: 'Level moved from 40.00 m.' });
    expect(byId(next.model, 'light-l2-2')).toBe(byId(prev, 'light-l2-2'));
    const l = byId(next.model, 'light-l2-2');
    expect(l.kind === 'warningLight' && l.params.fixture).toBe('beacon');
    expect(next.changed.sort()).toEqual(['light-l1-1', 'light-l1-2', 'light-l1-3']);
  });
});

/** The stack evidence with an extra light level found at `h` metres (lights at 0, 120, 240). */
function withLowLevel(h: number): EvidencePack {
  const ev = stackEvidence();
  return {
    ...ev,
    members: ev.members.map((g) =>
      g.kind === 'light-candidate'
        ? {
            ...g,
            items: [
              ...g.items,
              ...[0, 120, 240].map((az) => {
                const t = (az * Math.PI) / 180;
                const r = 9 - (2.5 * h) / 55 + 0.4;
                return {
                  centre: [r * Math.sin(t), h, -r * Math.cos(t)] as [number, number, number],
                  size: 0.4,
                  support: 60,
                  azimuthDeg: az,
                };
              }),
            ],
          }
        : g,
    ),
  };
}

const lightsOf = (m: ProcModel) =>
  byKind(m, 'warningLight').map((l) => ({ id: l.id, y: l.params.centre[1], status: l.status }));

describe('light level roles across regeneration', () => {
  it('adding a lower level keeps every existing light id and accepted light', () => {
    const prev = withStatus(assembleStack().model, 'light-l1-1', 'accepted');
    const next = assembleStack({ previous: prev, evidence: withLowLevel(10) });
    const before = lightsOf(prev);
    const after = lightsOf(next.model);
    for (const l of before)
      expect(after.find((a) => a.id === l.id)).toEqual({
        ...l,
        y: expect.closeTo(l.y, 6) as number,
      });
    expect(byId(next.model, 'light-l1-1')).toBe(byId(prev, 'light-l1-1'));
    // the new level gets the next role and nothing is duplicated
    const low = after.filter((a) => Math.abs(a.y - 10) < 0.5).map((a) => a.id);
    expect(low.sort()).toEqual(['light-l3-1', 'light-l3-2', 'light-l3-3']);
    expect(new Set(after.map((a) => a.id)).size).toBe(after.length);
    expect(after).toHaveLength(before.length + 3);
    expect(next.changed.sort()).toEqual(['light-l3-1', 'light-l3-2', 'light-l3-3']);
    expect(ProcModel.safeParse(next.model).success).toBe(true);
  });

  it('a level correction still targets the intended level after a lower level appears', () => {
    const prev = assembleStack().model;
    const next = assembleStack({
      previous: prev,
      evidence: withLowLevel(10),
      user: { levels: { 'light-l1': [45] } },
    });
    const ys = (role: string) =>
      lightsOf(next.model)
        .filter((l) => l.id.startsWith(`${role}-`))
        .map((l) => Math.round(l.y));
    expect(ys('light-l1')).toEqual([45, 45, 45]);
    expect(ys('light-l2')).toEqual([80, 80, 80]);
    expect(ys('light-l3')).toEqual([10, 10, 10]);
  });

  it('a level moved above another keeps its role when a new level appears below', () => {
    // l1 (found at 40 m) moved to 95 m, above l2 at 80 m; then a level at 10 m is found. Roles by
    // height order would give 10 m l1; the nearest previous level to 40 m is l2 at 80 m; pairing
    // leftovers in height order gives 10 m l1. Only the height l1 was found at pins it to 40 m.
    const user = { levels: { 'light-l1': [95] } };
    const first = assembleStack({ user });
    const next = assembleStack({ previous: first.model, evidence: withLowLevel(10), user });
    const ys = (role: string) =>
      lightsOf(next.model)
        .filter((l) => l.id.startsWith(`${role}-`))
        .map((l) => Math.round(l.y));
    expect(ys('light-l1')).toEqual([95, 95, 95]);
    expect(ys('light-l2')).toEqual([80, 80, 80]);
    expect(ys('light-l3')).toEqual([10, 10, 10]);
    for (const k of [1, 2, 3])
      expect(byId(next.model, `light-l1-${String(k)}`)).toBe(
        byId(first.model, `light-l1-${String(k)}`),
      );
    expect(next.changed.sort()).toEqual(['light-l3-1', 'light-l3-2', 'light-l3-3']);
  });

  it('rewording or dropping the notes does not change how levels pair', () => {
    const user = { levels: { 'light-l1': [95] } };
    const first = assembleStack({ user });
    const reworded: ProcModel = {
      ...first.model,
      assemblies: first.model.assemblies.map((a) =>
        a.kind === 'warningLight'
          ? { ...a, quality: { ...a.quality, centre: { basis: 'user', note: 'Moved on site.' } } }
          : a,
      ),
    };
    const silent: ProcModel = {
      ...first.model,
      assemblies: first.model.assemblies.map((a) =>
        a.kind === 'warningLight' ? { ...a, quality: {} } : a,
      ),
    };
    const ids = (m: ProcModel) =>
      lightsOf(m)
        .map((l) => `${l.id}@${String(Math.round(l.y))}`)
        .sort();
    const expected = ids(
      assembleStack({ previous: first.model, evidence: withLowLevel(10), user }).model,
    );
    for (const previous of [reworded, silent])
      expect(ids(assembleStack({ previous, evidence: withLowLevel(10), user }).model)).toEqual(
        expected,
      );
    expect(expected.filter((s) => s.startsWith('light-l1-'))).toEqual([
      'light-l1-1@95',
      'light-l1-2@95',
      'light-l1-3@95',
    ]);
  });

  it('a found level that shifts updates an accepted light where it was found, not its values', () => {
    const prev = withStatus(assembleStack().model, 'light-l1-1', 'accepted');
    const shifted = stackEvidence();
    const ev: EvidencePack = {
      ...shifted,
      members: shifted.members.map((g) =>
        g.kind === 'light-candidate'
          ? {
              ...g,
              items: g.items.map((it) =>
                Math.abs(it.centre[1] - 40) < 0.5
                  ? {
                      ...it,
                      centre: [it.centre[0], 41.5, it.centre[2]] as [number, number, number],
                    }
                  : it,
              ),
            }
          : g,
      ),
    };
    const next = assembleStack({ previous: prev, evidence: ev });
    const was = byId(prev, 'light-l1-1');
    const now = byId(next.model, 'light-l1-1');
    if (now.kind !== 'warningLight' || was.kind !== 'warningLight') throw new Error('test: light');
    expect(now.status).toBe('accepted');
    expect(now.params.levelFoundAt).toBeCloseTo(41.5, 6);
    expect(was.params.levelFoundAt).toBeCloseTo(40, 6);
    expect({ ...now.params, levelFoundAt: 0 }).toEqual({ ...was.params, levelFoundAt: 0 });
    expect(now.quality).toEqual(was.quality);
    // the drafts of that level follow the evidence; the accepted one is flagged for review
    const draft = byId(next.model, 'light-l1-2');
    expect(draft.kind === 'warningLight' && draft.params.centre[1]).toBeCloseTo(41.5, 6);
    expect(next.flagged.map((f) => f.id)).toContain('light-l1-1');
    expect(ProcModel.safeParse(next.model).success).toBe(true);
  });

  it('a level the person moved far keeps its role when regenerated', () => {
    const first = assembleStack({ user: { levels: { 'light-l1': [60] } } });
    const next = assembleStack({
      previous: first.model,
      user: { levels: { 'light-l1': [60] } },
    });
    expect(next.changed).toEqual([]);
    expect(lightsOf(next.model).map((l) => l.id)).toEqual(lightsOf(first.model).map((l) => l.id));
  });
});
