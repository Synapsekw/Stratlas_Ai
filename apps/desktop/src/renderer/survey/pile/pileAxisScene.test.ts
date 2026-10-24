// @vitest-environment jsdom
import type { EngineStage } from '@aio/engine';
import { toWgs84 } from '@aio/geo';
import type { MapController } from '@aio/maps';
import { emptyMeasurements, type SitePoint, type SurveyMeasurement } from '@aio/schema';
import { pileAxis } from '@aio/survey';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workbench } from '../../workspace/workbench/workbenchStore';
import { frameOf } from '../measureScene';
import { measureStore } from '../measureStore';
import type { Line2 } from 'three/examples/jsm/lines/Line2.js';
import {
  attachPileAxis3d,
  attachPileAxisMap,
  axisDrag,
  axisNudge,
  PILE_AXIS_LAYER,
  stagePile,
} from './pileAxisScene';
import { pileView } from './pileView';

vi.mock('../../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false }) },
  jobs: {},
  useShell: () => null,
  shell: { getState: () => ({ rightCollapsed: false }) },
}));
vi.mock('../../issueCard/state', () => ({ isIssueEditing: () => false }));

const RECT = { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0 };

/** A 40 x 10 m pile on flat ground at 5 m, long along east. */
const RING: SitePoint[] = [
  [0, 0, 5],
  [40, 0, 5],
  [40, 10, 5],
  [0, 10, 5],
];
const PILE: SurveyMeasurement = {
  id: '02',
  family: 'polygon',
  tool: 'volume',
  label: 'Pile 02',
  scope: { kind: 'site' },
  points: RING,
  items: [],
  results: [],
  createdAt: '2026-10-24T00:00:00Z',
};

const close = (a: readonly number[], b: readonly number[], eps = 1e-6) =>
  a.every((x, i) => Math.abs(x - (b[i] ?? NaN)) < eps);

/** Animation frames run when a test says so (`flush`). */
let frames: FrameRequestCallback[] = [];
const flush = () => {
  const run = frames;
  frames = [];
  for (const f of run) f(0);
};

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => {
    frames.push(f);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  measureStore.setState({
    file: { ...emptyMeasurements(), measurements: [PILE] },
    focus: '02',
    selected: ['02'],
    tool: null,
    draw: null,
    editing: null,
  });
  pileView.setState({ tab: 'profile', axis: new Map() });
  if (!workbench.getState().tabs.some((t) => t.id === 'volumes'))
    workbench.getState().open('volumes');
  workbench.getState().show('volumes');
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('axisDrag', () => {
  it("dragging B moves only B and updates the profile key's line", () => {
    const start = pileAxis(RING);
    const next = axisDrag(start, RING, 'b').move([45, 8]);
    expect(next.a).toEqual(start.a);
    expect(next.b).toEqual([45, 8]);
    expect(next.lengthM).toBeCloseTo(Math.hypot(45 - start.a[0], 8 - start.a[1]), 6);
  });

  it('dragging ↻ by 15° turns the axis by 15°', () => {
    const start = pileAxis(RING);
    expect(start.angleDeg).toBeCloseTo(0, 6);
    const [cx, cy] = start.centre;
    const drag = axisDrag(start, RING, 'turn', 2);
    // grabbed at the centre: no angle there, nothing turns
    expect(drag.move([cx, cy])).toBe(start);
    // out along the line, then 15° clockwise (east to south-east) at the same radius
    drag.move([cx + 10, cy]);
    const r = 10;
    const a = 15 * (Math.PI / 180);
    const turned = drag.move([cx + r * Math.cos(a), cy - r * Math.sin(a)]);
    expect(turned.angleDeg).toBeCloseTo(15, 6);
    expect(close(turned.centre, start.centre)).toBe(true);
    // and back the other way past east wraps into [0, 180)
    const back = drag.move([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    expect(back.angleDeg).toBeCloseTo(165, 6);
  });
});

describe('axisNudge', () => {
  it('moves an end 0.5 m per arrow key, ten times that with Shift', () => {
    const start = pileAxis(RING);
    expect(axisNudge(start, RING, 'a', 'ArrowLeft', false)?.a).toEqual([
      start.a[0] - 0.5,
      start.a[1],
    ]);
    expect(axisNudge(start, RING, 'a', 'ArrowDown', true)?.a).toEqual([start.a[0], start.a[1] - 5]);
    expect(axisNudge(start, RING, 'a', 'Enter', false)).toBeNull();
  });

  it('turns 5° per arrow key, 50° with Shift', () => {
    const start = pileAxis(RING);
    expect(axisNudge(start, RING, 'turn', 'ArrowRight', false)?.angleDeg).toBeCloseTo(5, 6);
    expect(axisNudge(start, RING, 'turn', 'ArrowLeft', false)?.angleDeg).toBeCloseTo(175, 6);
    expect(axisNudge(start, RING, 'turn', 'ArrowRight', true)?.angleDeg).toBeCloseTo(50, 6);
  });
});

describe('stagePile', () => {
  it('is the focused pile while the Volumes tab is in front', () => {
    expect(stagePile()?.m.id).toBe('02');
    expect(stagePile()?.profile).toBe(true);
    pileView.setState({ tab: 'history' });
    expect(stagePile()?.profile).toBe(false);
    workbench.getState().open('measure');
    workbench.getState().show('measure');
    expect(stagePile()).toBeNull();
  });
});

const frame = frameOf({ origin: [0, 0, 0], crs: { wkt: 'LOCAL_CS["Synthetic"]' } });

function fakeStage() {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.append(canvas);
  document.body.append(host);
  canvas.getBoundingClientRect = () => RECT as DOMRect;
  host.getBoundingClientRect = () => RECT as DOMRect;
  const camera = new PerspectiveCamera(50, 400 / 300, 0.1, 5000);
  camera.position.set(20, 60, 40);
  camera.lookAt(20, 5, -5);
  camera.updateMatrixWorld();
  const stage = {
    scene: new Scene(),
    camera,
    renderer: { domElement: canvas },
    controls: { enabled: true },
    requestRender: vi.fn(),
    raycastRay: vi.fn(() => null),
    onFrame: () => () => undefined,
  };
  const screenOf = (p: SitePoint): [number, number] => {
    const l = frame.toLocal(p);
    const v = new Vector3(l[0], l[1], l[2]).project(camera);
    return [((v.x + 1) / 2) * 400, ((1 - v.y) / 2) * 300];
  };
  const detach = attachPileAxis3d(stage as unknown as EngineStage, frame);
  return { stage, host, screenOf, detach };
}

const pointer = (type: string, x: number, y: number) =>
  new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });

describe('3D', () => {
  it('draws the dashed line with A, B and ↻ while the Profile is open', () => {
    const s = fakeStage();
    expect(s.stage.scene.getObjectByName('pile-axis-line')).toBeDefined();
    for (const h of ['a', 'b', 'turn'])
      expect(s.host.querySelector<HTMLElement>(`[data-testid="pile-axis-${h}"]`)?.hidden).toBe(
        false,
      );
    pileView.setState({ tab: 'overview' });
    expect(s.stage.scene.getObjectByName('pile-axis-line')).toBeUndefined();
    expect(s.host.querySelector<HTMLElement>('[data-testid="pile-axis-a"]')?.hidden).toBe(true);
    s.detach();
    expect(s.stage.scene.getObjectByName('aio-pile-axis')).toBeUndefined();
    expect(s.host.querySelector('[data-testid="pile-axis-a"]')).toBeNull();
  });

  it("dragging B writes the pile's line, A stays", () => {
    const s = fakeStage();
    const start = pileAxis(RING);
    const handle = s.host.querySelector<HTMLElement>('[data-testid="pile-axis-b"]');
    const [bx, by] = s.screenOf([start.b[0], start.b[1], 5]);
    handle?.dispatchEvent(pointer('pointerdown', bx, by));
    const [tx, ty] = s.screenOf([44, 9, 5]);
    window.dispatchEvent(pointer('pointermove', tx, ty));
    window.dispatchEvent(pointer('pointerup', tx, ty));
    const kept = pileView.getState().axis.get('02');
    expect(kept?.a).toEqual(start.a);
    expect(close(kept?.b ?? [], [44, 9], 1e-3)).toBe(true);
    // released: later moves do nothing
    window.dispatchEvent(pointer('pointermove', 0, 0));
    expect(pileView.getState().axis.get('02')).toBe(kept);
    s.detach();
  });

  it('a drag moves the line once a frame, keeps its material and drapes in full on release', () => {
    const s = fakeStage();
    const start = pileAxis(RING);
    const line = () => s.stage.scene.getObjectByName('pile-axis-line') as Line2;
    const material = line().material;
    const handle = s.host.querySelector<HTMLElement>('[data-testid="pile-axis-b"]');
    const [bx, by] = s.screenOf([start.b[0], start.b[1], 5]);
    handle?.dispatchEvent(pointer('pointerdown', bx, by));
    const setAxis = vi.spyOn(pileView.getState(), 'setAxis');
    s.stage.raycastRay.mockClear();
    const [t1x, t1y] = s.screenOf([42, 7, 5]);
    const [t2x, t2y] = s.screenOf([44, 9, 5]);
    window.dispatchEvent(pointer('pointermove', t1x, t1y));
    window.dispatchEvent(pointer('pointermove', t2x, t2y));
    expect(setAxis).not.toHaveBeenCalled();
    flush();
    expect(setAxis).toHaveBeenCalledTimes(1);
    expect(close(pileView.getState().axis.get('02')?.b ?? [], [44, 9], 1e-3)).toBe(true);
    // a few rays while the line moves, not one per draped sample
    expect(s.stage.raycastRay.mock.calls.length).toBeLessThanOrEqual(4);
    expect(line().material).toBe(material);
    s.stage.raycastRay.mockClear();
    window.dispatchEvent(pointer('pointerup', t2x, t2y));
    expect(s.stage.raycastRay.mock.calls.length).toBeGreaterThan(20);
    expect(line().material).toBe(material);
    setAxis.mockRestore();
    s.detach();
  });

  it('the handles are buttons named for what they do, moved and turned with the arrow keys', () => {
    const s = fakeStage();
    const start = pileAxis(RING);
    const b = s.host.querySelector<HTMLButtonElement>('[data-testid="pile-axis-b"]');
    expect(b?.tagName).toBe('BUTTON');
    expect(b?.getAttribute('aria-label')).toMatch(/end B/);
    expect(b?.closest('[aria-hidden="true"]')).toBeNull();
    const key = (el: Element | null, k: string, shiftKey = false) =>
      el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true }));
    key(b, 'ArrowRight');
    let kept = pileView.getState().axis.get('02');
    expect(close(kept?.b ?? [], [start.b[0] + 0.5, start.b[1]])).toBe(true);
    key(b, 'ArrowUp', true);
    kept = pileView.getState().axis.get('02');
    expect(close(kept?.b ?? [], [start.b[0] + 0.5, start.b[1] + 5])).toBe(true);
    expect(kept?.a).toEqual(start.a);
    const turn = s.host.querySelector<HTMLButtonElement>('[data-testid="pile-axis-turn"]');
    pileView.setState({ axis: new Map() });
    key(turn, 'ArrowRight');
    expect(pileView.getState().axis.get('02')?.angleDeg).toBeCloseTo(5, 6);
    s.detach();
  });
});

describe('map', () => {
  it('draws the line on the map and takes it away when the pile closes', () => {
    const layers = new Map<string, unknown>();
    let data: { features: unknown[] } = { features: [] };
    let added = false;
    const container = document.createElement('div');
    const canvas = document.createElement('canvas');
    container.append(canvas);
    document.body.append(container);
    const [lng0, lat0] = toWgs84([0, 0, 0], 32640);
    const map = {
      getCanvas: () => canvas,
      getContainer: () => container,
      project: (ll: [number, number]) => ({
        x: 50 + (ll[0] - lng0) * 100_000,
        y: 150 - (ll[1] - lat0) * 100_000,
      }),
      unproject: () => ({ lng: lng0, lat: lat0 }),
      isStyleLoaded: () => true,
      getSource: () => (added ? { setData: (d: typeof data) => (data = d) } : undefined),
      addSource: (_id: string, src: { data: typeof data }) => {
        added = true;
        data = src.data;
      },
      removeSource: () => {
        added = false;
      },
      getLayer: (id: string) => layers.get(id),
      addLayer: (l: { id: string }) => layers.set(l.id, l),
      removeLayer: (id: string) => layers.delete(id),
      on: () => undefined,
      off: () => undefined,
      once: () => undefined,
    };
    const mapFrame = frameOf({ origin: [0, 0, 0], crs: { epsg: 32640 } });
    const detach = attachPileAxisMap({ map } as unknown as MapController, mapFrame);
    expect(layers.has(PILE_AXIS_LAYER)).toBe(true);
    expect(data.features).toHaveLength(1);
    expect(container.querySelector<HTMLElement>('[data-testid="pile-axis-turn"]')?.hidden).toBe(
      false,
    );
    measureStore.setState({ focus: null, selected: [] });
    expect(data.features).toHaveLength(0);
    detach();
    expect(layers.has(PILE_AXIS_LAYER)).toBe(false);
  });
});
