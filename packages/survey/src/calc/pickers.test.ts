import type { HeightTiles, SurfaceRef } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { projectResolver } from '../engine/resolver';
import {
  customBase,
  isBase,
  itemProblem,
  resolveCurrentPrevious,
  setReferenceLevel,
  setReferenceMode,
  sideFor,
  sideKey,
  sideOptions,
  swapItem,
  terrainWarning,
} from './pickers';

const tiles = (
  id: string,
  capture: string | undefined,
  kind: 'dsm' | 'dtm' | 'derived' = 'dsm',
): HeightTiles => ({
  schema: 'aio.height-tiles/1',
  id,
  name: `Surface ${id}`,
  source: kind === 'derived' ? { kind, of: 'x', edits: [] } : { kind, layer: `layer-${id}` },
  ...(capture ? { capture } : {}),
  crs: { epsg: 32639 },
  cellM: 0.5,
  tileSize: 256,
  originE: 0,
  originN: 0,
  cols: 1,
  rows: 1,
  levels: 1,
  bounds: [0, 0, 0, 128, 128, 10],
  tiles: ['0_0'],
  fingerprint: `fp-${id}`,
  preparedAt: '2026-10-09T00:00:00Z',
});

const SURFACES = [
  tiles('d1', 'c1'),
  tiles('d1-dtm', 'c1', 'dtm'),
  tiles('d3', 'c3'),
  tiles('d3-clean', 'c3', 'derived'),
  tiles('loose', undefined),
];
// c2 has no prepared surface: current and previous skip it
const CAPTURES = ['c1', 'c2', 'c3'];

async function viaEngine(ref: SurfaceRef, capture?: string) {
  const resolve = projectResolver({
    surfaces: SURFACES,
    captures: CAPTURES,
    ...(capture !== undefined ? { capture } : {}),
    fetchBytes: () => Promise.resolve(null),
  });
  try {
    const r = await resolve(ref);
    return { capture: r.capture, name: r.name };
  } catch {
    return null;
  }
}

describe('current and previous', () => {
  it('resolve among the captures with a prepared surface, as the engine does', async () => {
    const latest = resolveCurrentPrevious(SURFACES, CAPTURES);
    expect(latest.current?.capture).toBe('c3');
    expect(latest.current?.surface.id).toBe('d3-clean');
    expect(latest.previous?.capture).toBe('c1');
    expect(latest.previous?.surface.id).toBe('d1');
    for (const capture of [undefined, 'c1', 'c2', 'c3']) {
      const mine = resolveCurrentPrevious(SURFACES, CAPTURES, capture);
      for (const kind of ['current', 'previous'] as const) {
        const engine = await viaEngine({ kind }, capture);
        const r = mine[kind];
        expect(
          r ? { capture: r.capture, name: r.surface.name } : null,
          `${kind} ${String(capture)}`,
        ).toEqual(engine);
      }
    }
  });

  it('viewed on the first survey there is no previous; on one without a surface, no current', () => {
    expect(resolveCurrentPrevious(SURFACES, CAPTURES, 'c1').previous).toBeNull();
    expect(resolveCurrentPrevious(SURFACES, CAPTURES, 'c2').current).toBeNull();
    expect(resolveCurrentPrevious([], CAPTURES).current).toBeNull();
  });
});

describe('picker options and edits', () => {
  const opts = sideOptions({
    surfaces: SURFACES,
    captures: CAPTURES.map((id) => ({ id, label: `Survey ${id}` })),
    designs: [
      {
        id: 'pad',
        name: 'Pad design',
        src: 'pad.xml',
        sha256: 'a'.repeat(64),
        bytes: 1,
        format: 'landxml',
        units: 'm',
        calibrated: false,
        importedAt: '2026-10-09T00:00:00Z',
        layers: [
          {
            id: 'fg',
            name: 'Finished grade',
            kind: 'surface',
            file: 'fg.tin',
            counts: {},
            visible: true,
            archived: false,
            verticalOffsetM: -0.3,
          },
        ],
      },
    ],
  });

  it('offers current, previous, every prepared survey, every design and every base', () => {
    expect(opts.map((o) => o.key)).toEqual([
      'current',
      'previous',
      'survey:d1',
      'survey:d1-dtm',
      'survey:d3',
      'survey:d3-clean',
      'survey:loose',
      'design:pad/fg',
      'reference',
      'smart',
      'fit-plane',
      'perimeter-mean',
      'custom',
    ]);
    expect(opts[0]?.note).toBe('Survey c3');
    expect(opts[1]?.note).toBe('Survey c1');
    expect(opts.find((o) => o.key === 'design:pad/fg')?.note).toBe('offset -0.3 m');
  });

  it('bases get their parameters from the polygon', () => {
    const pts: [number, number, number][] = [
      [0, 0, 10],
      [10, 0, 11],
      [10, 10, 12],
    ];
    const ref = opts.find((o) => o.key === 'reference');
    const custom = opts.find((o) => o.key === 'custom');
    if (!ref || !custom) throw new Error('missing options');
    expect(sideFor(ref, pts)).toEqual({ kind: 'reference', mode: 'level', levelM: 11 });
    expect(sideFor(custom, pts)).toEqual(customBase(pts));
    // the same kind keeps its parameters
    const typed = { kind: 'reference', mode: 'level', levelM: 4 } as const;
    expect(sideFor(ref, pts, typed)).toBe(typed);
    expect(sideKey(typed)).toBe('reference');
    expect(setReferenceMode(typed, 'perimeter-min')).toEqual({
      kind: 'reference',
      mode: 'perimeter-min',
    });
    expect(setReferenceLevel({ kind: 'smart' }, 3)).toEqual({ kind: 'smart' });
  });

  it('swap, the terrain warning and a base on both sides', () => {
    const item = { from: { kind: 'smart' }, to: { kind: 'current' } } as const;
    expect(swapItem(item)).toEqual({ from: { kind: 'current' }, to: { kind: 'smart' } });
    expect(terrainWarning(item)).toBeNull();
    expect(
      terrainWarning({
        from: { kind: 'reference', mode: 'level', levelM: 1 },
        to: { kind: 'design', design: 'pad', layer: 'fg' },
      }),
    ).toBe('No reference to current terrain');
    expect(itemProblem({ from: { kind: 'smart' }, to: { kind: 'fit-plane' } })).toMatch(
      /At least one side/,
    );
    expect(isBase({ kind: 'custom', vertices: [] })).toBe(true);
    expect(isBase({ kind: 'previous' })).toBe(false);
  });
});
