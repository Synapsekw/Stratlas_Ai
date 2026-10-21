// @vitest-environment jsdom
import type { EngineStage } from '@aio/engine';
import { emptyMeasurements, type SitePoint, type SurveyMeasurement } from '@aio/schema';
import { measurementReadout } from '@aio/survey';
import {
  Group,
  Mesh,
  Points,
  PerspectiveCamera,
  Scene,
  Vector3,
  type Object3D,
  type Line,
} from 'three';
import { beforeEach, expect, it, vi } from 'vitest';
import { attach3d, frameOf, hitPick, snapProviders } from './measureScene';
import {
  editEvent,
  flipAzimuth,
  measureStore,
  setMeasurementsHidden,
  startEditing,
  startTool,
} from './measureStore';

vi.mock('../shell', () => ({ bridge: { call: () => Promise.resolve({ ok: false }) }, jobs: {} }));
beforeEach(() => {
  measureStore.setState({
    file: emptyMeasurements(),
    tool: null,
    draw: null,
    editing: null,
    readOnly: false,
    focus: null,
    selected: [],
    autosave: false,
    measurementsVisible: true,
  });
});

function scene(epsg?: number, object: Object3D = new Mesh()) {
  let claim: (event: PointerEvent) => boolean = () => false;
  let frame: () => void = () => undefined;
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const point = new Vector3(0, 10, 0);
  const stage = {
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    renderer: { domElement: canvas },
    controls: { enabled: true },
    tool: 'select',
    setTool: vi.fn(),
    requestRender: vi.fn(),
    raycast: () => ({ object, point, distance: 1 }),
    raycastRay: () => null,
    onFrame: (fn: () => void) => {
      frame = fn;
      return () => undefined;
    },
    claimClicks: (fn: typeof claim) => {
      claim = fn;
      return () => undefined;
    },
  };
  stage.setTool.mockImplementation((tool: string) => {
    stage.tool = tool;
  });
  const detach = attach3d(
    stage as unknown as EngineStage,
    frameOf({
      origin: [100, 200, 300],
      crs: epsg === undefined ? { wkt: 'LOCAL_CS["Synthetic"]' } : { epsg },
    }),
  );
  return {
    stage,
    object,
    point,
    canvas,
    click: (x: number) => claim({ clientX: x, clientY: 1 } as PointerEvent),
    render: () => {
      frame();
    },
    detach: () => {
      detach();
      canvas.remove();
    },
  };
}

it('requires real geometry for telecom picks and preserves model height', () => {
  const s = scene();
  startTool('clearance');
  s.object.name = 'env:ground';
  s.click(10);
  expect(measureStore.getState().draw?.points).toHaveLength(0);
  s.object.name = 'model';
  s.click(20);
  s.point.y = 15;
  s.click(30);
  expect(measureStore.getState().file.measurements[0]?.points).toEqual([
    [100, 200, 310],
    [100, 200, 315],
  ]);
  s.detach();
});

it.each(['plan', 'ortho', 'dsm'])(
  'ignores flat %s raster plates even through a parent group',
  (role) => {
    const s = scene();
    const root = new Group();
    root.userData.aioRaster = true;
    root.userData.aioLayer = `raster-${role}`;
    root.add(s.object);
    startTool('clearance');
    s.click(10);
    expect(measureStore.getState().draw?.points).toHaveLength(0);
    expect(measureStore.getState().file.measurements).toHaveLength(0);
    s.detach();
  },
);

it.each([new Mesh(), new Points(), Object.assign(new Mesh(), { userData: { type: 'terrain' } })])(
  'keeps measured mesh, cloud and terrain heights',
  (object) => {
    const s = scene(undefined, object);
    startTool('clearance');
    s.click(10);
    s.point.y = 15;
    s.click(20);
    expect(measureStore.getState().file.measurements[0]?.points).toEqual([
      [100, 200, 310],
      [100, 200, 315],
    ]);
    s.detach();
  },
);

it('hitPick names the layer of a mesh hit as a model pick', () => {
  const root = new Group();
  root.userData.layerId = 'terrain-1';
  const child = new Group();
  const mesh = new Mesh();
  child.add(mesh);
  root.add(child);
  expect(hitPick(mesh)).toEqual({ layer: 'terrain-1', on: 'model' });
  root.userData.aioLayer = 'adapter-1';
  expect(hitPick(mesh)).toEqual({ layer: 'adapter-1', on: 'model' });
  expect(hitPick(new Mesh())).toEqual({ layer: null, on: 'model' });
  expect(hitPick(null)).toEqual({ layer: null, on: 'ground' });
});

it('hitPick calls a raster or the ground plane a ground pick', () => {
  const root = new Group();
  root.userData.aioRaster = true;
  root.userData.aioLayer = 'dsm-1';
  const plate = new Mesh();
  root.add(plate);
  expect(hitPick(plate)).toEqual({ layer: 'dsm-1', on: 'ground' });
  const plane = new Mesh();
  plane.name = 'env:ground';
  expect(hitPick(plane)).toEqual({ layer: null, on: 'ground' });
});

it('renders the facing arrow in local north and reverses it when flipped', () => {
  const s = scene();
  const m = {
    id: 'face',
    family: 'line' as const,
    tool: 'azimuth' as const,
    label: 'Face',
    points: [
      [100, 200, 300],
      [100, 200, 302],
      [102, 200, 300],
    ] as [number, number, number][],
    items: [],
    results: [],
    scope: { kind: 'site' as const },
    createdAt: '2026-10-16T00:00:00Z',
  };
  measureStore.setState({
    file: { schema: 'aio.measurements/1', measurements: [m] },
    selected: ['face'],
  });
  const arrow = () => s.stage.scene.getObjectByName('measure-facing:face') as Line | undefined;
  expect(arrow()).toBeDefined();
  const north = arrow()?.geometry.getAttribute('position');
  expect(north && north.getZ(1) - north.getZ(0)).toBeLessThan(0);
  flipAzimuth('face');
  const south = arrow()?.geometry.getAttribute('position');
  expect(south && south.getZ(1) - south.getZ(0)).toBeGreaterThan(0);
  expect(document.querySelector('.sv-label')?.textContent).toContain('180');
  s.detach();
});

it('ends the draft when another stage tool takes over', () => {
  const s = scene();
  startTool('clearance');
  s.click(10);
  expect(measureStore.getState().draw?.points).toHaveLength(1);
  s.stage.tool = 'measure';
  s.render();
  expect(measureStore.getState().draw).toBeNull();
  expect(measureStore.getState().tool).toBeNull();
  s.detach();
});

it.each([
  {
    tool: 'clearance' as const,
    points: [
      [100, 200, 300],
      [103, 200, 304],
    ] as SitePoint[],
    value: '5.00',
    meaning: undefined,
  },
  {
    tool: 'antenna-tilt' as const,
    points: [
      [100, 200, 300],
      [100, 200, 302],
    ] as SitePoint[],
    value: '0.00',
    meaning: 'from vertical',
  },
  {
    tool: 'azimuth' as const,
    points: [
      [100, 200, 300],
      [100, 200, 302],
      [102, 200, 300],
    ] as SitePoint[],
    value: '0.00',
    meaning: 'project north',
  },
])(
  'keeps $tool scene values compact with their necessary meaning',
  ({ tool, points, value, meaning }) => {
    const s = scene();
    const measurement: SurveyMeasurement = {
      id: 'compact',
      family: 'line',
      tool,
      label: 'Antenna 1',
      points,
      style: { color: '#ffd166', showPropertyName: true },
      items: [],
      results: [],
      scope: { kind: 'site' },
      createdAt: '2026-10-16T00:00:00Z',
    };
    measureStore.setState({ file: { schema: 'aio.measurements/1', measurements: [measurement] } });
    const text = document.querySelector('.sv-label')?.textContent ?? '';
    expect(text).toContain('Antenna 1');
    expect(text).toContain(value);
    if (meaning) expect(text).toContain(meaning);
    expect(text.length).toBeLessThan(45);
    const row = measurementReadout(measurement)[0];
    expect(row && text.includes(row.label)).toBe(false);
    s.detach();
  },
);

it('keeps invalid endpoint edits visible with helpful shared feedback', () => {
  const s = scene();
  startTool('antenna-tilt');
  s.click(10);
  s.point.y = 15;
  s.click(20);
  startEditing();
  editEvent({ type: 'set', vertex: 1, coords: { z: 310 } });
  const measurement = measureStore.getState().file.measurements[0];
  expect(measurement).toBeDefined();
  if (measurement) {
    const row = measurementReadout(measurement)[0];
    expect(row?.value).toBeNull();
    expect(row?.note).toContain('distinct');
    expect(document.querySelector('.sv-label')?.textContent).toContain('Invalid');
  }
  s.detach();
});

it('describes an EPSG azimuth with grid north in the scene', () => {
  const s = scene(32640);
  const measurement: SurveyMeasurement = {
    id: 'grid-face',
    family: 'line',
    tool: 'azimuth',
    label: 'Grid face',
    points: [
      [100, 200, 300],
      [100, 200, 302],
      [102, 200, 300],
    ],
    items: [],
    results: [],
    scope: { kind: 'site' },
    createdAt: '2026-10-16T00:00:00Z',
  };
  measureStore.setState({ file: { schema: 'aio.measurements/1', measurements: [measurement] } });
  const text = document.querySelector('.sv-label')?.textContent ?? '';
  expect(text).toContain('0.00');
  expect(text).toContain('grid north');
  expect(text).not.toContain('true north');
  s.detach();
});

it.each(['frame', 'click'])(
  'preserves the newly selected native tool during endpoint editing (%s)',
  (takeover) => {
    const s = scene();
    startTool('clearance');
    s.click(10);
    s.point.y = 15;
    s.click(20);
    startEditing();
    expect(measureStore.getState().editing).not.toBeNull();
    s.stage.tool = 'measure';
    if (takeover === 'frame') s.render();
    else s.click(30);
    expect(measureStore.getState().editing).toBeNull();
    expect(s.stage.tool).toBe('measure');
    s.detach();
  },
);

it('restores orbit controls when a native tool interrupts an endpoint drag', () => {
  const s = scene();
  s.stage.camera.position.set(0, 5, 10);
  s.stage.camera.lookAt(0, 0, 0);
  s.stage.camera.updateMatrixWorld();
  startTool('clearance');
  s.click(10);
  s.point.y = 15;
  s.click(20);
  startEditing();
  s.canvas.dispatchEvent(
    new MouseEvent('pointerdown', { button: 0, clientX: 0, clientY: 0, bubbles: true }),
  );
  expect(s.stage.controls.enabled).toBe(false);
  s.stage.tool = 'measure';
  s.render();
  expect(s.stage.controls.enabled).toBe(true);
  expect(s.stage.tool).toBe('measure');
  s.detach();
});

it('allows telecom navigation and activation keys through while canvas undo and cancel stay active', () => {
  const s = scene();
  const controls = document.createElement('section');
  controls.className = 'telecom-tools';
  const button = document.createElement('button');
  button.textContent = 'Cancel';
  controls.append(button);
  document.body.append(controls);
  try {
    startTool('azimuth');
    s.click(10);
    button.focus();
    const received: string[] = [];
    button.addEventListener('keydown', (e) => received.push(e.key));
    for (const key of ['Tab', 'Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(received).toEqual(['Tab', 'Enter', ' ']);
    expect(measureStore.getState().draw?.points).toHaveLength(1);
    const undo = new KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
    });
    s.canvas.dispatchEvent(undo);
    expect(undo.defaultPrevented).toBe(true);
    expect(measureStore.getState().draw?.points).toHaveLength(0);
    const cancel = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    s.canvas.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(measureStore.getState().draw).toBeNull();
  } finally {
    controls.remove();
    s.detach();
  }
});

it('removes saved geometry and labels from the scene when hidden, including ordinary distance', () => {
  const s = scene();
  const base: SurveyMeasurement = {
    id: 'distance',
    family: 'line',
    tool: 'distance',
    label: 'Distance',
    points: [
      [100, 200, 300],
      [103, 200, 304],
    ],
    items: [],
    results: [],
    scope: { kind: 'site' },
    createdAt: '2026-10-16T00:00:00Z',
  };
  measureStore.setState({
    file: {
      schema: 'aio.measurements/1',
      measurements: [base, { ...base, id: 'clearance', tool: 'clearance', label: 'Clearance' }],
    },
  });
  expect(s.stage.scene.getObjectByName('measure:distance')).toBeDefined();
  expect(document.querySelectorAll('.sv-label')).toHaveLength(2);
  expect(snapProviders(measureStore.getState())[0]?.vertices()).toHaveLength(4);
  setMeasurementsHidden(['distance', 'clearance'], true);
  expect(s.stage.scene.getObjectByName('measure:distance')).toBeUndefined();
  expect(s.stage.scene.getObjectByName('measure:clearance')).toBeUndefined();
  expect(document.querySelectorAll('.sv-label')).toHaveLength(0);
  expect(snapProviders(measureStore.getState())[0]?.vertices()).toHaveLength(0);
  expect(snapProviders(measureStore.getState())[0]?.segments()).toHaveLength(0);
  setMeasurementsHidden(['distance', 'clearance'], false);
  expect(s.stage.scene.getObjectByName('measure:distance')).toBeDefined();
  expect(document.querySelectorAll('.sv-label')).toHaveLength(2);
  s.detach();
});
