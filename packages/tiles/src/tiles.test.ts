import { describe, expect, it } from 'vitest';
import { TILES_BUDGETS, readTilesets, tilesBudget, tilesetsToLoad } from './index';

const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: 'mesh',
  src: `tiles/${id}/tileset.json`,
  visible: true,
  ...over,
});

describe('@aio/tiles public API (G0)', () => {
  it('reads tilesets.json, an absent file as none, and refuses a bad one', () => {
    expect(readTilesets(undefined)).toEqual({
      ok: true,
      file: { schema: 'aio.tilesets/1', entries: [] },
    });
    const r = readTilesets({
      schema: 'aio.tilesets/1',
      entries: [entry('a'), entry('b', { visible: false }), entry('c', { capture: 'c2' })],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(tilesetsToLoad(r.file).map((e) => e.id)).toEqual(['a', 'c']);
      expect(tilesetsToLoad(r.file, 'c1').map((e) => e.id)).toEqual(['a']);
    }
    const bad = readTilesets({ schema: 'aio.tilesets/1', entries: [entry('x', { src: '/abs' })] });
    expect(bad.ok).toBe(false);
  });

  it('keeps less of a tileset on lower graphics tiers', () => {
    expect(tilesBudget('low').maxBytes).toBeLessThan(TILES_BUDGETS.high.maxBytes);
    expect(tilesBudget('low').errorTarget).toBeGreaterThan(TILES_BUDGETS.high.errorTarget);
    expect(tilesBudget('low').surroundings).toBe(false);
  });
});
