import { describe, expect, it } from 'vitest';
import { changeProducers, registerChangeProducer, type ChangeProducer } from './index';

const producer = (id: string): ChangeProducer => ({
  id,
  label: `Run ${id} change`,
  kinds: ['region'],
  available: () => true,
  run: () => Promise.resolve({ ok: true, ids: [] }),
});

describe('change producer registry', () => {
  it('lists producers in order, refuses a duplicate id and unregisters', () => {
    const offA = registerChangeProducer(producer('a'));
    const offB = registerChangeProducer(producer('b'));
    expect(changeProducers().map((p) => p.id)).toEqual(['a', 'b']);
    expect(() => registerChangeProducer(producer('a'))).toThrow(/already registered/);
    offA();
    expect(changeProducers().map((p) => p.id)).toEqual(['b']);
    offB();
    expect(changeProducers()).toEqual([]);
  });
});
