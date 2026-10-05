/** Small synthetic project for unit tests. No client data. */
import type { EngineStage } from '@aio/engine';
import type { Issue, ProjectManifest, Vec3 } from '@aio/schema';
import { createWorkspace, type Workspace } from '@aio/workspace';
import { Box3, BoxGeometry, Group, Mesh, PerspectiveCamera, Scene, Vector3 } from 'three';
import type { StoreApi } from 'zustand/vanilla';

export const T0 = Date.UTC(2023, 1, 21, 15, 11, 0);

export function fixtureManifest(): ProjectManifest {
  return {
    schema: 'aio.project/1',
    id: 'p1',
    name: 'Tank farm',
    customer: 'Acme',
    site: 'North',
    crs: { epsg: 32639 },
    origin: [0, 0, 0],
    captures: [],
    layers: [
      {
        kind: 'mesh',
        id: 'm1',
        name: 'Plant mesh',
        visible: true,
        src: { path: 'models/plant.glb' },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        tags: [{ node: 'tank_0002', tag: '20-T-0002' }],
      },
      {
        kind: 'pointcloud',
        id: 'pc1',
        name: 'Cloud',
        visible: false,
        src: { path: 'clouds/c.bin' },
        format: 'kit-packed',
      },
      {
        kind: 'video',
        id: 'v1',
        name: 'DJI_0789',
        visible: true,
        src: { path: 'video/DJI_0789.mp4' },
        flight: { src: { path: 'flights/DJI_0789.json' }, startUtcMs: T0 },
        lens: { model: 'pinhole', hfovDeg: 80, aspect: 1.7778 },
        offsetMs: 0,
      },
      {
        kind: 'video',
        id: 'v2',
        name: 'DJI_0790',
        visible: true,
        src: { path: 'video/DJI_0790.mp4' },
        flight: { src: { path: 'flights/DJI_0790.json' }, startUtcMs: T0 + 600_000 },
        lens: { model: 'pinhole', hfovDeg: 80, aspect: 1.7778 },
        offsetMs: 0,
      },
    ],
    severityModels: [
      {
        id: 'sev',
        name: 'Five levels',
        levels: [1, 2, 3, 4, 5].map((value) => ({
          value,
          label: `S${value}`,
          color: '#aabbcc',
          criteria: '',
        })),
        uncertain: { label: 'Uncertain', color: '#999999' },
      },
    ],
    classCatalogues: [
      {
        id: 'cat',
        name: 'Tanks',
        assetType: 'tank',
        classes: [
          { id: 'corrosion', label: 'Corrosion', color: '#aa0000', severityModel: 'sev' },
          { id: 'coating', label: 'Coating damage', color: '#00aa00', severityModel: 'sev' },
        ],
      },
    ],
  };
}

export function fixtureIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i1',
    code: 'D01',
    classId: 'corrosion',
    severityModelId: 'sev',
    severity: 4,
    status: 'reviewed',
    title: 'Roof corrosion',
    note: 'Near the vent',
    author: 'DR',
    createdAt: '2023-02-22T10:00:00Z',
    updatedAt: '2023-02-22T10:00:00Z',
    sightings: [{ on: 'mesh', layer: 'm1', geom: { type: 'spoint', p: [0, 70, 0], n: [0, 1, 0] } }],
    source: 'human',
    ...over,
  };
}

/**
 * A plant site like Al-Zour (UTM 39N origin, tagged tanks, a pump and the jetty, a photo, a
 * panorama, a clip, an issue) for the camera tools. No client data.
 */
export const SITE_ORIGIN: Vec3 = [245714, 3179542, 100];

/** Tag, area, centre (local) and size of each box in the fake plant model. */
export const SITE_NODES: [string, string, Vec3, Vec3][] = [
  ['20-T-0001', '20 · LNG tanks', [100, 25, -50], [80, 50, 80]],
  ['20-T-0002', '20 · LNG tanks', [200, 25, -50], [80, 50, 80]],
  ['20-T-0003', '20 · LNG tanks', [300, 25, -50], [80, 50, 80]],
  ['20-P-0003A', '20 · LNG tanks', [300, 2, 10], [3, 4, 3]],
  ['10-A-0004', '10 · Jetty & berths', [-400, 5, 300], [20, 10, 20]],
  ['10-B-11', '10 · Jetty & berths', [-420, 3, 340], [10, 6, 10]],
];

export const SITE_T0 = Date.UTC(2023, 1, 21, 10, 22, 0);

export function siteManifest(): ProjectManifest {
  return {
    schema: 'aio.project/1',
    id: 'site',
    name: 'Plant',
    crs: { epsg: 32639 },
    origin: SITE_ORIGIN,
    captures: [],
    layers: [
      {
        kind: 'mesh',
        id: 'plant',
        name: 'Plant model',
        visible: true,
        src: { path: 'models/plant.glb' },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        tags: SITE_NODES.map(([tag, area]) => ({ node: tag, tag, area })),
      },
      {
        kind: 'photos',
        id: 'photos',
        name: 'Drone photos',
        visible: true,
        items: [
          {
            id: 'DJI_0661',
            src: { path: 'photos/DJI_0661.jpg' },
            pos: [150, 80, 50],
            // looking straight down (camera -Z turned to world -Y)
            q: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
          },
        ],
      },
      {
        kind: 'panoramas',
        id: 'panos',
        name: 'Panoramas',
        visible: true,
        items: [
          {
            id: '100_0655',
            src: { path: 'panoramas/100_0655.jpg' },
            pos: [0, 120, 0],
            headingDeg: 90,
          },
        ],
      },
      {
        kind: 'video',
        id: 'clip-0658',
        name: 'Flight 1 · 13:22 · clip 1 of 3 (DJI_0658)',
        visible: true,
        src: { path: 'video/DJI_0658.mp4' },
        flight: { src: { path: 'flights/flight1.json' }, startUtcMs: SITE_T0 },
        lens: { model: 'pinhole', hfovDeg: 80, aspect: 1.7778 },
        offsetMs: 0,
      },
    ],
    severityModels: fixtureManifest().severityModels,
    classCatalogues: fixtureManifest().classCatalogues,
  };
}

/** Flight 1: east along x from 0 to 600 m at 100 m height over ten minutes, camera level. */
export function siteFlight() {
  return {
    schema: 'aio.flight/1',
    startUtcMs: SITE_T0,
    samples: Array.from({ length: 11 }, (_, i) => ({
      t: i * 60_000,
      pos: [i * 60, 100, 0],
      q: [0, 0, 0, 1],
    })),
  };
}

/**
 * A stand-in for the 3D stage: the plant boxes in a three.js scene, a camera, and the stage's
 * handling of camera requests (a point, a direction and a distance; an asset selection framed).
 */
export function fakeStage(ws: StoreApi<Workspace>) {
  const scene = new Scene();
  const root = new Group();
  root.userData.layerId = 'plant';
  for (const [tag, , c, size] of SITE_NODES) {
    const node = new Group();
    node.name = tag;
    node.userData.aioNode = true;
    const mesh = new Mesh(new BoxGeometry(...size));
    mesh.position.set(...c);
    node.add(mesh);
    root.add(node);
  }
  scene.add(root);
  scene.updateMatrixWorld(true);
  const camera = new PerspectiveCamera(40, 1.6, 0.1, 20000);
  const target = new Vector3(0, 0, 0);
  const place = (pos: Vector3, at: Vector3) => {
    camera.position.copy(pos);
    target.copy(at);
    camera.lookAt(target);
    camera.updateMatrixWorld();
  };
  place(new Vector3(600, 450, 600), new Vector3(0, 0, 0));
  ws.subscribe((s, prev) => {
    const req = s.camera;
    if (!req || req === prev.camera) return;
    const t = req.target;
    if (t.kind === 'point') {
      const dir = t.dir ? new Vector3(...t.dir) : camera.position.clone().sub(target);
      const d = t.distance ?? camera.position.distanceTo(target);
      const at = new Vector3(...t.p);
      place(at.clone().addScaledVector(dir.normalize(), d), at);
    }
    s.consumeCamera(req.seq);
  });
  const stage = {
    scene,
    camera,
    renderer: {},
    projectId: 'site',
    requestRender: () => undefined,
    setViewPreset: () => undefined,
    setTool: () => undefined,
    saveView: () => ({
      position: camera.position.toArray(),
      target: target.toArray(),
    }),
    contentBounds: () => new Box3().setFromObject(root),
    raycastRay: () => null,
  };
  return stage as unknown as EngineStage;
}

export function siteWorkspace() {
  const ws = createWorkspace();
  ws.getState().openProject({ id: 'site', root: 'E:/site', manifest: siteManifest() }, [
    fixtureIssue({
      id: 'f5',
      code: 'F05',
      title: 'Top plate corrosion',
      sightings: [
        { on: 'mesh', layer: 'plant', geom: { type: 'spoint', p: [298, 50, -52], n: [0, 1, 0] } },
        { on: 'mesh', layer: 'plant', geom: { type: 'spoint', p: [302, 50, -48], n: [0, 1, 0] } },
      ],
    }),
  ]);
  return ws;
}

export function fixtureWorkspace() {
  const ws = createWorkspace();
  ws.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, [
    fixtureIssue(),
    fixtureIssue({ id: 'i2', code: 'D02', severity: 2, status: 'draft', title: 'Paint' }),
    fixtureIssue({ id: 'i3', code: 'F01', classId: 'coating', severity: 5, status: 'closed' }),
  ]);
  return ws;
}
