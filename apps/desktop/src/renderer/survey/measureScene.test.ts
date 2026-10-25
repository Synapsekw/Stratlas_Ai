// @vitest-environment jsdom
import type { EngineStage } from '@aio/engine';
import { emptyMeasurements, type SitePoint, type SurveyMeasurement } from '@aio/schema';
import { measurementReadout } from '@aio/survey';
import {
  Group,
  Mesh,
  type MeshBasicMaterial,
  Points,
  PerspectiveCamera,
  Scene,
  Vector3,
  type Object3D,
  type Line,
} from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapController } from '@aio/maps';
import { defaultSurveySettings } from '@aio/schema';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import {
  DEFAULT_BORDER_WIDTH,
  DEFAULT_FILL_OPACITY,
  DEFAULT_MEASURE_COLOUR,
} from './measureColours';
import { toWgs84 } from '@aio/geo';
import { workspace } from '@aio/workspace';
import type { ComparisonResult } from '@aio/schema';
import { stageShow } from '../workspace/StageShow';
import { timeline } from '../workspace/timeline';
import type { MapHeights } from './mapHeights';
import {
  attach3d,
  attachMap,
  CHANGE_COLOURS,
  frameOf,
  hitPick,
  labelText,
  snapProviders,
} from './measureScene';
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

// ---------------------------------------------------------------- stored style (W2)

const pad = (over: Partial<SurveyMeasurement> = {}): SurveyMeasurement => ({
  id: 'pad',
  family: 'polygon',
  tool: 'area',
  label: 'Pad',
  points: [
    [100, 200, 300],
    [110, 200, 300],
    [110, 210, 300],
    [100, 210, 300],
  ],
  items: [],
  results: [],
  scope: { kind: 'site' },
  createdAt: '2026-10-20T00:00:00Z',
  ...over,
});

/** A map that records the source data and the layers the measurements add. */
function fakeMap() {
  let data: { features: { properties: Record<string, unknown>; geometry: { type: string } }[] } = {
    features: [],
  };
  const layers = new Map<
    string,
    {
      type: string;
      filter?: unknown;
      paint?: Record<string, unknown>;
      layout?: Record<string, unknown>;
    }
  >();
  let added = false;
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  container.appendChild(canvas);
  document.body.appendChild(container);
  const map = {
    getCanvas: () => canvas,
    getContainer: () => container,
    project: () => ({ x: 0, y: 0 }),
    isStyleLoaded: () => true,
    getSource: (id: string) =>
      id === 'aio-survey' && added
        ? {
            setData: (d: typeof data) => {
              data = d;
            },
          }
        : undefined,
    addSource: (_id: string, src: { data: typeof data }) => {
      added = true;
      data = src.data;
    },
    getLayer: (id: string) => layers.get(id),
    addLayer: (l: { id: string; type: string; paint?: Record<string, unknown> }) => {
      layers.set(l.id, l);
    },
    removeLayer: (id: string) => layers.delete(id),
    removeSource: () => undefined,
    on: () => undefined,
    off: () => undefined,
    once: () => undefined,
  };
  return {
    ctl: { map } as unknown as MapController,
    container,
    /** The label chips over the map, as the person reads them. */
    chips: () => [...container.querySelectorAll<HTMLElement>('.sv-labels .sv-label')],
    features: () => data.features,
    layer: (type: string) => [...layers.values()].find((l) => l.type === type),
  };
}

function mapOf(...measurements: SurveyMeasurement[]) {
  measureStore.setState({ file: { schema: 'aio.measurements/1', measurements } });
  const fm = fakeMap();
  const detach = attachMap(fm.ctl, frameOf({ origin: [0, 0, 0], crs: { epsg: 32640 } }), () => 0, {
    display: true,
  });
  return { ...fm, detach };
}

it('map fill uses stored fill and opacity', () => {
  const m = mapOf(
    pad({ style: { color: '#ef476f', fill: '#06d6a0', fillOpacity: 0.4 } }),
    pad({ id: 'plain', label: 'Plain' }),
  );
  const fill = m.layer('fill');
  expect(fill?.paint?.['fill-color']).toEqual(['get', 'fill']);
  expect(fill?.paint?.['fill-opacity']).toEqual(['get', 'fillOpacity']);
  const poly = (id: string) =>
    m.features().find((f) => f.properties.id === id && f.geometry.type === 'Polygon')?.properties;
  expect(poly('pad')).toMatchObject({ fill: '#06d6a0', fillOpacity: 0.4, color: '#ef476f' });
  // no stored fill: the line colour at the default opacity
  expect(poly('plain')).toMatchObject({
    fill: DEFAULT_MEASURE_COLOUR,
    fillOpacity: DEFAULT_FILL_OPACITY,
  });
  expect(DEFAULT_FILL_OPACITY).toBe(0.18);
  m.detach();
});

it('map line width uses borderWidth', () => {
  const m = mapOf(pad({ style: { color: '#ef476f', borderWidth: 6 } }), pad({ id: 'plain' }));
  expect(m.layer('line')?.paint?.['line-width']).toEqual(['get', 'width']);
  const width = (id: string) =>
    m.features().find((f) => f.properties.id === id && f.geometry.type === 'Polygon')?.properties
      .width;
  expect(width('pad')).toBe(6);
  expect(width('plain')).toBe(2);
  m.detach();
});

it('map labels show the name and the primary value', () => {
  const m = mapOf(pad());
  const label = m.features().find((f) => f.properties.kind === 'label');
  expect(label?.geometry.type).toBe('Point');
  expect(label?.properties.label).toBe(labelText(pad(), defaultSurveySettings(), []));
  // the label point is not drawn as a vertex dot
  expect(m.layer('circle')?.filter).toEqual([
    'all',
    ['==', ['geometry-type'], 'Point'],
    ['!=', ['get', 'kind'], 'label'],
  ]);
  m.detach();
});

it('map labels are the 3D view’s label chips over the map, not a glyph layer (bug 4)', () => {
  const m = mapOf(pad());
  // a MapLibre symbol layer draws nothing without the glyph files, and drops colliding labels
  expect(m.layer('symbol')).toBeUndefined();
  expect(m.chips().map((el) => el.textContent)).toEqual([
    labelText(pad(), defaultSurveySettings(), []),
  ]);
  expect(m.chips()[0]?.style.display).toBe('');
  m.detach();
  expect(m.container.querySelector('.sv-labels')).toBeNull();
});

it('map labels follow a change of the site units', () => {
  const settings = defaultSurveySettings();
  measureStore.setState({ settings });
  const m = mapOf(pad());
  const label = () => m.features().find((f) => f.properties.kind === 'label')?.properties.label;
  expect(label()).toBe(labelText(pad(), settings, []));
  expect(label()).toMatch(/m²/);
  const feet = { ...settings, units: { ...settings.units, area: 'ft2' as const } };
  measureStore.setState({ settings: feet });
  expect(label()).toBe(labelText(pad(), feet, []));
  expect(label()).toMatch(/ft²/);
  m.detach();
  measureStore.setState({ settings });
});

it('3D polygon gets a fill mesh at the stored opacity', () => {
  const s = scene();
  measureStore.setState({
    file: {
      schema: 'aio.measurements/1',
      measurements: [pad({ style: { color: '#ef476f', fill: '#06d6a0', fillOpacity: 0.35 } })],
    },
  });
  const fill = s.stage.scene.getObjectByName('measure-fill:pad') as Mesh | undefined;
  expect(fill).toBeInstanceOf(Mesh);
  const mat = fill?.material as MeshBasicMaterial;
  expect(mat.opacity).toBeCloseTo(0.35);
  expect(mat.transparent).toBe(true);
  expect(`#${mat.color.getHexString()}`).toBe('#06d6a0');
  // two triangles for the four corners
  expect(fill?.geometry.index?.count ?? fill?.geometry.getAttribute('position').count).toBe(6);
  s.detach();
});

it('3D draws a fat line when the border is wider than 1, a thin one otherwise', () => {
  const s = scene();
  measureStore.setState({
    file: {
      schema: 'aio.measurements/1',
      measurements: [
        pad({ style: { color: '#ef476f', borderWidth: 4 } }),
        pad({ id: 'thin', style: { color: '#ef476f', borderWidth: 1 } }),
        pad({ id: 'plain' }),
      ],
    },
  });
  const outline = (id: string) =>
    s.stage.scene.getObjectsByProperty('name', `measure:${id}`).find((o) => !(o instanceof Points));
  expect(outline('pad')).toBeInstanceOf(Line2);
  expect((outline('pad') as Line2 | undefined)?.material.linewidth).toBe(4);
  expect(outline('thin')).not.toBeInstanceOf(Line2);
  // no stored width: the shared default (2), as the map and the panel use
  expect((outline('plain') as Line2 | undefined)?.material.linewidth).toBe(DEFAULT_BORDER_WIDTH);
  s.detach();
});

it('label is name and primary value', () => {
  const settings = defaultSurveySettings();
  expect(labelText(pad(), settings, [])).toBe('Pad · 100.00 m²');
  // with the property name shown, the value is named
  expect(
    labelText(pad({ style: { color: '#ef476f', showPropertyName: true } }), settings, []),
  ).toMatch(/^Pad · .+: 100\.00 m²$/);
});

// ---------------------------------------------------------------- map picks off the stage

/** A drawing map whose stage has nothing under a pick; `click(e, n)` clicks at that place. */
function drawingMap(heights: MapHeights) {
  const fm = fakeMap();
  const handlers = new Map<string, (e: unknown) => void>();
  const map = (fm.ctl as unknown as { map: Record<string, unknown> }).map;
  map.on = (type: string, fn: (e: unknown) => void) => {
    handlers.set(type, fn);
  };
  workspace.setState({
    project: {
      id: 'p',
      manifest: { origin: [0, 0, 51], crs: { epsg: 32640 }, captures: [], layers: [] },
    },
  } as unknown as Parameters<typeof workspace.setState>[0]);
  const detach = attachMap(
    fm.ctl,
    frameOf({ origin: [0, 0, 51], crs: { epsg: 32640 } }),
    () => null,
    { heights },
  );
  let x = 0;
  const click = (e: number, n: number) => {
    const ll = toWgs84([e, n, 0], 32640);
    x += 50;
    handlers.get('click')?.({
      lngLat: { lng: ll[0], lat: ll[1] },
      point: { x, y: 0 },
      originalEvent: new MouseEvent('click'),
      preventDefault: () => undefined,
    });
  };
  return {
    click,
    detach: () => {
      detach();
      workspace.setState({ project: null } as unknown as Parameters<typeof workspace.setState>[0]);
    },
  };
}

it('a map pick that misses the stage takes the cached surface height', () => {
  const m = drawingMap({ warm: () => Promise.resolve(), at: () => 77.5 });
  startTool('distance');
  m.click(500_000, 2_700_000);
  expect(measureStore.getState().draw?.points[0]?.[2]).toBe(77.5);
  m.detach();
});

it('with nothing cached it takes the previous vertex, then the origin height, never 0', () => {
  let surface: number | null = null;
  const m = drawingMap({ warm: () => Promise.resolve(), at: () => surface });
  startTool('distance');
  m.click(500_000, 2_700_000);
  surface = 60;
  m.click(500_010, 2_700_000);
  surface = null;
  m.click(500_020, 2_700_000);
  const pts = measureStore.getState().draw?.points ?? [];
  expect(pts.map((p) => p[2])).toEqual([51, 60, 60]);
  m.detach();
});

// ------------------------------------------ the date in focus and Show (volumetrics redesign C3)

const figure = (net: number, capture: string): ComparisonResult => ({
  item: 'i1',
  status: 'ok',
  cutM3: 0,
  fillM3: net,
  netM3: net,
  totalM3: net,
  areaM2: 100,
  areaCutM2: 0,
  areaFillM2: 0,
  areaUnchangedM2: 0,
  uncoveredM2: 0,
  fromLabel: 'Triangulated toe',
  toLabel: capture,
  toCapture: capture,
  deadbandM: 0,
  usedDeadband: false,
  cellM: 0.1,
  engine: 'ts',
  fingerprint: 'engine',
  computedAt: '2026-10-20T00:00:00.000Z',
});

const stockpile = (): SurveyMeasurement =>
  pad({
    id: 'pile',
    tool: 'volume',
    label: 'Pile 01',
    items: [{ id: 'i1', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
    results: [figure(1200, 'c2')],
    series: [figure(800, 'c1'), figure(1200, 'c2')],
  });

describe('piles follow the date in focus and the Show control', () => {
  beforeEach(() => {
    // the Volumes tab is up: its Show control applies
    stageShow.getState().setActive(true);
  });
  afterEach(() => {
    timeline.setState({ focus: null });
    stageShow.getState().reset();
    stageShow.getState().setActive(false);
    measureStore.setState({ settings: defaultSurveySettings() });
    workspace.setState({ project: null } as unknown as Parameters<typeof workspace.setState>[0]);
  });

  const polyOf = (m: ReturnType<typeof mapOf>, id: string) =>
    m.features().find((f) => f.properties.id === id && f.geometry.type === 'Polygon')?.properties;

  it('with the Volumes tab closed the overlays do not apply: the piles are all drawn', () => {
    stageShow.getState().setOutlines(false);
    stageShow.getState().setLabels(false);
    const m = mapOf(stockpile());
    stageShow.getState().setActive(false);
    expect(polyOf(m, 'pile')).toBeDefined();
    expect(m.features().some((f) => f.properties.kind === 'label')).toBe(true);
    stageShow.getState().setActive(true);
    expect(polyOf(m, 'pile')).toBeUndefined();
    m.detach();
  });

  it('Colour piles by Material draws the pile in its material colour on the Materials pane', () => {
    measureStore.setState({
      settings: {
        ...defaultSurveySettings(),
        materials: [{ id: 'sand', name: 'Sand', colour: '#c8a04b' }],
      },
    });
    const m = mapOf({ ...stockpile(), material: 'sand' }, pad());
    // on the other panes the pile keeps its own colour
    expect(polyOf(m, 'pile')).toMatchObject({ color: DEFAULT_MEASURE_COLOUR });
    stageShow.getState().setPane('materials');
    expect(polyOf(m, 'pile')).toMatchObject({ color: '#c8a04b', fill: '#c8a04b' });
    // a measurement that is not a pile keeps its colour
    expect(polyOf(m, 'pad')).toMatchObject({ color: DEFAULT_MEASURE_COLOUR });
    stageShow.getState().setColourBy('none');
    expect(polyOf(m, 'pile')).toMatchObject({ color: DEFAULT_MEASURE_COLOUR });
    stageShow.getState().setPane('inventory');
    m.detach();
  });

  it('Colour piles by Change draws a pile that grew in the fill colour, one that shrank in cut', () => {
    workspace.setState({
      project: {
        id: 'p',
        manifest: {
          origin: [0, 0, 0],
          crs: { epsg: 32640 },
          captures: [
            { id: 'c1', date: '2020-01-01' },
            { id: 'c2', date: '2020-02-01' },
          ],
          layers: [],
        },
      },
    } as unknown as Parameters<typeof workspace.setState>[0]);
    timeline.setState({ focus: 'c2' });
    const shrank: SurveyMeasurement = {
      ...stockpile(),
      id: 'shrank',
      results: [figure(300, 'c2')],
      series: [figure(900, 'c1'), figure(300, 'c2')],
    };
    const m = mapOf(stockpile(), shrank);
    stageShow.getState().setPane('materials');
    stageShow.getState().setColourBy('change');
    expect(polyOf(m, 'pile')?.color).toBe(CHANGE_COLOURS.fill);
    expect(polyOf(m, 'shrank')?.color).toBe(CHANGE_COLOURS.cut);
    // the first survey has nothing before it: no change, the default colour
    timeline.setState({ focus: 'c1' });
    expect(polyOf(m, 'pile')?.color).toBe(DEFAULT_MEASURE_COLOUR);
    stageShow.getState().setPane('inventory');
    m.detach();
  });

  it('a pile’s map label is its name only, on every date (bug 4)', () => {
    timeline.setState({ focus: 'c1' });
    const m = mapOf(stockpile(), pad());
    const text = () => m.chips().map((el) => el.textContent);
    expect(text()).toEqual(['Pile 01', labelText(pad(), defaultSurveySettings(), [])]);
    timeline.setState({ focus: 'c2' });
    expect(text()).toEqual(['Pile 01', labelText(pad(), defaultSurveySettings(), [])]);
    // Labels off takes the pile's chip away, not the other measurement's
    stageShow.getState().setLabels(false);
    expect(text()).toEqual([labelText(pad(), defaultSurveySettings(), [])]);
    m.detach();
  });

  it('Outlines off hides the pile outline on the map, its label stays; Labels off hides it', () => {
    const m = mapOf(stockpile(), pad());
    const of = (id: string, type: string) =>
      m.features().filter((f) => f.properties.id === id && f.geometry.type === type);
    stageShow.getState().setOutlines(false);
    expect(of('pile', 'Polygon')).toHaveLength(0);
    expect(of('pile', 'Point')).toHaveLength(1);
    // a measurement that is not a pile keeps its outline
    expect(of('pad', 'Polygon')).toHaveLength(1);
    stageShow.getState().setLabels(false);
    expect(of('pile', 'Point')).toHaveLength(0);
    expect(of('pad', 'Point')).toHaveLength(1);
    stageShow.getState().setOutlines(true);
    expect(of('pile', 'Polygon')).toHaveLength(1);
    m.detach();
  });

  it('Outlines and Labels off hide the pile in 3D, not other measurements', () => {
    const s = scene();
    measureStore.setState({
      file: { schema: 'aio.measurements/1', measurements: [stockpile(), pad()] },
    });
    expect(s.stage.scene.getObjectByName('measure:pile')).toBeDefined();
    stageShow.getState().setOutlines(false);
    expect(s.stage.scene.getObjectByName('measure:pile')).toBeUndefined();
    expect(s.stage.scene.getObjectByName('measure:pad')).toBeDefined();
    expect(document.querySelectorAll('.sv-label')).toHaveLength(2);
    stageShow.getState().setLabels(false);
    expect(document.querySelectorAll('.sv-label')).toHaveLength(1);
    s.detach();
  });
});

describe('3D pile labels keep apart (bug 5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('nudges the smaller pile label up when two piles share a place, the larger one stays', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const label = this.classList.contains('sv-label');
      const [w, h] = label ? [80, 20] : [400, 400];
      return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h } as DOMRect;
    });
    const s = scene();
    const local = frameOf({
      origin: [100, 200, 300],
      crs: { wkt: 'LOCAL_CS["Synthetic"]' },
    }).toLocal([105, 205, 300]);
    s.stage.camera.position.set(local[0], local[1], local[2] + 50);
    s.stage.camera.updateMatrixWorld();
    const small: SurveyMeasurement = {
      ...stockpile(),
      id: 'small',
      label: 'Pile 02',
      results: [figure(300, 'c2')],
      series: [figure(300, 'c2')],
    };
    measureStore.setState({
      file: { schema: 'aio.measurements/1', measurements: [small, stockpile()] },
    });
    s.render();
    const at = (id: string) => {
      const el = document.querySelector<HTMLElement>(`.sv-label[data-id="${id}"]`);
      const m = /translate\((-?\d+)px, (-?\d+)px\)/.exec(el?.style.transform ?? '');
      return { y: Number(m?.[2]), hidden: el?.style.visibility === 'hidden' };
    };
    expect(at('pile').hidden).toBe(false);
    expect(at('small').hidden).toBe(false);
    expect(at('pile').y - at('small').y).toBe(24);
    s.detach();
  });
});
