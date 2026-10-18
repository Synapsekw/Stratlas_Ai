// @vitest-environment jsdom
import { issueAt } from '@aio/annotate';
import type { EngineStage } from '@aio/engine';
import { fromWgs84 } from '@aio/geo';
import type { MapController } from '@aio/maps';
import type { Layer, ProjectManifest, SitePoint, SurveyMeasurement } from '@aio/schema';
import { initialDraw, initialEdit } from '@aio/survey';
import { captureIndex, workspace } from '@aio/workspace';
import { OrthographicCamera } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimEvent, isClaimed } from '../builder/droneHits';
import { pinsAt } from '../pins/pinModel';
import { primaryScene } from '../workspace/compare';
import { frameOf } from './measureScene';
import {
  attachMeasurePick3d,
  attachMeasurePickMap,
  pickBlocked,
  type MeasureMenuAt,
} from './measurePick';
import { measureStore, setMeasurementsHidden } from './measureStore';

vi.mock('../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false }) },
  jobs: {},
  useShell: () => null,
  shell: { getState: () => ({}) },
}));
vi.mock('../builder/PhotoMenu', () => ({ CLICK_PX: 5, photosAt3d: vi.fn(() => null) }));
vi.mock('../builder/droneHits', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rigHit: vi.fn(() => null),
}));
vi.mock('../pins/PinMenu', () => ({ placedPanos: vi.fn(() => []) }));
vi.mock('../pins/pinModel', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pinsAt: vi.fn(() => null),
}));
vi.mock('@aio/annotate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  issueAt: vi.fn(() => null),
}));
vi.mock('@aio/engine', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  markersHit: vi.fn(() => false),
}));

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mesh = (id: string, capture: string): Layer => ({
  kind: 'mesh',
  id,
  name: id,
  visible: true,
  src: { path: `models/${id}.glb` },
  transform: I,
  capture,
});

/** June is lined up 20 m south of January. */
const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p1',
  name: 'Pick',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'jan', label: 'January', date: '2026-01-01' },
    {
      id: 'jun',
      label: 'June',
      date: '2026-06-01',
      lineUp: { eastM: 0, northM: -20, with: 'jan', at: '2026-10-16T08:00:00Z' },
    },
  ],
  layers: [mesh('model-jan', 'jan'), mesh('model-jun', 'jun')],
  severityModels: [],
  classCatalogues: [],
};

const line = (
  id: string,
  pts: SitePoint[],
  scope: SurveyMeasurement['scope'] = { kind: 'site' },
): SurveyMeasurement => ({
  id,
  family: 'line',
  tool: 'distance',
  label: id,
  scope,
  points: pts,
  items: [],
  results: [],
  createdAt: '2026-10-11T00:00:00Z',
});

/*
 * The camera looks straight down on a 1000 x 1000 px canvas, 1 px a metre: site (E, N) is on
 * screen at (500 + E, 500 - N).
 */
const at = (e: number, n: number) => ({ x: 500 + e, y: 500 - n });
const onShape = at(50, 0); // on m1, from (0, 0) to (100, 0)
const empty = at(-300, -300);

let claim: (e: PointerEvent) => boolean;
let canvas: HTMLCanvasElement;
let stage: { tool: string };
let onMenu: ReturnType<typeof vi.fn<(m: MeasureMenuAt) => void>>;
let detach: () => void;

beforeEach(() => {
  workspace.getState().openProject({ id: 'p1', root: 'E:/p', manifest });
  workspace.getState().setDates(captureIndex(manifest));
  measureStore.setState({
    tool: null,
    draw: null,
    editing: null,
    focus: null,
    selected: [],
    reveal: null,
    measurementsVisible: true,
    hiddenMeasurements: [],
    file: {
      schema: 'aio.measurements/1',
      measurements: [
        line('m1', [
          [0, 0, 0],
          [100, 0, 0],
        ]),
        line(
          's1',
          [
            [0, 100, 0],
            [100, 100, 0],
          ],
          { kind: 'survey', capture: 'jun' },
        ),
      ],
    },
  });
  canvas = document.body.appendChild(document.createElement('canvas'));
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1000, height: 1000, right: 1000, bottom: 1000 }) as DOMRect;
  const camera = new OrthographicCamera(-500, 500, 500, -500, 0.1, 1000);
  camera.position.set(0, 100, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  stage = { tool: 'select' };
  const fake = {
    get tool() {
      return stage.tool;
    },
    camera,
    renderer: { domElement: canvas },
    claimClicks: (fn: typeof claim) => {
      claim = fn;
      return () => undefined;
    },
  };
  onMenu = vi.fn<(m: MeasureMenuAt) => void>();
  detach = attachMeasurePick3d(fake as unknown as EngineStage, frameOf(manifest), onMenu);
});
afterEach(() => {
  detach();
  canvas.remove();
  vi.mocked(pinsAt).mockReturnValue(null);
  vi.mocked(issueAt).mockReturnValue(null);
});

const contextMenuAt = (p: { x: number; y: number }, before?: (e: MouseEvent) => void) => {
  const init = { clientX: p.x, clientY: p.y, button: 2, bubbles: true, cancelable: true };
  canvas.dispatchEvent(new MouseEvent('pointerdown', init));
  const e = new MouseEvent('contextmenu', init);
  before?.(e);
  canvas.dispatchEvent(e);
  return e;
};
const leftClickAt = (p: { x: number; y: number }) =>
  ({ clientX: p.x, clientY: p.y, button: 0, target: canvas }) as unknown as PointerEvent;

describe('measurement pick in 3D', () => {
  it('pickBlocked is any of tool, draw or editing', () => {
    expect(pickBlocked({ tool: null, draw: null, editing: null })).toBe(false);
    expect(pickBlocked({ tool: null, draw: initialDraw('line'), editing: null })).toBe(true);
  });

  it('right-click on a shape opens the menu and claims the event', () => {
    const e = contextMenuAt(onShape);
    expect(onMenu).toHaveBeenCalledWith({ ...onShape, id: 'm1', projectId: 'p1' });
    expect(isClaimed(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    // beside every shape: no menu
    contextMenuAt(empty);
    expect(onMenu).toHaveBeenCalledTimes(1);
  });

  it('a right drag is not a right-click', () => {
    const init = { clientY: onShape.y, button: 2, bubbles: true, cancelable: true };
    canvas.dispatchEvent(new MouseEvent('pointerdown', { ...init, clientX: onShape.x - 20 }));
    canvas.dispatchEvent(new MouseEvent('contextmenu', { ...init, clientX: onShape.x }));
    expect(onMenu).not.toHaveBeenCalled();
  });

  it('no menu and no claim while a tool draws or vertices are edited', () => {
    const tool = measureStore.getState().tool;
    for (const patch of [
      { tool: { tool: 'distance' as const, template: null, picks: {} }, draw: initialDraw('line') },
      { editing: initialEdit([[0, 0, 0]]) },
    ]) {
      measureStore.setState({ tool, draw: null, editing: null, ...patch } as never);
      const e = contextMenuAt(onShape);
      expect(onMenu).not.toHaveBeenCalled();
      expect(isClaimed(e)).toBe(false);
      expect(claim(leftClickAt(onShape))).toBe(false);
      expect(measureStore.getState().focus).toBeNull();
    }
  });

  it('a claimed right-click (a pin, a photo, the drone) is left alone', () => {
    contextMenuAt(onShape, claimEvent);
    expect(onMenu).not.toHaveBeenCalled();
  });

  it('a right-click elsewhere than the view (a toolbar over it) is left alone', () => {
    const button = document.body.appendChild(document.createElement('button'));
    const init = { clientX: onShape.x, clientY: onShape.y, button: 2, bubbles: true };
    button.dispatchEvent(new MouseEvent('pointerdown', init));
    button.dispatchEvent(new MouseEvent('contextmenu', init));
    expect(onMenu).not.toHaveBeenCalled();
    button.remove();
  });

  it('a left click selects and reveals without opening the sidebar; empty ground clears', () => {
    expect(claim(leftClickAt(onShape))).toBe(true);
    expect(measureStore.getState().focus).toBe('m1');
    expect(measureStore.getState().selected).toEqual(['m1']);
    expect(measureStore.getState().reveal).toMatchObject({ id: 'm1', openSidebar: false });
    expect(claim(leftClickAt(empty))).toBe(false);
    expect(measureStore.getState().focus).toBeNull();
    expect(measureStore.getState().selected).toEqual([]);
  });

  it('empty ground clears a selection the sidebar marks left without a focus', () => {
    measureStore.setState({ selected: ['m1'], focus: null });
    expect(claim(leftClickAt(empty))).toBe(false);
    expect(measureStore.getState().selected).toEqual([]);
  });

  it('a left click is the stage tool when another stage tool is on', () => {
    stage.tool = 'measure';
    expect(claim(leftClickAt(onShape))).toBe(false);
    expect(measureStore.getState().focus).toBeNull();
  });

  it('a pin under the cursor keeps the click', () => {
    vi.mocked(pinsAt).mockReturnValue({ kind: 'pano', layerId: 'pl', itemId: 'p' });
    expect(claim(leftClickAt(onShape))).toBe(false);
    expect(measureStore.getState().focus).toBeNull();
    contextMenuAt(onShape);
    expect(onMenu).not.toHaveBeenCalled();
  });

  it('an issue pin over a measurement keeps its click and its right-click', () => {
    vi.mocked(issueAt).mockImplementation((el, x, y) =>
      el === canvas && x === onShape.x && y === onShape.y ? 'issue-1' : null,
    );
    expect(claim(leftClickAt(onShape))).toBe(false);
    expect(measureStore.getState().focus).toBeNull();
    const e = contextMenuAt(onShape);
    expect(onMenu).not.toHaveBeenCalled();
    expect(isClaimed(e)).toBe(false);
  });

  it('hits a survey measurement where its date line-up draws it', () => {
    // stored at N 100, drawn 20 m south at N 80
    contextMenuAt(at(50, 80));
    expect(onMenu).toHaveBeenLastCalledWith(expect.objectContaining({ id: 's1' }));
    onMenu.mockClear();
    contextMenuAt(at(50, 100));
    expect(onMenu).not.toHaveBeenCalled();
  });

  it('a hidden measurement and one off screen by its date are not hit', () => {
    setMeasurementsHidden(['m1'], true);
    workspace.getState().setLayerVisible('model-jun', false);
    expect(primaryScene.getState().hidden).toMatchObject({ 'model-jun': true });
    contextMenuAt(onShape);
    contextMenuAt(at(50, 80));
    expect(onMenu).not.toHaveBeenCalled();
    expect(claim(leftClickAt(onShape))).toBe(false);
    workspace.getState().setLayerVisible('model-jun', true);
  });
});

describe('measurement pick on the map', () => {
  let mapCanvas: HTMLCanvasElement;
  let container: HTMLDivElement;
  let features: unknown[];
  let offMap: () => void;

  beforeEach(() => {
    features = [];
    container = document.body.appendChild(document.createElement('div'));
    mapCanvas = container.appendChild(document.createElement('canvas'));
    mapCanvas.getBoundingClientRect = () => canvas.getBoundingClientRect();
    const map = {
      getCanvas: () => mapCanvas,
      getContainer: () => container,
      // the same 1 px a metre view as the 3D camera, through the project CRS
      project: ([lng, lat]: [number, number]) => {
        const [e, n] = fromWgs84([lng, lat, 0], 32640);
        return at(e, n);
      },
      getLayer: (id: string) => (id === 'aio-photos-pt' ? {} : undefined),
      queryRenderedFeatures: () => features,
    };
    offMap = attachMeasurePickMap({ map } as unknown as MapController, frameOf(manifest), onMenu);
  });
  afterEach(() => {
    offMap();
    container.remove();
  });

  const mapEvent = (type: string, p: { x: number; y: number }, button: number) => {
    const init = { clientX: p.x, clientY: p.y, button, bubbles: true, cancelable: true };
    const e = new MouseEvent(type, init);
    mapCanvas.dispatchEvent(e);
    return e;
  };
  const mapRightClick = (p: { x: number; y: number }) => {
    mapEvent('pointerdown', p, 2);
    return mapEvent('contextmenu', p, 2);
  };
  const mapLeftClick = (p: { x: number; y: number }) => {
    mapEvent('pointerdown', p, 0);
    mapEvent('click', p, 0);
  };

  it('right-click on a shape opens the menu; a left click selects and reveals', () => {
    const e = mapRightClick(onShape);
    expect(onMenu).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', projectId: 'p1' }));
    expect(isClaimed(e)).toBe(true);
    mapLeftClick(onShape);
    expect(measureStore.getState().focus).toBe('m1');
    expect(measureStore.getState().reveal).toMatchObject({ id: 'm1', openSidebar: false });
    mapLeftClick(empty);
    expect(measureStore.getState().focus).toBeNull();
  });

  it('a photo pin, a map pick in progress or a measure tool keep the click', () => {
    features = [{ layer: { id: 'aio-photos-pt' } }];
    mapRightClick(onShape);
    mapLeftClick(onShape);
    features = [];
    mapCanvas.style.cursor = 'crosshair';
    mapRightClick(onShape);
    mapLeftClick(onShape);
    mapCanvas.style.cursor = '';
    measureStore.setState({ draw: initialDraw('line') });
    mapRightClick(onShape);
    mapLeftClick(onShape);
    expect(onMenu).not.toHaveBeenCalled();
    expect(measureStore.getState().focus).toBeNull();
  });
});
