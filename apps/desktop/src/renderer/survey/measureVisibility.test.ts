import { describe, expect, it } from 'vitest';
import { createMeasureVisibilityMemory } from './measureVisibility';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  } as unknown as Storage;
}

describe('measure visibility memory', () => {
  it('remembers hidden ids per project', () => {
    const s = memoryStorage();
    const m = createMeasureVisibilityMemory(s);
    m.save('p1', ['a', 'b']);
    expect(createMeasureVisibilityMemory(s).load('p1')).toEqual(['a', 'b']);
    expect(createMeasureVisibilityMemory(s).load('p2')).toEqual([]);
    expect(s.getItem('quadrion.measure.hidden:p1')).toBe('["a","b"]');
  });

  it('blocked storage keeps hidden ids for the session', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    const m = createMeasureVisibilityMemory(throwing);
    expect(() => {
      m.save('p1', ['a']);
    }).not.toThrow();
    expect(m.load('p1')).toEqual(['a']);
    expect(createMeasureVisibilityMemory(null).load('p1')).toEqual([]);
  });

  it('reads malformed storage as nothing hidden', () => {
    const s = memoryStorage();
    s.setItem('quadrion.measure.hidden:p1', '{oops');
    expect(createMeasureVisibilityMemory(s).load('p1')).toEqual([]);
  });
});
