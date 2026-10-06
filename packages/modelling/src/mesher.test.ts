import { ProcModel } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { meshProcModel, partNodeName } from './index';

const model = ProcModel.parse({
  schema: 'aio.procmodel/1',
  id: 'site',
  name: 'Site',
  createdAt: '2026-10-06T08:00:00Z',
  updatedAt: '2026-10-06T08:00:00Z',
  parts: [
    {
      kind: 'cylinder',
      id: 'p1',
      tag: 'T-101',
      class: 'tank',
      status: 'accepted',
      origin: { by: 'drawing', layer: 'TANKS' },
      base: [0, 0, 0],
      radius: 10,
      height: 12.5,
      roof: 'cone',
    },
  ],
});

describe('modelling public API', () => {
  it('names a part node by tag, then name, then id', () => {
    const [part] = model.parts;
    if (!part) throw new Error('no part');
    expect(partNodeName(part)).toBe('T-101');
    expect(partNodeName({ ...part, tag: undefined, name: 'Tank one' })).toBe('Tank one');
    expect(partNodeName({ ...part, tag: undefined })).toBe('p1');
  });

  it('has no mesher yet (stream C5)', () => {
    expect(() => meshProcModel(model)).toThrow(/not implemented/);
  });
});
