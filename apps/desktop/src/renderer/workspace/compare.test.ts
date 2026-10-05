import { captureIndex } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { captureLabel, linkMaps, splitDates, volumeHints, type LinkableMap } from './compare';
import { fromLinked, placement, toLinked } from './rasterLink';

class FakeMap implements LinkableMap {
  center = { lng: 56.1, lat: 25.3 };
  zoom = 15;
  bearing = 0;
  pitch = 0;
  jumps = 0;
  private readonly moves = new Set<() => void>();
  on(_: 'move', l: () => void) {
    this.moves.add(l);
  }
  off(_: 'move', l: () => void) {
    this.moves.delete(l);
  }
  getCenter() {
    return this.center;
  }
  getZoom() {
    return this.zoom;
  }
  getBearing() {
    return this.bearing;
  }
  getPitch() {
    return this.pitch;
  }
  jumpTo(v: { center: [number, number]; zoom: number; bearing: number; pitch: number }) {
    this.jumps++;
    this.center = { lng: v.center[0], lat: v.center[1] };
    this.zoom = v.zoom;
    this.bearing = v.bearing;
    this.pitch = v.pitch;
    for (const l of [...this.moves]) l();
  }
  /** The person pans and zooms. */
  pan(lng: number, lat: number, zoom: number) {
    this.center = { lng, lat };
    this.zoom = zoom;
    for (const l of [...this.moves]) l();
  }
}

describe('linked maps', () => {
  it('opens the second map on the first map view and follows pans both ways', () => {
    const a = new FakeMap();
    const b = new FakeMap();
    b.center = { lng: 0, lat: 0 };
    const off = linkMaps(a, b);
    expect(b.center).toEqual(a.center);
    a.pan(56.2, 25.4, 17);
    expect(b.center).toEqual({ lng: 56.2, lat: 25.4 });
    expect(b.zoom).toBe(17);
    b.pan(56.3, 25.5, 16);
    expect(a.zoom).toBe(16);
    // no echo: each move copies once
    expect(a.jumps).toBe(1);
    expect(b.jumps).toBe(2);
    off();
    a.pan(1, 1, 3);
    expect(b.zoom).toBe(16);
  });
});

describe('ortho panes linked in the local frame', () => {
  const corners = {
    tl: [-245, 0.2, -272.5] as const,
    tr: [246.52, 0.2, -272.5] as const,
    bl: [-245, 0.2, 464.78] as const,
  };
  it('maps pixels to the local frame and back', () => {
    const p = placement({ width: 16384, height: 24576 }, corners);
    expect(p.space).toBe('geo');
    expect(p.toView(0, 0)).toEqual([-245, -272.5]);
    const [x, z] = p.toView(16384, 24576);
    expect(x).toBeCloseTo(246.52);
    expect(z).toBeCloseTo(464.78);
    const [px, py] = p.toPixel(0, 0);
    const back = p.toView(px, py);
    expect(back[0]).toBeCloseTo(0);
    expect(back[1]).toBeCloseTo(0);
  });

  it('carries a view between two rasters of different resolution over the same ground', () => {
    const fine = placement({ width: 16384, height: 24576 }, corners);
    const coarse = placement({ width: 4096, height: 6144 }, corners);
    const box = { width: 800, height: 600 };
    const v = { scale: 0.1, x: -300, y: -900 };
    const shared = toLinked(v, box, fine, 'left');
    const w = fromLinked(shared, box, coarse);
    if (!w) throw new Error('no view');
    // four times coarser pixels: four times the zoom, the same ground under the pane centre
    expect(w.scale).toBeCloseTo(0.4);
    const there = toLinked(w, box, coarse, 'right');
    expect(there.x).toBeCloseTo(shared.x);
    expect(there.z).toBeCloseTo(shared.z);
    expect(there.span).toBeCloseTo(shared.span);
  });

  it('links unplaced images by fraction and never mixes the two spaces', () => {
    const a = placement({ width: 1000, height: 500 });
    const b = placement({ width: 2000, height: 1000 }, corners);
    const shared = toLinked({ scale: 1, x: 0, y: 0 }, { width: 100, height: 100 }, a, 'l');
    expect(shared.space).toBe('image');
    expect(fromLinked(shared, { width: 100, height: 100 }, b)).toBeNull();
  });
});

describe('dates of a project for the split', () => {
  const manifest = {
    captures: [
      { id: 'b', label: 'Second', date: '2021-01-10' },
      { id: 'a', label: 'First', date: '2020-12-31' },
    ],
    layers: [
      {
        kind: 'raster' as const,
        id: 'ortho-2020-12-31',
        name: 'Ortho 31 Dec 2020',
        visible: true,
        role: 'ortho' as const,
        format: 'kit-pyramid' as const,
        src: { path: 'a' },
      },
      {
        kind: 'raster' as const,
        id: 'ortho-2021-01-10',
        name: 'Ortho 10 Jan 2021',
        visible: true,
        role: 'ortho' as const,
        format: 'kit-pyramid' as const,
        src: { path: 'b' },
      },
    ],
  };

  it('lists the dates oldest first and allows two 3D views above the Low tier', () => {
    const ix = captureIndex(manifest);
    expect(splitDates(ix, 'high')).toEqual({ captures: ['a', 'b'], twin3d: true });
    expect(splitDates(ix, 'low')).toEqual({ captures: ['a', 'b'], twin3d: false });
    expect(splitDates(captureIndex({ ...manifest, captures: [] }), 'high')).toBeUndefined();
    expect(splitDates(null, 'high')).toBeUndefined();
    expect(captureLabel(ix, 'a')).toBe('31 Dec 2020');
  });

  it('takes the survey layers and keys of a volumetric project', () => {
    const hints = volumeHints({
      file: {
        captures: [
          { epoch: 'e1', captureId: 'a', date: '2020-12-31', label: '31 Dec 2020' },
          { epoch: 'e2', captureId: 'b', date: '2021-01-10', label: '10 Jan 2021' },
        ],
      } as never,
      layers: {
        e1: { terrain: 't1', layers: ['t1', 'ortho-2020-12-31'] },
        e2: { terrain: 't2', layers: ['t2', 'ortho-2021-01-10'] },
      },
    });
    expect(hints).toEqual({
      epochs: { a: 'e1', b: 'e2' },
      layers: { a: ['t1', 'ortho-2020-12-31'], b: ['t2', 'ortho-2021-01-10'] },
    });
  });
});
