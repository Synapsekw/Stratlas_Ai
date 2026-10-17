// @vitest-environment jsdom
import { ProjectManifest, type Layer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { placedPanos } from './PinMenu';

const panos = (id: string, capture: string): Layer => ({
  kind: 'panoramas',
  id,
  name: id,
  visible: true,
  capture,
  items: [
    { id: `${id}-a`, src: { path: `panoramas/${id}-a.jpg` }, pos: [10, 1.6, -20], headingDeg: 0 },
    { id: `${id}-loose`, src: { path: `panoramas/${id}-loose.jpg` }, headingDeg: 0 },
  ],
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
  layers: [panos('old', 'd1'), panos('new', 'd2')],
  severityModels: [],
  classCatalogues: [],
});

describe('placedPanos', () => {
  it("hit-tests 360s where they draw: moved by their date's line-up, unplaced ones skipped", () => {
    expect(placedPanos(m, new Set())).toEqual([
      { key: { kind: 'pano', layerId: 'old', itemId: 'old-a' }, pos: [10, 1.6, -20] },
      { key: { kind: 'pano', layerId: 'new', itemId: 'new-a' }, pos: [12, 1.6, -19] },
    ]);
  });

  it('skips hidden layers', () => {
    expect(placedPanos(m, new Set(['new'])).map((p) => p.key.layerId)).toEqual(['old']);
  });

  it('follows the shown layers as the plates do, not the saved visibility', () => {
    const saved = { ...m, layers: m.layers.map((l) => ({ ...l, visible: false })) };
    expect(placedPanos(saved, new Set()).map((p) => p.key.layerId)).toEqual(['old', 'new']);
  });
});
