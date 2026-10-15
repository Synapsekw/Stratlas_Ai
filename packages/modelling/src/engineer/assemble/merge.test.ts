import { ProcModel, type Assembly } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { component, engineeringModel } from '../fixtures';
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
    expect(r.assemblies[0]).toBe(prev.assemblies[0]);
    expect(r.flagged.map((f) => f.id)).toEqual(['flue-1']);
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
    expect(moved.quality.centre).toEqual({ basis: 'user' });
    expect(byId(next.model, 'light-l2-2')).toBe(byId(prev, 'light-l2-2'));
    const l = byId(next.model, 'light-l2-2');
    expect(l.kind === 'warningLight' && l.params.fixture).toBe('beacon');
    expect(next.changed.sort()).toEqual(['light-l1-1', 'light-l1-2', 'light-l1-3']);
  });
});
