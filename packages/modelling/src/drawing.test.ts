import type { Layer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  drawingsOf,
  drawingToLocal,
  findDrawing,
  localToDrawing,
  parsePlacement,
  readDrawingParts,
} from './drawing';

const plan = (stem: string, name: string): Extract<Layer, { kind: 'raster' }> => ({
  kind: 'raster',
  id: `plan-${stem}`,
  name: `${name} plan`,
  visible: true,
  src: { path: `drawings/${stem}/plan.png` },
  role: 'plan',
  format: 'image',
  corners: { tl: [0, 0, 0], tr: [1, 0, 0], bl: [0, 0, 1] },
});

describe('imported drawings', () => {
  const layers: Layer[] = [
    plan('plot', 'plot.dxf'),
    { ...plan('x', 'scan'), src: { path: 'rasters/plan.png' } },
    plan('site-2', 'Site 2.dxf'),
  ];

  it('lists the plan layers the pipeline wrote, newest first', () => {
    const list = drawingsOf({ layers });
    expect(list.map((d) => d.stem)).toEqual(['site-2', 'plot']);
    expect(list[1]).toEqual({
      stem: 'plot',
      name: 'plot.dxf',
      planLayer: 'plan-plot',
      dxf: 'drawings/plot.dxf',
      plan: 'drawings/plot/plan.png',
      parts: 'drawings/plot/parts.procmodel.json',
      placement: 'drawings/plot/placement.json',
    });
    expect(findDrawing(list)?.stem).toBe('site-2');
    expect(findDrawing(list, 'PLOT')?.stem).toBe('plot');
    expect(findDrawing(list, 'plot')?.stem).toBe('plot');
    expect(findDrawing(list, 'none')).toBeUndefined();
  });

  it('maps drawing points to the local frame and back', () => {
    const r = (30 * Math.PI) / 180;
    const p = parsePlacement({
      schema: 'aio.drawingplacement/1',
      file: 'drawings/plot.dxf',
      units: 'mm',
      unitM: 0.001,
      // mm to m, turned 30 degrees, north (+dy) to -z
      matrix: [
        0.001 * Math.cos(r),
        -0.001 * Math.sin(r),
        -0.001 * Math.sin(r),
        -0.001 * Math.cos(r),
        100,
        -50,
      ],
      baseY: 2,
      provisional: false,
    });
    const local = drawingToLocal(p, [12_000, 5_000]);
    const back = localToDrawing(p, local);
    expect(back?.[0]).toBeCloseTo(12_000, 6);
    expect(back?.[1]).toBeCloseTo(5_000, 6);
    expect(localToDrawing({ ...p, matrix: [0, 0, 0, 0, 0, 0] }, [1, 1])).toBeNull();
  });

  it('refuses a placement or parts file it cannot read', () => {
    expect(() => parsePlacement({ schema: 'aio.drawingplacement/1' })).toThrow(
      /Import the drawing again/,
    );
    expect(() => readDrawingParts({ schema: 'x' })).toThrow(/Import it again/);
  });
});
