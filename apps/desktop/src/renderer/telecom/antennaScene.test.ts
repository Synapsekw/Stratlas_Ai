// @vitest-environment jsdom
import type { AntennasFile, AntennaUnit, Vec3 } from '@aio/schema';
import type { Group, MeshBasicMaterial } from 'three';
import {
  LineBasicMaterial,
  LineDashedMaterial,
  PerspectiveCamera,
  Scene,
  type LineSegments,
  type Mesh,
} from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { describe, expect, it, vi } from 'vitest';
import { frameOf } from '../survey/measureScene';
import { antennaMeasure } from './antennaMeasure';
import {
  antennaLabelSpots,
  antennaShift,
  attachAntennaLayer,
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

const accUnit = unit('ant-acc', 'panel', 'accepted', [1003, 2004, 60], 90);
const units = [
  accUnit,
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

  it('draws boxes and arrows where their survey date is drawn (its line-up shift)', () => {
    // stored in the date's own frame at (1003, 2004, 60); the date is lined up 2 m east, 1 m south
    const g = buildAntennaGroup(state({ shift: { eastM: 2, northM: -1 } }), frame);
    const box = g.getObjectByName('antenna-box:ant-acc') as Mesh;
    // x = 3 + 2 east, y = 10, z = -4 + 1 (south is +z)
    expect([box.position.x, box.position.y, box.position.z]).toEqual([5, 10, -3]);
    expect(outline(g, 'ant-acc').position.toArray()).toEqual([5, 10, -3]);
    const east = arrow(g, 'ant-acc');
    expect(east.c).toEqual([5, 10, -3]);
    expect(east.tip[0] - east.c[0]).toBeCloseTo(1.2, 5);
    // a pick at the drawn place finds it; the stored place is empty
    const cam = new PerspectiveCamera(50, 1, 0.1, 100);
    cam.position.set(5, 10, 9);
    cam.lookAt(5, 10, -3);
    expect(pickAntennaAt(g, cam, [0, 0])).toBe('ant-acc');
    cam.position.set(3, 10, 8);
    cam.lookAt(3, 10, -40);
    expect(pickAntennaAt(g, cam, [0, 0])).toBeNull();
    // no shift (or a null one) draws them where they are stored
    const plain = buildAntennaGroup(state({ shift: null }), frame);
    expect((plain.getObjectByName('antenna-box:ant-acc') as Mesh).position.toArray()).toEqual([
      3, 10, -4,
    ]);
  });

  it("takes the shift of the run's survey date from the manifest", () => {
    const lineUp = { eastM: 2, northM: -1, with: 'd1', at: '2026-10-17T00:00:00.000Z' };
    const manifest = {
      captures: [
        { id: 'd1', label: 'Survey', date: '2026-01-01' },
        { id: 'd2', label: 'Survey', date: '2026-05-01', lineUp },
      ],
      layers: [{ kind: 'pointcloud', id: 'cloud-b', name: 'Cloud', capture: 'd2' }],
    } as never;
    const run = (over: Record<string, unknown>) =>
      ({ ...file(units), run: { cloudLayer: 'cloud-b', ...over } }) as AntennasFile;
    expect(antennaShift(run({ captureId: 'd2' }), manifest)).toEqual({ eastM: 2, northM: -1 });
    expect(antennaShift(run({ captureId: 'd1' }), manifest)).toBeNull();
    // an older file without the capture id: the cloud layer's date
    expect(antennaShift(run({}), manifest)).toEqual({ eastM: 2, northM: -1 });
    expect(antennaShift(run({ cloudLayer: 'gone' }), manifest)).toBeNull();
    expect(antennaShift(null, manifest)).toBeNull();
    expect(antennaShift(run({ captureId: 'd2' }), null)).toBeNull();
  });

  it('draws nothing without a file', () => {
    const g = buildAntennaGroup(state({ file: null }), frame);
    expect(g.children).toHaveLength(0);
  });
});

describe('antenna review drawing', () => {
  it('draws a hidden unit while it is selected, with its halo', () => {
    const g = buildAntennaGroup(state({ selected: 'ant-hid' }), frame);
    expect(g.getObjectByName('antenna-box:ant-hid')).toBeDefined();
    expect(named(g, 'antenna-highlight')?.userData.antennaId).toBe('ant-hid');
    const off = buildAntennaGroup(state({ selected: null }), frame);
    expect(off.getObjectByName('antenna-box:ant-hid')).toBeUndefined();
    expect(named(off, 'antenna-highlight')).toBeUndefined();
  });

  it('draws only the soloed kind, and the selected unit', () => {
    const g = buildAntennaGroup(state({ solo: 'panel' }), frame);
    expect(g.getObjectByName('antenna-box:ant-draft')).toBeUndefined();
    expect(g.getObjectByName('antenna-box:ant-acc')).toBeDefined();
    expect(g.getObjectByName('antenna-box:ant-rej')).toBeUndefined();
    const sel = buildAntennaGroup(state({ solo: 'panel', selected: 'ant-draft' }), frame);
    expect(sel.getObjectByName('antenna-box:ant-draft')).toBeDefined();
  });

  it('draws the selected box stronger and over everything', () => {
    const g = buildAntennaGroup(state({ selected: 'ant-draft' }), frame);
    const box = g.getObjectByName('antenna-box:ant-draft') as Mesh;
    const mat = box.material as MeshBasicMaterial;
    expect(mat.opacity).toBe(0.35);
    expect(mat.depthTest).toBe(false);
    expect(box.renderOrder).toBe(43);
    const edges = g.getObjectByName('antenna-outline:ant-draft');
    expect(edges).toBeInstanceOf(LineSegments2);
    const lm = (edges as LineSegments2).material;
    expect(lm).toBeInstanceOf(LineMaterial);
    expect(lm.linewidth).toBe(3);
    expect(lm.depthTest).toBe(false);
    expect(lm.color.getHexString()).toBe(KIND_COLOURS.short.slice(1));
    // a draft stays dashed when selected
    expect(lm.dashed).toBe(true);
    expect(named(g, 'antenna-highlight')?.renderOrder).toBe(43);
    expect(named(g, 'antenna-facing:ant-draft')?.renderOrder).toBe(43);
    // others keep today's look
    const other = g.getObjectByName('antenna-box:ant-acc') as Mesh;
    expect((other.material as MeshBasicMaterial).opacity).toBeCloseTo(0.18);
    expect((other.material as MeshBasicMaterial).depthTest).toBe(true);
    expect(other.renderOrder).toBe(41);
    expect(outline(g, 'ant-acc')).not.toBeInstanceOf(LineSegments2);
  });

  it('draws dimension lines for the selected unit only', () => {
    const g = buildAntennaGroup(state({ selected: 'ant-acc' }), frame);
    const dims = g.children.filter((c) => c.name.startsWith('antenna-dim:'));
    expect(dims.map((c) => c.name)).toEqual(['antenna-dim:ant-acc']);
    const dim = dims[0] as LineSegments;
    const mat = dim.material as LineBasicMaterial;
    expect(mat.color.getHexString()).toBe('ffffff');
    expect(mat.depthTest).toBe(false);
    expect(dim.renderOrder).toBe(43);
    const segments = antennaMeasure(accUnit, frame, null).segments;
    expect(dim.geometry.getAttribute('position').count).toBe(segments.length * 2);
    expect(named(buildAntennaGroup(state(), frame), 'antenna-dim:ant-acc')).toBeUndefined();
  });

  it('places a name on every drawn unit and the measurements on the selected one', () => {
    const plain = antennaLabelSpots(state(), frame);
    expect(plain.map((s) => s.text).sort()).toEqual(['ant-acc', 'ant-draft', 'ant-oth', 'ant-rej']);
    expect(plain.every((s) => s.kind === 'name' && !s.selected)).toBe(true);

    const spots = antennaLabelSpots(state({ selected: 'ant-acc' }), frame);
    const measure = antennaMeasure(accUnit, frame, null).spots;
    expect(spots.filter((s) => s.selected)).toEqual(measure);
    expect(
      spots
        .filter((s) => !s.selected)
        .map((s) => s.text)
        .sort(),
    ).toEqual(['ant-draft', 'ant-oth', 'ant-rej']);
    expect(spots.filter((s) => s.kind === 'name')).toHaveLength(4);
    expect(new Set(spots.map((s) => s.key)).size).toBe(spots.length);
  });

  it('sizes the fat lines to the canvas, on build and on resize', () => {
    const canvas = document.createElement('canvas');
    let w = 800;
    let h = 600;
    Object.defineProperty(canvas, 'clientWidth', { get: () => w });
    Object.defineProperty(canvas, 'clientHeight', { get: () => h });
    const frames: (() => void)[] = [];
    let listeners = 0;
    let current: AntennaSceneState = state({ selected: 'ant-acc' });
    const subs: (() => void)[] = [];
    const scene = new Scene();
    const stage = {
      scene,
      camera: new PerspectiveCamera(),
      renderer: { domElement: canvas },
      requestRender: () => undefined,
      onFrame: (cb: () => void) => {
        frames.push(cb);
        listeners++;
        return () => {
          listeners--;
        };
      },
    } as never;
    const detach = attachAntennaLayer(stage, frame, {
      getState: () => current,
      subscribe: (cb) => {
        subs.push(cb);
        return () => undefined;
      },
      onPick: () => undefined,
    });
    const res = () =>
      (
        scene.getObjectByName('antenna-outline:ant-acc') as LineSegments2
      ).material.resolution.toArray();
    expect(res()).toEqual([800, 600]);
    w = 1024;
    h = 512;
    frames.forEach((f) => {
      f();
    });
    expect(res()).toEqual([1024, 512]);
    current = state({ selected: 'ant-acc', hidden: {} });
    subs.forEach((f) => {
      f();
    });
    expect(res()).toEqual([1024, 512]);
    detach();
    expect(listeners).toBe(0);
    expect(scene.getObjectByName('aio-telecom-antennas')).toBeUndefined();
  });
});
