import { ProjectManifest, shiftLocal, type Layer, type Vec3 } from '@aio/schema';
import { dateShiftOf } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { toDraw, toStore } from './pinFrame';
import { drawnPins } from './pinModel';

const panos = (id: string, capture?: string): Layer => ({
  kind: 'panoramas',
  id,
  name: id,
  visible: true,
  items: [],
  ...(capture ? { capture } : {}),
});

const m = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32633 },
  origin: [0, 0, 0],
  captures: [
    { id: 'd1', label: 'First', date: '2026-01-10' },
    {
      id: 'd2',
      label: 'Second',
      date: '2026-02-10',
      lineUp: { eastM: 2, northM: -1, with: 'd1', at: '2026-10-16T08:00:00Z' },
    },
  ],
  layers: [panos('panos-1', 'd2'), panos('panos-0', 'd1'), panos('loose')],
  severityModels: [],
  classCatalogues: [],
});

describe('pinFrame', () => {
  it("draws a stored point of a lined-up date moved by that date's shift", () => {
    const s = dateShiftOf(m, 'panos-1');
    expect(s).toEqual({ eastM: 2, northM: -1 });
    const g: Vec3 = [10, 1, -20];
    expect(toDraw(g, m, 'panos-1')).toEqual(shiftLocal(g, s));
    expect(toDraw(g, m, 'panos-1')).toEqual([12, 1, -19]);
    expect(toStore(toDraw(g, m, 'panos-1'), m, 'panos-1')).toEqual(g);
  });

  it('stores a click at P on a lined-up date as P minus the shift, drawn back at P', () => {
    const p: Vec3 = [5, 0, 5];
    const stored = toStore(p, m, 'panos-1');
    expect(stored).toEqual([3, 0, 4]);
    expect(toDraw(stored, m, 'panos-1')).toEqual(p);
  });

  it('draws a pin placed on the shifted cloud where it was clicked', () => {
    const clicked: Vec3 = [5, 0, 5];
    const ground = toStore(clicked, m, 'panos-1');
    const pinned = ProjectManifest.parse({
      ...m,
      layers: m.layers.map((l) =>
        l.id === 'panos-1' && l.kind === 'panoramas'
          ? {
              ...l,
              items: [
                {
                  id: 'a',
                  src: { path: 'panoramas/a.jpg' },
                  pos: [ground[0], 1.6, ground[2]],
                  headingDeg: 0,
                  pin: { ground, eyeM: 1.6 },
                },
              ],
            }
          : l,
      ),
    });
    const [pin] = drawnPins(pinned, new Set());
    expect(pin?.ground).toEqual(clicked);
    expect(pin?.eye).toEqual([5, 1.6, 5]);
  });

  it('is the identity for a date without a shift and an undated layer', () => {
    for (const id of ['panos-0', 'loose', 'missing']) {
      expect(toDraw([1, 2, 3], m, id)).toEqual([1, 2, 3]);
      expect(toStore([1, 2, 3], m, id)).toEqual([1, 2, 3]);
    }
  });
});
