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
import { beforeEach, expect, it, vi } from 'vitest';
import type { MapController } from '@aio/maps';
import { defaultSurveySettings } from '@aio/schema';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import {
  DEFAULT_BORDER_WIDTH,
  DEFAULT_FILL_OPACITY,
  DEFAULT_MEASURE_COLOUR,
} from './measureColours';
import { attach3d, attachMap, frameOf, labelText, snapProviders } from './measureScene';
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
  const canvas = document.createElement('canvas');
  const map = {
    getCanvas: () => canvas,
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
  expect(m.layer('symbol')?.layout?.['text-field']).toEqual(['get', 'label']);
  // the label point is not drawn as a vertex dot
  expect(m.layer('circle')?.filter).toEqual([
    'all',
    ['==', ['geometry-type'], 'Point'],
    ['!=', ['get', 'kind'], 'label'],
  ]);
  expect(m.layer('symbol')?.filter).toEqual(['==', ['get', 'kind'], 'label']);
  m.detach();
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
