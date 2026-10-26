import type { EngineStage } from '@aio/engine';
import {
  shiftEN,
  type Layer,
  type ProjectManifest,
  type VolumeBaseId,
  type VolumesFile,
} from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { ScenePile, SceneRequest } from '../model/compute';
import type { Raster } from '../model/dsm';
import { createVolumetricStore } from '../store';
import type { VolumeService } from '../worker/client';
import { VolumetricScene } from './controller';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const fc = (net: number) => ({ fill: net + 1, cut: 1, net });
const v4 = (n: number): Record<VolumeBaseId, ReturnType<typeof fc>> => ({
  tin: fc(n),
  plane: fc(n + 1),
  avg: fc(n + 2),
  low: fc(n + 3),
});
const ring: [number, number][] = [
  [0, 0],
  [20, 0],
  [20, -20],
  [0, -20],
];

function volumes(): VolumesFile {
  const ep = (captureId: string, node: string, n: number) => ({
    captureId,
    areaM2: 400,
    topM: 60,
    heightM: 8,
    node,
    ring,
    volumes: v4(n),
  });
  return {
    schema: 'aio.volumes/1',
    densityTPerM3: 1.6,
    deadbandM: 0.1,
    defaultBase: 'tin',
    bases: [{ id: 'tin', label: 'Triangulated toe' }],
    captures: [
      { epoch: 'e1', captureId: 's1', date: '2020-12-31', label: '31 Dec 2020' },
      { epoch: 'e2', captureId: 's2', date: '2021-01-10', label: '10 Jan 2021' },
    ],
    piles: [
      {
        id: 'P01',
        name: 'Pile 01',
        zoneRing: ring,
        change: fc(-5),
        epochs: { e1: ep('s1', 'P01_e1', 100), e2: ep('s2', 'P01_e2', 95) },
      },
    ],
    totals: {},
    pileChange: fc(5),
    siteChange: fc(5),
  };
}

const terrain = (id: string, name: string, epoch: string): Layer => ({
  kind: 'mesh',
  id,
  name,
  visible: true,
  src: { path: `${id}.glb` },
  transform: I,
  tags: [{ node: `P01_${epoch}`, tag: 'P01' }],
});

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'yard',
  name: 'Yard',
  crs: { epsg: 32639 },
  origin: [1000, 2000, 50],
  captures: [],
  layers: [
    terrain('terrain-2', 'Terrain 10 Jan 2021', 'e2'),
    terrain('terrain-1', 'Terrain 31 Dec 2020', 'e1'),
  ],
  severityModels: [],
  classCatalogues: [],
};

const raster = (): Raster => ({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) });

/** A loaded volumetric store over a fake worker. */
async function ready(
  s2Shift?: { eastM: number; northM: number },
  lineUpTurn?: { rotationDeg: number; scale: number; pivotE: number; pivotN: number },
) {
  const ws = createWorkspace();
  ws.getState().openProject({
    id: 'yard',
    root: 'E:/y',
    manifest: s2Shift
      ? {
          ...manifest,
          captures: [
            {
              id: 's2',
              label: '10 Jan 2021',
              date: '2021-01-10',
              lineUp: { ...s2Shift, with: 's1', at: '2026-10-16T08:00:00.000Z' },
              ...(lineUpTurn ? { lineUpTurn } : {}),
            },
          ],
        }
      : manifest,
  });
  const scene = vi.fn<(req: SceneRequest) => Promise<{ piles: ScenePile[] }>>((req) =>
    Promise.resolve({
      piles: req.piles.map((p) => ({
        id: p.id,
        body: null,
        toe: new Float64Array([1000, 2000, 50, 1010, 2000, 50, 1010, 1990, 50]),
        toeBase: null,
      })),
    }),
  );
  const reliefRaster = vi.fn<(epoch: string) => Promise<Raster>>(() => Promise.resolve(raster()));
  const changeRaster = vi.fn(() => Promise.resolve(raster()));
  const service = {
    scene,
    section: vi.fn(),
    changeRaster,
    reliefRaster,
    grid: vi.fn(() =>
      Promise.resolve({ w: 2, h: 2, res: 1, x0: 0, y1: 0, relief: [48, 62], extent: [45, 70] }),
    ),
    heights: vi.fn(() => Promise.resolve([])),
    dispose: vi.fn(),
  } as unknown as VolumeService;
  const store = createVolumetricStore({
    workspace: ws,
    readVolumes: () => Promise.resolve({ ok: true, volumes: volumes(), edits: null }),
    startService: () => service,
  });
  await store.getState().load();
  expect(store.getState().status).toBe('ready');
  expect(store.getState().epoch).toBe('e2');
  return { store, scene, reliefRaster, changeRaster, grid: service.grid };
}

/** What the controller needs of a stage: a real three.js scene with both terrains loaded. */
function fakeStage() {
  const scene = new Scene();
  for (const id of ['terrain-1', 'terrain-2']) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(6), 2));
    const root = new Group();
    root.name = `layer:${id}`;
    root.add(new Mesh(g, new MeshBasicMaterial()));
    scene.add(root);
  }
  const frames = new Set<() => void>();
  let labelMode = 'key';
  const stage = {
    scene,
    camera: new PerspectiveCamera(),
    clippingPlanes: [],
    requestRender: () => undefined,
    onFrame: (cb: () => void) => {
      frames.add(cb);
      return () => frames.delete(cb);
    },
    get labelMode() {
      return labelMode;
    },
    setLabelMode: (m: string) => {
      labelMode = m;
    },
  } as unknown as EngineStage;
  /** One rendered frame, then the worker's answers. */
  const frame = async () => {
    for (const f of [...frames]) f();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const drapes = () =>
    scene
      .getObjectByName('volumetric')
      ?.children.map((c) => c.name)
      .filter((n) => n.startsWith('drape:')) ?? [];
  return { stage, scene, frame, drapes };
}

async function settle(frame: () => Promise<void>) {
  for (let i = 0; i < 4; i++) await frame();
}

describe('VolumetricScene: one view of two', () => {
  it('drapes the elevation colours on the survey the store shows, as before', async () => {
    const { store, reliefRaster } = await ready();
    const { stage, frame, drapes } = fakeStage();
    const v = new VolumetricScene(stage, store);
    v.attach();
    store.getState().setSurface('elev');
    await settle(frame);
    expect(drapes()).toEqual(['drape:e2']);
    expect(reliefRaster.mock.calls.map((c) => c[0])).toEqual(['e2']);
    v.detach();
  });

  it('a view with its own survey drapes that survey and asks for its bodies', async () => {
    const { store, scene, reliefRaster } = await ready();
    const { stage, frame, drapes } = fakeStage();
    store.getState().setAllPilesVisible(true);
    const v = new VolumetricScene(stage, store);
    v.setEpoch('e1');
    v.attach();
    store.getState().setSurface('elev');
    await settle(frame);
    expect(store.getState().epoch).toBe('e2');
    expect(drapes()).toEqual(['drape:e1']);
    expect(reliefRaster.mock.calls.map((c) => c[0])).toEqual(['e1']);
    expect(scene.mock.calls.at(-1)?.[0]).toMatchObject({ epoch: 'e1', mode: 'inv' });
    // the view moves to another date: the drape follows
    v.setEpoch('e2');
    await settle(frame);
    expect(drapes()).toEqual(['drape:e2']);
    expect(scene.mock.calls.at(-1)?.[0]).toMatchObject({ epoch: 'e2' });
    // the main view without a date of its own goes back to the store's rule
    store.getState().setEpoch('e1');
    v.setEpoch(null);
    await settle(frame);
    expect(drapes()).toEqual(['drape:e1']);
    v.detach();
    expect(drapes()).toEqual([]);
  });

  it('a display view whose date has no volumes draws nothing of another date', async () => {
    const { store, scene, reliefRaster } = await ready();
    const { stage, scene: three, frame, drapes } = fakeStage();
    store.getState().setAllPilesVisible(true);
    store.getState().setSurface('elev');
    store.setState({
      section: {
        mode: 'done',
        points: [
          [1000, 2000],
          [1010, 2000],
        ],
        profile: null,
        busy: false,
        pair: null,
      },
    });
    // no setEpoch: the date this second view shows is not one of the volume surveys
    const v = new VolumetricScene(stage, store, () => true, { display: true });
    v.attach();
    await settle(frame);
    const group = () => three.getObjectByName('volumetric');
    expect(drapes()).toEqual([]);
    expect(group()?.visible).toBe(false);
    expect(scene).not.toHaveBeenCalled();
    expect(reliefRaster).not.toHaveBeenCalled();
    expect(v.drapeRefused).toBe(false);
    // its pane moves to a survey with volumes: it draws that survey
    v.setEpoch('e1');
    await settle(frame);
    expect(group()?.visible).toBe(true);
    expect(drapes()).toEqual(['drape:e1']);
    expect(scene.mock.calls.at(-1)?.[0]).toMatchObject({ epoch: 'e1' });
    // and away again: everything it drew goes
    const asked = scene.mock.calls.length;
    v.setEpoch(null);
    await settle(frame);
    expect(group()?.visible).toBe(false);
    expect(drapes()).toEqual([]);
    expect(scene.mock.calls.length).toBe(asked);
    v.detach();
  });

  it('cut and fill colours lie on the terrain of each view', async () => {
    const { store, scene } = await ready();
    const a = fakeStage();
    const b = fakeStage();
    store.getState().setAllPilesVisible(true);
    const main = new VolumetricScene(a.stage, store);
    main.setEpoch('e1');
    const second = new VolumetricScene(b.stage, store, () => true, { display: true });
    second.setEpoch('e2');
    main.attach();
    second.attach();
    store.getState().setSurface('change');
    await settle(a.frame);
    await settle(b.frame);
    expect(a.drapes()).toEqual(['drape:e1']);
    expect(b.drapes()).toEqual(['drape:e2']);
    const asked = scene.mock.calls.map((c) => `${c[0].mode}/${c[0].epoch}`);
    expect(asked).toContain('chg/e1');
    expect(asked).toContain('chg/e2');
    main.detach();
    second.detach();
  });

  it('moves an epoch ring with its date and leaves the zone ring', async () => {
    const { store, scene } = await ready({ eastM: 2, northM: -1 });
    const { stage, scene: three, frame } = fakeStage();
    store.getState().setAllPilesVisible(true);
    const v = new VolumetricScene(stage, store);
    v.attach();
    await settle(frame);
    const toe = () => {
      const line = three.getObjectByName('volumetric')?.getObjectByName('toe');
      return Array.from((line as Mesh).geometry.getAttribute('position').array.slice(0, 3));
    };
    // the lined-up date: its toe line sits 2 m east and 1 m south of where it was measured
    expect(store.getState().epoch).toBe('e2');
    expect(toe()).toEqual([2, 0.25, 1]);
    // the worker still measures the date's own ground
    expect(scene.mock.calls.at(-1)?.[0].piles[0]?.ring[0]).toEqual([1000, 2000]);
    // the date that did not move stays
    v.setEpoch('e1');
    await settle(frame);
    expect(toe()).toEqual([0, 0.25, 0]);
    // the zone ring (change) belongs to neither date
    store.getState().setSurface('change');
    await settle(frame);
    expect(toe()).toEqual([0, 0.25, 0]);
    v.setEpoch('e2');
    await settle(frame);
    expect(toe()).toEqual([0, 0.25, 0]);
    v.detach();
  });

  it('moves an epoch ring with the date turn (follows a 0.5 degree turn)', async () => {
    const turn = { rotationDeg: 0.5, scale: 1, pivotE: 1010, pivotN: 2000 };
    const { store } = await ready({ eastM: 2, northM: -1 }, turn);
    const { stage, scene: three, frame } = fakeStage();
    store.getState().setAllPilesVisible(true);
    const v = new VolumetricScene(stage, store);
    v.attach();
    await settle(frame);
    const line = three.getObjectByName('volumetric')?.getObjectByName('toe');
    const p = Array.from((line as Mesh).geometry.getAttribute('position').array.slice(0, 3));
    // the toe's first corner is measured at E 1000, N 2000
    const [E, N] = shiftEN([1000, 2000], store.getState().epochShift('e2'));
    expect(p[0]).toBeCloseTo(E - 1000, 4);
    expect(p[2]).toBeCloseTo(2000 - N, 4);
    // a turn, not just the shift: the plain shift would give z = 1
    expect(Math.abs((p[2] ?? 0) - 1)).toBeGreaterThan(0.05);
    v.detach();
  });

  it('drapes the picked surveys, from the engine difference once it comes', async () => {
    const { store, scene, changeRaster, grid } = await ready();
    const { stage, frame, drapes } = fakeStage();
    store.getState().setAllPilesVisible(true);
    const v = new VolumetricScene(stage, store);
    v.attach();
    store.getState().setSurface('change');
    await settle(frame);
    // previous to current: the survey heights colour it until the engine answers
    expect(changeRaster).toHaveBeenLastCalledWith('e1', 'e2');
    expect(drapes()).toEqual(['drape:e2']);
    const chg = scene.mock.calls.map((c) => c[0]).filter((r) => r.mode === 'chg');
    expect(chg.at(-1)).toMatchObject({ from: 'e1', to: 'e2' });
    const calls = changeRaster.mock.calls.length;
    const asked = vi.mocked(grid).mock.calls.length;
    store.getState().setChangeGrid({
      from: 'e1',
      to: 'e2',
      grid: { dz: new Float32Array([1, 1, 1, 1]), nx: 2, ny: 2, x0: 0, y0: -2, cellM: 1 },
    });
    await settle(frame);
    expect(vi.mocked(grid).mock.calls.length).toBeGreaterThan(asked);
    expect(changeRaster.mock.calls.length).toBe(calls);
    expect(drapes()).toEqual(['drape:e2']);
    v.detach();
  });

  it('a drape over the graphics memory budget is not built, and says so once', async () => {
    const { store, reliefRaster, changeRaster } = await ready();
    const { stage, frame, drapes } = fakeStage();
    const asked: number[] = [];
    const told: boolean[] = [];
    const v = new VolumetricScene(stage, store, () => true, {
      display: true,
      budget: (bytes) => {
        asked.push(bytes);
        return false;
      },
    });
    v.setEpoch('e1');
    v.onDrapeRefused((r) => told.push(r));
    v.attach();
    store.getState().setSurface('elev');
    await settle(frame);
    expect(drapes()).toEqual([]);
    expect(asked).toEqual([16]);
    expect(told).toEqual([true]);
    expect(v.drapeRefused).toBe(true);
    // not asked again while nothing changes
    await settle(frame);
    expect(reliefRaster).toHaveBeenCalledTimes(1);
    // another colouring is asked for again
    store.getState().setSurface('change');
    await settle(frame);
    expect(changeRaster).toHaveBeenCalledTimes(1);
    expect(drapes()).toEqual([]);
    // the photo needs no drape: nothing is refused any more
    store.getState().setSurface('photo');
    await settle(frame);
    expect(v.drapeRefused).toBe(false);
    expect(told.at(-1)).toBe(false);
    v.detach();
  });

  it('a restyle of a drape the view already holds is not refused for that memory', async () => {
    const { store, reliefRaster } = await ready();
    const { stage, scene: three, frame, drapes } = fakeStage();
    const asked: number[] = [];
    // room for one drape only: everything after the first is turned down
    const v = new VolumetricScene(stage, store, () => true, {
      display: true,
      budget: (bytes) => {
        asked.push(bytes);
        return asked.length === 1;
      },
    });
    v.setEpoch('e1');
    v.attach();
    store.getState().setSurface('elev');
    await settle(frame);
    expect(drapes()).toEqual(['drape:e1']);
    const first = three.getObjectByName('drape:e1')?.uuid;
    // another ramp: the new texture takes the place of the old one, no more memory than before
    store.getState().setElevation({ ramp: 'viridis' });
    await settle(frame);
    expect(reliefRaster).toHaveBeenCalledTimes(2);
    expect(asked).toEqual([16]);
    expect(drapes()).toEqual(['drape:e1']);
    expect(three.getObjectByName('drape:e1')?.uuid).not.toBe(first);
    expect(v.drapeRefused).toBe(false);
    v.detach();
  });

  it('a refused restyle takes the old colours away: the view shows what its legend says', async () => {
    const { store, reliefRaster } = await ready();
    const { stage, frame, drapes } = fakeStage();
    const asked: number[] = [];
    const told: boolean[] = [];
    const v = new VolumetricScene(stage, store, () => true, {
      display: true,
      budget: (bytes) => {
        asked.push(bytes);
        return asked.length === 1;
      },
    });
    v.setEpoch('e1');
    v.onDrapeRefused((r) => told.push(r));
    v.attach();
    store.getState().setSurface('elev');
    await settle(frame);
    expect(drapes()).toEqual(['drape:e1']);
    // the restyled relief is larger than the one held: only the extra is asked for, and refused
    reliefRaster.mockImplementation(() =>
      Promise.resolve({ width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) }),
    );
    store.getState().setElevation({ ramp: 'viridis' });
    await settle(frame);
    expect(asked).toEqual([16, 48]);
    expect(drapes()).toEqual([]);
    expect(v.drapeRefused).toBe(true);
    expect(told).toEqual([true]);
    v.detach();
  });
});

describe('VolumetricScene: piles read their volume measurements', () => {
  const tagsOf = (three: Scene, layer: string) =>
    three.getObjectByName(`layer:${layer}`)?.userData.aioTags as
      { tag: string; area?: string }[] | undefined;
  const withTags = (three: Scene) => {
    for (const [id, e] of [
      ['terrain-1', 'e1'],
      ['terrain-2', 'e2'],
    ] as const) {
      const root = three.getObjectByName(`layer:${id}`);
      if (root) root.userData.aioTags = [{ node: `P01_${e}`, tag: 'P01' }];
    }
  };

  it("labels a pile with its measurement's figure, never the kit's own", async () => {
    const { store } = await ready();
    const { stage, scene: three, frame } = fakeStage();
    withTags(three);
    const v = new VolumetricScene(stage, store);
    v.attach();
    store.getState().select('P01');
    await settle(frame);
    // no measurement yet: the name only (the kit's 95 m³ is never shown)
    expect(tagsOf(three, 'terrain-2')?.[0]?.area).toBeUndefined();
    store.getState().setPileFigures({ P01: { e2: { value: '1,234 m³', tonnes: '1,974 t' } } });
    await settle(frame);
    expect(tagsOf(three, 'terrain-2')?.[0]?.area).toBe('1,234 m³ · 1,974 t');
    // the same pile on a date its measurement has no result for: the name only
    expect(tagsOf(three, 'terrain-1')?.[0]?.area).toBeUndefined();
    v.detach();
  });

  it('draws no kit body for a pile its measurement draws, and keeps it while that is hidden', async () => {
    const { store, scene } = await ready();
    scene.mockImplementation((req: SceneRequest) =>
      Promise.resolve({
        piles: req.piles.map((p) => ({
          id: p.id,
          body: {
            nx: 2,
            ny: 2,
            cell: 1,
            e0: 1000,
            n0: 2000,
            ins: new Uint8Array([1, 1, 1, 1]),
            top: new Float32Array([52, 52, 52, 52]),
            bot: new Float32Array([50, 50, 50, 50]),
            tmax: 52,
            bmin: 50,
          },
          toe: new Float64Array([1000, 2000, 50, 1010, 2000, 50, 1010, 1990, 50]),
          toeBase: null,
        })),
      }),
    );
    const { stage, scene: three, frame } = fakeStage();
    const v = new VolumetricScene(stage, store);
    v.attach();
    store.getState().setAllPilesVisible(true);
    await settle(frame);
    const bodies = () => {
      let n = 0;
      three.getObjectByName('volumetric')?.traverse((o) => {
        if (o.name === 'body-top' || o.name === 'base-plate') n++;
      });
      return n;
    };
    expect(bodies()).toBeGreaterThan(0);
    // a measurement that is hidden or on another date: the kit body stays
    store.getState().setPileFigures({ P01: {} });
    await settle(frame);
    expect(bodies()).toBeGreaterThan(0);
    // the measurement drawn now: it stands for the pile
    store.getState().setMeasuredShown(['P01']);
    await settle(frame);
    expect(bodies()).toBe(0);
    store.getState().setMeasuredShown([]);
    await settle(frame);
    expect(bodies()).toBeGreaterThan(0);
    v.detach();
  });

  it('draws no kit toe line for a pile its measurement outlines', async () => {
    const { store } = await ready();
    const { stage, scene: three, frame } = fakeStage();
    const v = new VolumetricScene(stage, store);
    v.attach();
    store.getState().setAllPilesVisible(true);
    await settle(frame);
    const toes = () => {
      let n = 0;
      three.getObjectByName('volumetric')?.traverse((o) => {
        if (o.name === 'toe' || o.name === 'toe-selected') n++;
      });
      return n;
    };
    expect(toes()).toBe(1);
    store.getState().setPileFigures({ P01: {} });
    await settle(frame);
    expect(toes()).toBe(0);
    v.detach();
  });
});
