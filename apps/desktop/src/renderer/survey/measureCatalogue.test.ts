import { setLocale } from '@aio/ui';
import { describe, expect, it } from 'vitest';
import {
  ALL_TOOLS,
  createFavouritesStore,
  DEFAULT_FAVOURITES,
  FAMILIES,
  familiesFor,
  FAVOURITES_KEY,
  favouritesAndRecent,
  matchesQuery,
} from './measureCatalogue';

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(seed));
  return {
    get length() {
      return data.size;
    },
    clear: () => {
      data.clear();
    },
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => {
      data.delete(k);
    },
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

describe('measure catalogue', () => {
  it('reads its names in the language in use, and the search follows them', () => {
    try {
      setLocale('xx', { 'measureCat.tool.distance': 'Strecke', 'measureCat.family.line': 'Linie' });
      const distance = ALL_TOOLS.find((e) => e.tool === 'distance');
      expect(distance?.label).toBe('Strecke');
      expect(FAMILIES.find((f) => f.id === 'line')?.label).toBe('Linie');
      expect(distance && matchesQuery(distance, 'strecke')).toBe(true);
    } finally {
      setLocale('en');
    }
    expect(ALL_TOOLS.find((e) => e.tool === 'distance')?.label).toBe('Distance');
  });

  it('has the 15 tools of D12 in their families', () => {
    expect(ALL_TOOLS).toHaveLength(15);
    expect(FAMILIES.map((f) => [f.id, f.label, f.tools.map((e) => e.label)])).toEqual([
      ['point', 'Point', ['Elevation', 'Elevation difference', 'Annotation']],
      [
        'line',
        'Line',
        ['Distance', 'Grade and slope', 'Vertex differences', 'Berm check', 'Cross-section'],
      ],
      ['polygon', 'Polygon', ['Area', 'Volume']],
      ['telecom', 'Telecom', ['Antenna azimuth', 'Physical tilt', 'Clearance']],
      ['markup', 'Markup', ['Freehand']],
      ['section', 'Section plane', ['Section plane']],
    ]);
    // every tool has a one-line hint
    for (const e of ALL_TOOLS) expect(e.hint.length).toBeGreaterThan(0);
  });

  it('keeps M on Distance and X on the section plane', () => {
    const keys = ALL_TOOLS.filter((e) => e.key).map((e) => [e.tool, e.key]);
    expect(keys).toEqual([
      ['distance', 'scene.measure'],
      ['section-plane', 'scene.section'],
    ]);
  });

  it('a read-only package offers only the tools that read without saving', () => {
    expect(familiesFor(true).map((f) => [f.id, f.tools.map((e) => e.tool)])).toEqual([
      ['line', ['distance']],
      ['section', ['section-plane']],
    ]);
    expect(familiesFor(false).flatMap((f) => f.tools)).toHaveLength(15);
  });

  it('searches the tool names, not their hints', () => {
    const hits = ALL_TOOLS.filter((e) => matchesQuery(e, 'slope')).map((e) => e.tool);
    // Area's hint says "slope area" and Berm check's "side slopes": only the name counts
    expect(hits).toEqual(['grade']);
    expect(ALL_TOOLS.filter((e) => matchesQuery(e, '  '))).toHaveLength(15);
  });
});

describe('favourites', () => {
  it('start as Distance, Elevation, Area and Volume', () => {
    const s = createFavouritesStore(memoryStorage());
    expect(s.getState().favourites).toEqual(DEFAULT_FAVOURITES);
    expect(DEFAULT_FAVOURITES).toEqual(['distance', 'elevation', 'area', 'volume']);
  });

  it('are remembered on this computer', () => {
    const storage = memoryStorage();
    const s = createFavouritesStore(storage);
    s.getState().toggle('elevation');
    s.getState().toggle('grade');
    expect(JSON.parse(storage.getItem(FAVOURITES_KEY) ?? '')).toEqual([
      'distance',
      'area',
      'volume',
      'grade',
    ]);
    expect(createFavouritesStore(storage).getState().favourites).toEqual([
      'distance',
      'area',
      'volume',
      'grade',
    ]);
  });

  it('drop unknown tools and survive blocked storage', () => {
    const s = createFavouritesStore(
      memoryStorage({ [FAVOURITES_KEY]: JSON.stringify(['berm-check', 'nope', 3]) }),
    );
    expect(s.getState().favourites).toEqual(['berm-check']);
    expect(
      createFavouritesStore(memoryStorage({ [FAVOURITES_KEY]: '{' })).getState().favourites,
    ).toEqual(DEFAULT_FAVOURITES);
    expect(createFavouritesStore(null).getState().favourites).toEqual(DEFAULT_FAVOURITES);
  });

  it('list the recent tools after the stars, newest first, three at most', () => {
    const s = createFavouritesStore(memoryStorage());
    for (const tool of ['grade', 'distance', 'freehand', 'clearance', 'grade'] as const)
      s.getState().used(tool);
    expect(s.getState().recent).toEqual(['grade', 'clearance', 'freehand']);
    expect(favouritesAndRecent(s.getState())).toEqual([
      'distance',
      'elevation',
      'area',
      'volume',
      'grade',
      'clearance',
      'freehand',
    ]);
  });
});
