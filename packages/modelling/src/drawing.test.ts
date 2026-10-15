import type { Layer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  drawingsOf,
  drawingToLocal,
  dxfStemOf,
  findDrawing,
  isDrawingPlan,
  pictureOwnsStem,
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
      source: 'dxf',
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

  it('reads a parts file of an older build (aio.procmodel/1) as the current model', () => {
    const parts = readDrawingParts({
      schema: 'aio.procmodel/1',
      id: 'plan',
      name: 'plan.dxf',
      createdAt: '2026-10-06T08:00:00Z',
      updatedAt: '2026-10-06T08:00:00Z',
      sources: [{ kind: 'drawing', ref: 'drawings/plan.dxf' }],
      parts: [],
    });
    expect(parts).toMatchObject({ schema: 'aio.procmodel/2', materials: [], assemblies: [] });
  });
});

describe('drawings from pictures and PDF pages', () => {
  const sheet: Layer = {
    ...plan('layout-p2', 'x'),
    id: 'sheet-layout-p2',
    name: 'layout.pdf, page 2',
  };

  it('are drawings too, told apart from DXF drawings by their layer id', () => {
    const list = drawingsOf({ layers: [plan('plot', 'plot.dxf'), sheet] });
    expect(list.map((d) => [d.stem, d.source, d.name])).toEqual([
      ['layout-p2', 'image', 'layout.pdf, page 2'],
      ['plot', 'dxf', 'plot.dxf'],
    ]);
    expect(isDrawingPlan(sheet)).toBe(true);
  });
});

describe('a DXF and a picture drawing of one name', () => {
  const sheet = (stem: string): Layer => ({ ...plan(stem, 'x'), id: `sheet-${stem}`, name: stem });

  it('names the folder a DXF import files under, as the pipeline does', () => {
    expect(dxfStemOf('C:\\in\\Plot Plan (rev 2).dxf')).toBe('Plot-Plan-rev-2');
    expect(dxfStemOf('/in/site.DXF')).toBe('site');
    expect(dxfStemOf('_.dxf')).toBe('drawing');
  });

  it('knows when a picture drawing has that folder, whatever the case, pages included', () => {
    const list = drawingsOf({
      layers: [plan('plot', 'plot.dxf'), sheet('site'), sheet('ga-p2')],
    });
    expect(pictureOwnsStem(list, 'Site')).toBe(true);
    expect(pictureOwnsStem(list, 'GA')).toBe(true);
    // a DXF's own folder is the DXF's to import again
    expect(pictureOwnsStem(list, 'plot')).toBe(false);
    expect(pictureOwnsStem(list, 'other')).toBe(false);
  });
});
