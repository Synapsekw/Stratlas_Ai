import { describe, expect, it } from 'vitest';
import { priorCaptures, undoBatches } from './dateUndo';

const manifest = {
  layers: [
    { id: 'a', capture: 'nov' },
    { id: 'b', capture: 'nov' },
    { id: 'named' }, // filed by the date in its name: no capture of its own
    { id: 'other', capture: 'oct' },
  ],
};

describe('priorCaptures', () => {
  it('remembers the capture each layer has of its own, null for none', () => {
    expect(priorCaptures(manifest, ['a', 'named', 'b'])).toEqual([
      { id: 'a', capture: 'nov' },
      { id: 'named', capture: null },
      { id: 'b', capture: 'nov' },
    ]);
  });

  it('skips a layer the project does not hold', () => {
    expect(priorCaptures(manifest, ['gone', 'a'])).toEqual([{ id: 'a', capture: 'nov' }]);
  });
});

describe('undoBatches', () => {
  const known = new Set(['a', 'b', 'named']);

  it('is one write per earlier value, so each layer gets back exactly what it had', () => {
    const moved = [
      { id: 'a', capture: 'nov' },
      { id: 'named', capture: null },
      { id: 'b', capture: 'nov' },
    ];
    expect(undoBatches(moved, known)).toEqual([
      { capture: 'nov', layerIds: ['a', 'b'] },
      { capture: null, layerIds: ['named'] },
    ]);
  });

  it('leaves out a layer that was removed since the move', () => {
    const moved = [
      { id: 'a', capture: 'nov' },
      { id: 'removed', capture: 'nov' },
    ];
    expect(undoBatches(moved, known)).toEqual([{ capture: 'nov', layerIds: ['a'] }]);
  });

  it('is nothing when every moved layer is gone', () => {
    expect(undoBatches([{ id: 'removed', capture: 'nov' }], known)).toEqual([]);
  });
});
