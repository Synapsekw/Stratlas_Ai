// @vitest-environment jsdom
import type { AntennasFile, AntennaUnit, Vec3 } from '@aio/schema';
import type { Group } from 'three';
import {
  LineBasicMaterial,
  LineDashedMaterial,
  PerspectiveCamera,
  type LineSegments,
  type Mesh,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { frameOf } from '../survey/measureScene';
import {
  buildAntennaGroup,
  KIND_COLOURS,
  pickAntennaAt,
  type AntennaSceneState,
} from './antennaScene';

vi.mock('../shell', () => ({ bridge: { call: () => Promise.resolve({ ok: false }) }, jobs: {} }));

const frame = frameOf({ crs: {}, origin: [1000, 2000, 50] } as never);

const val = (value: number) => ({
  value,
  basis: 'measured' as const,
  quality: { basis: 'measured' as const },
});

function unit(
  id: string,
  kind: AntennaUnit['kind'],
  status: AntennaUnit['status'],
  centre: Vec3,
  azimuth?: number,
): AntennaUnit {
  return {
    id,
    name: id,
    kind,
    kindBasis: 'geometry',
    status,
    // across = east, up = project Z, outward = south (a right-handed set in E, N, Z)
    box: {
      centre,
      axes: [
        [1, 0, 0],
        [0, 0, 1],
        [0, -1, 0],
      ],
      extents: [0.3, 1.2, 0.15],
    },
    support: 100,
    ...(azimuth === undefined ? {} : { azimuthGridDeg: val(azimuth) }),
    widthM: val(0.3),
    heightM: val(1.2),
    depthM: val(0.15),
    convergenceDeg: null,
    photos: [],
    user: {},
    runId: 'run-a',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const file = (units: AntennaUnit[]) => ({ schema: 'aio.antennas/1', units }) as AntennasFile;

const units = [
  unit('ant-acc', 'panel', 'accepted', [1003, 2004, 60], 90),
  unit('ant-draft', 'short', 'draft', [1010, 2004, 60], 0),
  unit('ant-rej', 'dish', 'rejected', [1020, 2004, 60], 180),
  unit('ant-oth', 'other', 'accepted', [1030, 2004, 60]),
  unit('ant-hid', 'panel', 'accepted', [1040, 2004, 60], 10),
];
const state = (over: Partial<AntennaSceneState> = {}): AntennaSceneState => ({
  file: file(units),
  selected: null,
  hidden: { 'ant-hid': true },
  ...over,
});
const named = (g: Group, name: string) => g.getObjectByName(name) as LineSegments | undefined;
const outline = (g: Group, id: string): LineSegments => {
  const o = named(g, `antenna-outline:${id}`);
  if (!o) throw new Error(`no outline for ${id}`);
  return o;
};
/** Centre and tip of a unit's facing arrow (vertices 0 and 1). */
const arrow = (g: Group, id: string): { c: Vec3; tip: Vec3 } => {
  const pos = named(g, `antenna-facing:${id}`)?.geometry.getAttribute('position');
  if (!pos) throw new Error(`no arrow for ${id}`);
  return {
    c: [pos.getX(0), pos.getY(0), pos.getZ(0)],
    tip: [pos.getX(1), pos.getY(1), pos.getZ(1)],
  };
};

describe('antenna scene', () => {
  it('builds one box per visible unit with its id', () => {
    const g = buildAntennaGroup(state(), frame);
    expect(g.name).toBe('aio-telecom-antennas');
    expect(g.renderOrder).toBe(41);
    const boxes = g.children.filter((c) => c.userData.antennaId !== undefined && c.type === 'Mesh');
    expect(boxes.map((b) => b.userData.antennaId as string).sort()).toEqual([
      'ant-acc',
      'ant-draft',
      'ant-oth',
      'ant-rej',
    ]);
    const box = boxes.find((b) => b.userData.antennaId === 'ant-acc') as Mesh;
    const mat = box.material as LineBasicMaterial;
    expect(mat.opacity).toBeCloseTo(0.18);
    expect(mat.depthWrite).toBe(false);
    expect(mat.color.getHexString()).toBe(KIND_COLOURS.panel.slice(1));
    // project (1003, 2004, 60) with origin (1000, 2000, 50): x 3, y 10, z -4
    expect([box.position.x, box.position.y, box.position.z]).toEqual([3, 10, -4]);
  });

  it('draws status by outline style', () => {
    const g = buildAntennaGroup(state(), frame);
    const acc = outline(g, 'ant-acc').material;
    expect(acc).toBeInstanceOf(LineBasicMaterial);
    expect(acc).not.toBeInstanceOf(LineDashedMaterial);
    const draft = outline(g, 'ant-draft').material as LineDashedMaterial;
    expect(draft).toBeInstanceOf(LineDashedMaterial);
    expect(draft.dashSize).toBeCloseTo(0.08);
    expect(draft.gapSize).toBeCloseTo(0.05);
    const rej = outline(g, 'ant-rej').material as LineDashedMaterial;
    expect(rej).toBeInstanceOf(LineDashedMaterial);
    expect(rej.dashSize).toBeCloseTo(0.02);
    expect(rej.gapSize).toBeCloseTo(0.04);
    expect(rej.opacity).toBeCloseTo(0.35);
    expect(rej.transparent).toBe(true);
  });

  it('adds a facing arrow only to units with an azimuth', () => {
    const g = buildAntennaGroup(state(), frame);
    expect(named(g, 'antenna-facing:ant-acc')).toBeDefined();
    expect(named(g, 'antenna-facing:ant-draft')).toBeDefined();
    expect(named(g, 'antenna-facing:ant-oth')).toBeUndefined();
    expect(named(g, 'antenna-facing:ant-hid')).toBeUndefined();
  });

  it('points the arrow east for azimuth 90 and north for azimuth 0', () => {
    const g = buildAntennaGroup(state(), frame);
    // vertex 0 is the centre, vertex 1 the tip; length = clamp(1.2 m, 0.5, 5)
    const east = arrow(g, 'ant-acc');
    expect(east.tip[0] - east.c[0]).toBeCloseTo(1.2, 5);
    expect(Math.abs(east.tip[2] - east.c[2])).toBeLessThan(1e-6);
    const north = arrow(g, 'ant-draft');
    // north is -z in the local frame
    expect(north.tip[2] - north.c[2]).toBeCloseTo(-1.2, 5);
    expect(Math.abs(north.tip[0] - north.c[0])).toBeLessThan(1e-6);
  });

  it('highlights the selected unit and no other', () => {
    expect(named(buildAntennaGroup(state(), frame), 'antenna-highlight')).toBeUndefined();
    const g = buildAntennaGroup(state({ selected: 'ant-draft' }), frame);
    const halos = g.children.filter((c) => c.name === 'antenna-highlight');
    expect(halos).toHaveLength(1);
    const halo = halos[0] as LineSegments;
    expect(halo.userData.antennaId).toBe('ant-draft');
    expect((halo.material as LineBasicMaterial).color.getHexString()).toBe('ffffff');
    expect(halo.position.x).toBeCloseTo(10);
  });

  it('picks the box under the cursor', () => {
    const g = buildAntennaGroup(state(), frame);
    // the first unit sits at local (3, 10, -4); look at it down -z from in front
    const cam = new PerspectiveCamera(50, 1, 0.1, 100);
    cam.position.set(3, 10, 8);
    cam.lookAt(3, 10, -4);
    expect(pickAntennaAt(g, cam, [0, 0])).toBe('ant-acc');
    expect(pickAntennaAt(g, cam, [0.9, 0.9])).toBeNull();
  });

  it('draws nothing without a file', () => {
    const g = buildAntennaGroup(state({ file: null }), frame);
    expect(g.children).toHaveLength(0);
  });
});
