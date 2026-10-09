import { ComparisonItem, type DesignEntry } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { compareItem } from '../engine/compare';
import { projectResolver } from '../engine/resolver';
import {
  designLayerOptions,
  designRolesOf,
  missingRoles,
  resolvePreset,
  suggestLayer,
  validPicks,
} from './designRoles';
import { industrySet } from './industry';
import { itemsFromPresets, measurementFrom } from './model';

const E0 = 520000;
const N0 = 2750000;

/** An `aio.tin/1` file: a flat square at `z` over [E0, E0 + 100] by [N0, N0 + 100]. */
function flatTin(z: number): Uint8Array {
  const v = [
    [E0, N0, z],
    [E0 + 100, N0, z],
    [E0 + 100, N0 + 100, z],
    [E0, N0 + 100, z],
  ];
  const head = (at: number) => ({
    schema: 'aio.tin/1',
    crs: { epsg: 32639 },
    bounds: [E0, N0, z, E0 + 100, N0 + 100, z],
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

const layer = (id: string, name: string, kind = 'surface', archived = false) => ({
  id,
  name,
  kind,
  file: `${id}.tin`,
  counts: {},
  visible: true,
  archived,
  verticalOffsetM: 0,
});

/** A real project's design: its own ids, none of them `design/og` or `design/subgrade`. */
const DESIGNS = [
  {
    id: 'bulk-earthworks-rev-c',
    name: 'Bulk earthworks rev C',
    src: 'bulk.xml',
    sha256: 'a'.repeat(64),
    bytes: 1,
    format: 'landxml',
    units: 'm',
    calibrated: false,
    importedAt: '2026-10-01T00:00:00Z',
    layers: [
      layer('existing-2024', 'Existing ground survey 2024'),
      layer('sg-final', 'Subgrade'),
      layer('old-sg', 'Subgrade rev B', 'surface', true),
      layer('ctrl', 'Control line', 'alignment'),
    ],
  },
] as unknown as DesignEntry[];

const TINS: Record<string, Uint8Array> = {
  'survey/designs/bulk-earthworks-rev-c/existing-2024.tin': flatTin(10),
  'survey/designs/bulk-earthworks-rev-c/sg-final.tin': flatTin(12),
};

const resolve = projectResolver({
  surfaces: [],
  captures: [],
  designs: DESIGNS,
  fetchBytes: (p) => Promise.resolve(TINS[p] ?? null),
});

const RING = [
  [E0 + 10, N0 + 10],
  [E0 + 60, N0 + 10],
  [E0 + 60, N0 + 50],
  [E0 + 10, N0 + 50],
];

const template = () => {
  const t = industrySet('construction').find((x) => x.id === 'construction-og-to-subgrade');
  if (!t) throw new Error('no OG to subgrade template');
  return t;
};

describe('design layers a template leaves to pick', () => {
  it('lists the roles of a template once each, with their hints', () => {
    expect(designRolesOf(template()).map((r) => [r.role, r.hint])).toEqual([
      ['og', 'Original ground (OG)'],
      ['subgrade', 'Subgrade'],
    ]);
    const mining = industrySet('mining');
    for (const t of mining) expect(designRolesOf(t), t.id).toEqual([]);
  });

  it('applying a construction template to a project whose design has other ids asks for the layer instead of refusing', async () => {
    const t = template();
    // the old placeholder ids are refused on this project: the design is not there
    const placeholder = ComparisonItem.parse({
      id: 'old',
      from: { kind: 'design', design: 'design', layer: 'og' },
      to: { kind: 'design', design: 'design', layer: 'subgrade' },
      useDeadband: false,
    });
    expect((await compareItem(RING, placeholder, resolve)).status).toBe('refused');

    // now: the site has no pick yet, so the app asks for both roles (nothing is refused)
    expect(missingRoles(t, undefined, DESIGNS).map((r) => r.role)).toEqual(['og', 'subgrade']);
    const options = designLayerOptions(DESIGNS);
    expect(options.map((o) => o.layer)).toEqual(['existing-2024', 'sg-final']);
    // the hint preselects a layer named after the role; OG is the person's call here
    const [og, subgrade] = designRolesOf(t);
    if (!og || !subgrade) throw new Error('roles');
    expect(suggestLayer(subgrade, options)?.layer).toBe('sg-final');
    expect(suggestLayer(og, options)).toBeNull();
    // and a measurement drawn before the layers are picked holds no item naming a missing design
    const before = measurementFrom(t, {
      id: 'm-1',
      label: 'OG to subgrade 1',
      points: RING.map(([e = 0, n = 0]) => [e, n, 0] as [number, number, number]),
      scope: { kind: 'site' },
      createdAt: '2026-10-09T00:00:00Z',
    });
    expect(before.items).toEqual([]);

    // the person picks the layers: the item names them and computes (2 m over 50 by 40 m)
    const picks = {
      og: { design: 'bulk-earthworks-rev-c', layer: 'existing-2024' },
      subgrade: { design: 'bulk-earthworks-rev-c', layer: 'sg-final' },
    };
    expect(missingRoles(t, picks, DESIGNS)).toEqual([]);
    const m = measurementFrom(
      t,
      {
        id: 'm-2',
        label: 'OG to subgrade 2',
        points: RING.map(([e = 0, n = 0]) => [e, n, 0] as [number, number, number]),
        scope: { kind: 'site' },
        createdAt: '2026-10-09T00:00:00Z',
      },
      picks,
    );
    expect(m.items).toHaveLength(1);
    const item = m.items[0];
    if (!item) throw new Error('item');
    expect(item.from).toEqual({
      kind: 'design',
      design: 'bulk-earthworks-rev-c',
      layer: 'existing-2024',
    });
    const r = await compareItem(RING, item, resolve);
    expect(r.status).toBe('ok');
    expect(r.fillM3).toBeCloseTo(2 * 50 * 40, 6);
    expect(r.cutM3).toBeCloseTo(0, 9);
  });

  it('asks again for a picked layer that is gone, and keeps the ones that hold', () => {
    const picks = {
      og: { design: 'bulk-earthworks-rev-c', layer: 'existing-2024' },
      subgrade: { design: 'bulk-earthworks-rev-c', layer: 'old-sg' },
    };
    expect(validPicks(picks, DESIGNS)).toEqual({ og: picks.og });
    expect(missingRoles(template(), picks, DESIGNS).map((r) => r.role)).toEqual(['subgrade']);
    expect(missingRoles(template(), picks, []).map((r) => r.role)).toEqual(['og', 'subgrade']);
  });

  it('suggests the only design surface of a site, and nothing on a site without one', () => {
    const [og] = designRolesOf(template());
    if (!og) throw new Error('role');
    const one = designLayerOptions([
      { ...DESIGNS[0], layers: [layer('ground', 'Ground')] } as unknown as DesignEntry,
    ]);
    expect(suggestLayer(og, one)?.layer).toBe('ground');
    expect(suggestLayer(og, [])).toBeNull();
    const named = designLayerOptions([
      {
        ...DESIGNS[0],
        layers: [layer('a', 'Pad'), layer('b', 'Original ground'), layer('c', 'OG')],
      } as unknown as DesignEntry,
    ]);
    expect(suggestLayer(og, named)?.layer).toBe('b');
  });

  it('leaves out a preset whose role has no pick, and resolves the others', () => {
    const t = industrySet('construction').find((x) => x.id === 'construction-survey-to-subgrade');
    if (!t) throw new Error('template');
    expect(itemsFromPresets(t.comparisons)).toEqual([]);
    const p = t.comparisons[0];
    if (!p) throw new Error('preset');
    expect(resolvePreset(p)).toBeNull();
    expect(resolvePreset(p, { subgrade: { design: 'd', layer: 'l' } })?.to).toEqual({
      kind: 'design',
      design: 'd',
      layer: 'l',
    });
    const kept = industrySet('construction').find((x) => x.id === 'construction-area-progress');
    if (kept) expect(itemsFromPresets(kept.comparisons)).toHaveLength(kept.comparisons.length);
  });
});
