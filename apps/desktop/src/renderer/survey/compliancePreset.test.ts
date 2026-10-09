import type { DesignEntry, HeightTiles, MeasurementsFile, SurveyMeasurement } from '@aio/schema';
import { designComparisonItem } from '@aio/survey';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn(() => Promise.resolve({ ok: false, error: 'not in this test' }));
vi.mock('../shell', () => ({ bridge: { call }, jobs: { getState: () => ({}) } }));
vi.mock('../author', () => ({ authorName: () => '' }));

const { compareStore, compute, engineClient, setEnginePort, takeDesigns } =
  await import('./compareStore');
const { drawEvent, measureStore, stopTool } = await import('./measureStore');
const { applyDesignPreset, withFreeId, DRAW_PROMPT } = await import('./compliancePreset');
const { serveEngine } = await import('./engineServe');

const DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'schema',
  'src',
  '__fixtures__',
  'survey',
);
const cone = JSON.parse(
  readFileSync(join(DIR, 'tiles', 'cone', 'tiles.json'), 'utf8'),
) as HeightTiles;

const E0 = 302000;
const N0 = 2574000;

/** An `aio.tin/1` flat square at `z` over the cone's tiles (20 m a side). */
function flatTin(z: number): Uint8Array {
  const v = [
    [E0, N0, z],
    [E0 + 20, N0, z],
    [E0 + 20, N0 + 20, z],
    [E0, N0 + 20, z],
  ];
  const head = (at: number) => ({
    schema: 'aio.tin/1',
    crs: { epsg: 32631 },
    bounds: [E0, N0, z, E0 + 20, N0 + 20, z],
    vertexCount: 4,
    triangleCount: 2,
    verticesAt: at,
    trianglesAt: at + 96,
  });
  let at = 0;
  for (let k = 0; k < 3; k++) {
    const len = new TextEncoder().encode(JSON.stringify(head(at))).length;
    at = Math.ceil((4 + len) / 8) * 8;
  }
  const json = new TextEncoder().encode(JSON.stringify(head(at)));
  const out = new Uint8Array(at + 96 + 24);
  const view = new DataView(out.buffer);
  view.setUint32(0, json.length, true);
  out.set(json, 4);
  v.flat().forEach((x, i) => {
    view.setFloat64(at + 8 * i, x, true);
  });
  [0, 1, 2, 0, 2, 3].forEach((x, i) => {
    view.setUint32(at + 96 + 4 * i, x, true);
  });
  return out;
}

const design = (offset: number): DesignEntry => ({
  id: 'd1',
  name: 'Pad design',
  src: 'pad.xml',
  sha256: 'a'.repeat(64),
  bytes: 1,
  format: 'landxml',
  units: 'm',
  calibrated: false,
  importedAt: '2026-10-01T00:00:00.000Z',
  layers: [
    {
      id: 'pad',
      name: 'Pad',
      kind: 'surface',
      file: 'pad.tin',
      counts: { triangles: 2 },
      visible: true,
      archived: false,
      verticalOffsetM: offset,
    },
  ],
});

const ring = Array.from({ length: 24 }, (_, k): [number, number, number] => [
  302010 + 8 * Math.cos((2 * Math.PI * k) / 24),
  2574010 + 8 * Math.sin((2 * Math.PI * k) / 24),
  0,
]);
const pit: SurveyMeasurement = {
  id: 'm1',
  family: 'polygon',
  tool: 'volume',
  label: 'Pad area',
  scope: { kind: 'site' },
  points: ring,
  items: [],
  results: [],
  createdAt: '2026-10-01T00:00:00.000Z',
};

let ports: MessageChannel | null = null;

beforeEach(() => {
  ports = new MessageChannel();
  serveEngine(ports.port2, (url) => {
    if (url.endsWith('survey/designs/d1/pad.tin')) return Promise.resolve(flatTin(100));
    const m = /survey\/surfaces\/cone\/(.+)$/.exec(url);
    return Promise.resolve(
      m?.[1] ? new Uint8Array(readFileSync(join(DIR, 'tiles', 'cone', m[1]))) : null,
    );
  });
  setEnginePort(ports.port1);
  const surfaces = [{ ...cone, capture: 'c2' }];
  engineClient().setContext({
    base: 'aio://project/p1/',
    surfaces,
    captures: ['c1', 'c2'],
    designs: [design(0)],
    site: { verticalDatum: { kind: 'project' } },
  });
  compareStore.setState({
    projectId: 'p1',
    status: 'ready',
    surfaces,
    designs: [design(0)],
    captures: [
      { id: 'c1', label: 'One', date: '2026-01-01' },
      { id: 'c2', label: 'Two', date: '2026-02-01' },
    ],
    current: {},
    computed: {},
  });
  const file: MeasurementsFile = { schema: 'aio.measurements/1', measurements: [pit] };
  measureStore.setState({
    projectId: 'p1',
    status: 'ready',
    readOnly: false,
    file,
    savedText: JSON.stringify(file),
    focus: 'm1',
    selected: ['m1'],
    autosave: false,
    tool: null,
    draw: null,
  });
});

afterEach(() => {
  stopTool();
  setEnginePort(null);
  ports?.port1.close();
  ports?.port2.close();
  ports = null;
});

const opts = (toleranceM: number) => ({ id: 'cf-pad', design: 'd1', layer: 'pad', toleranceM });
const m1 = () => measureStore.getState().file.measurements.find((m) => m.id === 'm1');

describe('compliance presets', () => {
  it('give an item a free id on the measurement', () => {
    const item = designComparisonItem('cut-fill-to-design', opts(0.05));
    expect(withFreeId({ items: [] }, item).id).toBe('cf-pad');
    expect(withFreeId({ items: [item] }, item).id).toBe('cf-pad-2');
    expect(withFreeId({ items: [item, { ...item, id: 'cf-pad-2' }] }, item).id).toBe('cf-pad-3');
  });

  it('add Cut/Fill to design to the focused polygon, computed, with its in-tolerance share', async () => {
    const note = applyDesignPreset(
      designComparisonItem('cut-fill-to-design', opts(0)),
      'Cut/Fill to design',
    );
    expect(note).toContain('"Pad area"');
    expect(m1()?.items.map((i) => i.id)).toEqual(['cf-pad']);
    await vi.waitFor(() => {
      expect(m1()?.results).toHaveLength(1);
    });
    const r = m1()?.results[0];
    const share = compareStore.getState().computed.m1?.shares.find((s) => s.item === 'cf-pad');
    if (!r || !share) throw new Error('not computed');
    // from the cone survey to a flat design at its base: the cone is cut, the rest is on grade
    expect(r.cutM3).toBeGreaterThan(200);
    expect(r.fillM3).toBeLessThan(1e-9);
    // a zero tolerance bands exactly as the volumes: cut beyond it is the cut area, the rest in
    expect(share.toleranceM).toBe(0);
    expect(share.share.cutM2).toBeCloseTo(r.areaCutM2, 6);
    expect(share.share.fillM2).toBeCloseTo(r.areaFillM2, 6);
    expect(share.share.inToleranceM2).toBeCloseTo(r.areaUnchangedM2, 6);
    expect(share.share.share).toBeCloseTo(r.areaUnchangedM2 / r.areaM2, 6);
  });

  it("follow the design layer's vertical offset: 0.3 m lower adds area x 0.3 of cut", async () => {
    applyDesignPreset(designComparisonItem('cut-fill-to-design', opts(0.05)), 'x');
    await vi.waitFor(() => {
      expect(m1()?.results).toHaveLength(1);
    });
    const before = m1()?.results[0];
    takeDesigns({ designs: [design(-0.3)] });
    const r = await compute('m1');
    const after = r?.results[0];
    if (!before || !after) throw new Error('not computed');
    expect(after.toLabel).toContain('offset');
    expect(after.cutM3 - before.cutM3).toBeCloseTo(0.3 * after.areaM2, 3);
    // the whole area is now more than 50 mm above the design: none of it in tolerance
    const share = compareStore.getState().computed.m1?.shares[0]?.share;
    expect(share?.share).toBe(0);
  });

  it('Remaining to design leaves out what is within the tolerance', async () => {
    applyDesignPreset(designComparisonItem('remaining-to-design', opts(0.5)), 'x');
    await vi.waitFor(() => {
      expect(m1()?.results).toHaveLength(1);
    });
    const r = m1()?.results[0];
    expect(m1()?.items[0]).toMatchObject({ deadbandM: 0.5, useDeadband: true });
    expect(r?.usedDeadband).toBe(true);
    const share = compareStore.getState().computed.m1?.shares[0]?.share;
    if (!r || !share) throw new Error('not computed');
    // the cells within 0.5 m are the unchanged ones of the result
    expect(share.inToleranceM2).toBeCloseTo(r.areaUnchangedM2, 6);
  });

  it('with no polygon in focus, the person draws one and the item goes on it', () => {
    measureStore.setState({ focus: null, selected: [] });
    const item = designComparisonItem('remaining-to-design', opts(0.05));
    const note = applyDesignPreset(item, 'Remaining to design');
    expect(note).toContain('No polygon is selected');
    const tool = measureStore.getState().tool;
    expect(tool?.tool).toBe('volume');
    expect(tool?.prompt).toBe(DRAW_PROMPT);
    const env = { distanceUnit: 'm' as const };
    for (const [e, n] of [
      [302004, 2574004],
      [302016, 2574004],
      [302016, 2574016],
      [302004, 2574016],
    ] as const)
      drawEvent({ type: 'click', raw: [e, n, 100], screen: { x: e, y: n }, shift: false }, env);
    drawEvent({ type: 'finish' }, env);
    const s = measureStore.getState();
    // one shape only: the tool stops, the new polygon is in focus with the item
    expect(s.tool).toBeNull();
    const drawn = s.file.measurements.find((m) => m.id === s.focus);
    expect(drawn?.family).toBe('polygon');
    expect(drawn?.items).toEqual([item]);
  });

  it('change nothing in a read-only project', () => {
    measureStore.setState({ readOnly: true });
    const note = applyDesignPreset(designComparisonItem('cut-fill-to-design', opts(0.05)), 'x');
    expect(note).toMatch(/cannot be changed/);
    expect(m1()?.items).toEqual([]);
  });
});
