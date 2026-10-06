import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  CONTROL,
  PLAN_LAYERS,
  brokenDxf,
  planRaster,
  plotPlan,
  plotPlanDxf,
  toDrawing,
  unitlessDxf,
} from './change-drawing.mjs';
import { TANKS } from './change-scene.mjs';
import { parseDxf, writeDxf } from './dxf.mjs';

const count = (doc, type) => doc.entities.filter((e) => e.type === type).length;

describe('dxf writer and reader', () => {
  it('round-trips layers, blocks and entities', () => {
    const text = writeDxf({
      units: 'm',
      layers: [{ name: 'A' }],
      blocks: { B: [{ type: 'LINE', layer: '0', a: [0, 0], b: [1, 1] }] },
      entities: [
        { type: 'CIRCLE', layer: 'A', c: [10.5, 20.25], r: 3 },
        {
          type: 'POLYLINE',
          layer: 'A',
          closed: true,
          points: [
            [0, 0],
            [2, 0],
            [2, 1],
          ],
        },
        { type: 'TEXT', layer: 'A', at: [1, 2], h: 0.5, text: 'T-1 H=4.0' },
        { type: 'INSERT', layer: 'A', block: 'B', at: [5, 5] },
      ],
    });
    expect(text).not.toContain('\r');
    const doc = parseDxf(text);
    expect(doc.header.$INSUNITS[70]).toBe(6);
    expect(doc.layers).toEqual(['A']);
    expect(doc.blocks.B).toHaveLength(1);
    expect(doc.entities.map((e) => e.type)).toEqual(['CIRCLE', 'POLYLINE', 'TEXT', 'INSERT']);
    expect(doc.entities[0]).toMatchObject({ layer: 'A', 10: 10.5, 20: 20.25, 40: 3 });
    expect(doc.entities[1].points).toEqual([
      [0, 0],
      [2, 0],
      [2, 1],
    ]);
    expect(doc.entities[2].text).toBe('T-1 H=4.0');
    expect(doc.entities[3].block).toBe('B');
  });
});

describe('the change demo plot plan', () => {
  it('holds the later date: three tanks, four outlines, the pipe, valves and control points', () => {
    const doc = parseDxf(plotPlanDxf());
    expect(doc.header.$INSUNITS[70]).toBe(6);
    expect(doc.layers).toEqual(PLAN_LAYERS.map((l) => l.name));
    expect(count(doc, 'CIRCLE')).toBe(3);
    expect(count(doc, 'POLYLINE')).toBe(4);
    expect(count(doc, 'LINE')).toBe(1);
    expect(count(doc, 'INSERT')).toBe(3);
    expect(count(doc, 'POINT')).toBe(4);
    expect(Object.keys(doc.blocks).sort()).toEqual(['NORTH', 'VALVE']);
    const t = TANKS[0];
    const c = doc.entities.find((e) => e.type === 'CIRCLE');
    expect([c[10], c[20], c[40]]).toEqual([...toDrawing(t.cx, t.cz), t.R]);
    const tags = doc.entities.filter((e) => e.layer === 'TAGS').map((e) => e.text);
    expect(tags).toEqual(
      expect.arrayContaining(['T-201', 'T-202', 'T-203', 'B-01', 'S-01', 'SK-01', 'C-02']),
    );
    expect(tags).not.toContain('C-01');
    const points = doc.entities.filter((e) => e.type === 'POINT').map((e) => [e[10], e[20]]);
    expect(points).toEqual(CONTROL.map((k) => k.drawing));
    expect(
      plotPlan()
        .parts.map((p) => p.kind)
        .sort(),
    ).toEqual(['box', 'box', 'cylinder', 'cylinder', 'cylinder', 'extrusion', 'extrusion', 'pipe']);
  });

  it('has a unitless twin in millimetres and a broken twin', () => {
    const doc = parseDxf(unitlessDxf());
    expect(doc.header.$INSUNITS).toBeUndefined();
    expect(doc.entities.find((e) => e.type === 'CIRCLE')[40]).toBe(TANKS[0].R * 1000);
    expect(() => parseDxf(brokenDxf())).toThrow(/group code|EOF/);
  });

  it('is the same text every time, with no machine detail', () => {
    expect(plotPlanDxf()).toBe(plotPlanDxf());
    expect(plotPlanDxf()).not.toMatch(/Users|Temp|[A-Z]:\\/);
  });

  it('renders a plan raster with the tanks drawn where the grid says', async () => {
    const r = planRaster();
    const img = await sharp(r.png).raw().toBuffer({ resolveWithObject: true });
    expect(img.info.width).toBe(768);
    const t = TANKS[0];
    const [X, Y] = toDrawing(t.cx + t.R, t.cz);
    const i = Math.floor((X - r.origin[0]) / r.px);
    const j = Math.floor((r.origin[1] - Y) / r.px);
    const ink = (ii, jj) => img.data[(jj * img.info.width + ii) * img.info.channels] === 0;
    expect(ink(i, j) || ink(i - 1, j) || ink(i, j - 1)).toBe(true);
    expect(ink(5, 5)).toBe(false);
  });
});
