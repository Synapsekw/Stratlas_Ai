import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import {
  createCompareDates,
  defaultPair,
  followProject,
  orderPair,
  pairFor,
  pairIn,
  type DatedCapture,
} from './compareDates';

const captures: DatedCapture[] = [
  { capture: 'c', t: 300 },
  { capture: 'undated', t: null },
  { capture: 'a', t: 100 },
  { capture: 'b', t: 200 },
];
const timeOf = (c: string) => captures.find((x) => x.capture === c)?.t ?? null;

describe('defaultPair', () => {
  it('pairs the survey before the focus with the focus', () => {
    expect(defaultPair('c', captures)).toEqual({ from: 'b', to: 'c' });
    expect(defaultPair('b', captures)).toEqual({ from: 'a', to: 'b' });
  });

  it('pairs the first survey with the next one', () => {
    expect(defaultPair('a', captures)).toEqual({ from: 'a', to: 'b' });
  });

  it('falls back to the last two surveys for no focus or an undated focus', () => {
    expect(defaultPair(null, captures)).toEqual({ from: 'b', to: 'c' });
    expect(defaultPair('undated', captures)).toEqual({ from: 'b', to: 'c' });
  });

  it('is null with fewer than two dated surveys', () => {
    expect(
      defaultPair('a', [
        { capture: 'a', t: 1 },
        { capture: 'x', t: null },
      ]),
    ).toBeNull();
  });
});

describe('orderPair', () => {
  it('swaps when from is after to', () => {
    expect(orderPair('c', 'a', timeOf)).toEqual({ from: 'a', to: 'c' });
    expect(orderPair('a', 'c', timeOf)).toEqual({ from: 'a', to: 'c' });
  });
});

describe('compareDates store', () => {
  it('starts off and empty', () => {
    expect(createCompareDates().getState()).toMatchObject({ on: false, from: null, to: null });
  });

  it('turns on with the defaults from the focus', () => {
    const s = createCompareDates();
    s.getState().toggle(defaultPair('c', captures));
    expect(s.getState()).toMatchObject({ on: true, from: 'b', to: 'c' });
    s.getState().toggle();
    expect(s.getState()).toMatchObject({ on: false, from: 'b', to: 'c' });
  });

  it('keeps a pair already chosen when it turns on again', () => {
    const s = createCompareDates();
    s.getState().set('a', 'c', timeOf);
    s.getState().toggle(defaultPair('c', captures));
    expect(s.getState()).toMatchObject({ on: true, from: 'a', to: 'c' });
  });

  it('swaps a pair set the wrong way round', () => {
    const s = createCompareDates();
    s.getState().set('c', 'b', timeOf);
    expect(s.getState()).toMatchObject({ from: 'b', to: 'c' });
  });
});

describe('pairIn and pairFor', () => {
  it('a pair is valid only when both captures are among the current ones', () => {
    expect(pairIn({ from: 'a', to: 'b' }, ['a', 'b', 'c'])).toBe(true);
    expect(pairIn({ from: 'a', to: 'x' }, ['a', 'b', 'c'])).toBe(false);
    expect(pairIn({ from: 'a', to: 'a' }, ['a', 'b'])).toBe(false);
    expect(pairIn({ from: null, to: 'a' }, ['a', 'b'])).toBe(false);
  });

  it('pairFor keeps a valid pair and falls back to the default for another project', () => {
    expect(pairFor({ from: 'a', to: 'c' }, 'c', captures)).toEqual({ from: 'a', to: 'c' });
    expect(pairFor({ from: 'p1', to: 'p2' }, 'c', captures)).toEqual({ from: 'b', to: 'c' });
    expect(pairFor({ from: null, to: null }, 'b', captures)).toEqual({ from: 'a', to: 'b' });
  });
});

describe('compareDates across projects', () => {
  const project = (id: string, ids: string[]) => ({
    project: { id, manifest: { captures: ids.map((c) => ({ id: c })) } },
  });

  it('reset turns Compare off and forgets the pair', () => {
    const s = createCompareDates();
    s.getState().set('a', 'c', timeOf);
    s.getState().toggle();
    s.getState().reset(['x', 'y']);
    expect(s.getState()).toMatchObject({ on: false, from: null, to: null });
  });

  it('toggle replaces a pair whose captures are not among the current ones', () => {
    const s = createCompareDates();
    s.getState().set('p1', 'p2');
    s.getState().setKnown(['a', 'b', 'c']);
    s.getState().toggle(defaultPair('c', captures));
    expect(s.getState()).toMatchObject({ on: true, from: 'b', to: 'c' });
  });

  it('follows the open project: a project change resets the pair', () => {
    const s = createCompareDates();
    const ws = createStore<{
      project: { id: string; manifest: { captures: { id: string }[] } } | null;
    }>(() => project('one', ['a', 'b', 'c']));
    const off = followProject(s, ws);
    s.getState().set('a', 'c', timeOf);
    s.getState().toggle();
    ws.setState(project('one', ['a', 'b', 'c', 'd']));
    expect(s.getState()).toMatchObject({
      on: true,
      from: 'a',
      to: 'c',
      known: ['a', 'b', 'c', 'd'],
    });
    ws.setState(project('two', ['p1', 'p2']));
    expect(s.getState()).toMatchObject({ on: false, from: null, to: null, known: ['p1', 'p2'] });
    off();
  });
});
