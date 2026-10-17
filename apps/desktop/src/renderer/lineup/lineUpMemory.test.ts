import { describe, expect, it } from 'vitest';
import { createLineUpMemory } from './lineUpMemory';

/** A Storage over a Map, as the browser's. */
function mapStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => {
      m.clear();
    },
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => {
      m.delete(k);
    },
    setItem: (k, v) => {
      m.set(k, v);
    },
  };
}

describe('lineUpMemory', () => {
  it('remembers Not now per project and pair', () => {
    const storage = mapStorage();
    const a = createLineUpMemory(storage);
    a.notNow('p', 'o1|o2');
    a.markMeasured('p', 'o1|o2');
    // a later session reads the same storage
    const b = createLineUpMemory(storage);
    expect(b.isNotNow('p', 'o1|o2')).toBe(true);
    expect(b.isNotNow('q', 'o1|o2')).toBe(false);
    expect(b.isNotNow('p', 'o1|o3')).toBe(false);
    expect([...b.measured('p')]).toEqual(['o1|o2']);
    expect(b.measured('q').size).toBe(0);
    expect(storage.getItem('quadrion.lineUp.notNow')).not.toBeNull();
    expect(storage.getItem('quadrion.lineUp.measured')).not.toBeNull();
    for (let i = 0; i < 600; i++) b.markMeasured('p', `a${String(i)}|b`);
    const kept = JSON.parse(storage.getItem('quadrion.lineUp.measured') ?? '[]') as unknown[];
    expect(kept).toHaveLength(500);
  });

  it('works without storage', () => {
    const blocked = mapStorage();
    blocked.setItem = () => {
      throw new Error('blocked');
    };
    blocked.getItem = () => {
      throw new Error('blocked');
    };
    for (const storage of [null, blocked]) {
      const m = createLineUpMemory(storage);
      expect(m.isNotNow('p', 'k')).toBe(false);
      m.notNow('p', 'k');
      m.markMeasured('p', 'k');
      expect(m.isNotNow('p', 'k')).toBe(true);
      expect(m.measured('p').has('k')).toBe(true);
    }
  });
});
