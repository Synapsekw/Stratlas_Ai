import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isChangeHeatMap,
  legendGradient,
  legendTicks,
  legendValue,
  METRES_LEGEND,
  parseChangeLegend,
  SCORE_LEGEND,
} from './changeStyle';

const PY = join(import.meta.dirname, '../../../python/src/aio_pipelines/change');

/** The visible stops `(value, "#colour", alpha)` of a Python stop list. */
function pythonStops(file: string, name: string): [number, string][] {
  const src = readFileSync(join(PY, file), 'utf8');
  const block = src.slice(src.indexOf(`${name}:`), src.indexOf(']\n', src.indexOf(`${name}:`)));
  const out: [number, string][] = [];
  for (const m of block.matchAll(/\((-?[\d.]+), "(#[0-9a-f]{6})", ([\d.]+)\)/g))
    if (Number(m[3]) > 0) out.push([Number(m[1]), m[2] ?? '']);
  return out;
}

describe('change legends', () => {
  it('match the colours the pipelines bake into the heat maps', () => {
    expect(pythonStops('raster.py', 'SCORE_STOPS')).toEqual(SCORE_LEGEND.stops);
    expect(pythonStops('surface.py', 'SURFACE_STOPS')).toEqual(METRES_LEGEND.stops);
  });

  it('reads the legend a heat map index carries, and refuses a broken one', () => {
    const tiles = {
      schema: 'aio.tiles/1',
      legend: {
        kind: 'metres',
        unit: 'm',
        label: 'Height change',
        stops: [
          [-1, '#0000ff'],
          [1, '#ff0000'],
        ],
      },
    };
    expect(parseChangeLegend(tiles)).toEqual({
      kind: 'metres',
      unit: 'm',
      label: 'Height change',
      stops: [
        [-1, '#0000ff'],
        [1, '#ff0000'],
      ],
    });
    expect(parseChangeLegend({})).toBeNull();
    expect(parseChangeLegend({ legend: { kind: 'other', stops: [] } })).toBeNull();
    expect(
      parseChangeLegend({
        legend: {
          kind: 'score',
          stops: [
            [1, '#fff'],
            [0, '#000000'],
          ],
        },
      }),
    ).toBeNull();
    expect(
      parseChangeLegend({
        legend: {
          kind: 'score',
          stops: [
            [0, '#ffffff'],
            [1, '#000000'],
          ],
        },
      })?.label,
    ).toBe('Change score');
  });

  it('spaces the gradient by value and labels the ends in metres', () => {
    expect(legendGradient(METRES_LEGEND)).toBe(
      'linear-gradient(to right, #2166ac 0%, #67a9cf 37.5%, #d1e5f0 47.5%, #fddbc7 52.5%, #ef8a62 62.5%, #b2182b 100%)',
    );
    expect(legendTicks(METRES_LEGEND).map((t) => t.text)).toEqual(['-2 m', '0 m', '+2 m']);
    expect(legendValue(METRES_LEGEND, 0.25)).toBe('+0.25 m');
    expect(legendTicks(SCORE_LEGEND).map((t) => t.text)).toEqual(['35%', '60%', '100%']);
  });

  it('knows a change heat map layer', () => {
    const heat = {
      kind: 'raster',
      id: 'h',
      name: 'Heat',
      visible: true,
      role: 'plan',
      format: 'kit-pyramid',
      src: { path: 'change/x/heat/tiles.json' },
      derived: { kind: 'change', from: 'a', to: 'b' },
    } as const;
    expect(isChangeHeatMap(heat)).toBe(true);
    expect(isChangeHeatMap({ ...heat, derived: undefined })).toBe(false);
  });
});
