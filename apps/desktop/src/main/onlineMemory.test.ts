import { describe, expect, it } from 'vitest';
import { createMemoryTiles, DEFAULT_MEMORY_CAP_BYTES } from './onlineMemory';

const tile = (size: number) => ({ data: Buffer.alloc(size, 1), type: 'image/png' });

describe('the in-memory tiles of providers that forbid offline storage', () => {
  it('is 64 MB by default', () => {
    expect(DEFAULT_MEMORY_CAP_BYTES).toBe(64 * 2 ** 20);
  });

  it('keeps tiles up to its cap and gives up the one used longest ago', () => {
    const m = createMemoryTiles(300);
    m.put('a', tile(100));
    m.put('b', tile(100));
    m.put('c', tile(100));
    // a is used: b is now the oldest
    expect(m.get('a')?.type).toBe('image/png');
    m.put('d', tile(100));
    expect(m.get('b')).toBeNull();
    expect(m.get('a')).not.toBeNull();
    expect(m.stats()).toEqual({ bytes: 300, tiles: 3 });
  });

  it('replaces a tile in place and never keeps one larger than the cap', () => {
    const m = createMemoryTiles(300);
    m.put('a', tile(100));
    m.put('a', tile(150));
    expect(m.stats()).toEqual({ bytes: 150, tiles: 1 });
    m.put('huge', tile(301));
    expect(m.get('huge')).toBeNull();
    m.clear();
    expect(m.stats()).toEqual({ bytes: 0, tiles: 0 });
  });
});
