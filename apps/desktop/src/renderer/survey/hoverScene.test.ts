// @vitest-environment jsdom
import type { EngineStage } from '@aio/engine';
import { toWgs84 } from '@aio/geo';
import type { MapController } from '@aio/maps';
import { emptyMeasurements, type SitePoint } from '@aio/schema';
import type { ChartSeries } from '@aio/survey';
import { workspace } from '@aio/workspace';
import { PerspectiveCamera, Scene, Vector3, type Points, type PointsMaterial } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkedHover, type HoverLine } from './linkedHover';
import { attachHover3d, attachHoverFly, attachHoverMap, LINK_LAYERS } from './hoverScene';
import { frameOf } from './measureScene';
import { measureStore } from './measureStore';

vi.mock('../shell', () => ({ bridge: { call: () => Promise.resolve({ ok: false }) }, jobs: {} }));

const RECT = { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0 };

const series = (
  key: string,
  kind: ChartSeries['kind'],
  date: string,
  z: readonly number[],
): ChartSeries => ({
  key,
  label: key,
  kind,
  capture: `cap-${key}`,
  date,
  chainage: [0, 50, 100],
  z,
});

/** 100 m east from the origin; the later survey 1.63 m below the earlier one all along. */
const line = (s: readonly ChartSeries[]): HoverLine => ({
  key: 'measure:m',
  polyline: [
    [0, 0],
    [100, 0],
  ],
  series: s,
});
const DEC = series('dec', 'earlier', '2025-12-31', [10, 10, 10]);
const JAN = series('jan', 'current', '2026-01-10', [8.37, 8.37, 8.37]);
const TWO = [DEC, JAN];

beforeEach(() => {
  linkedHover.setState({ lines: new Map(), hover: null, pin: null, fly: null });
  measureStore.setState({ file: emptyMeasurements(), tool: null, draw: null, editing: null });
});

const frame = frameOf({ origin: [0, 0, 0], crs: { wkt: 'LOCAL_CS["Synthetic"]' } });

function fakeStage() {
  let claim: (e: PointerEvent) => boolean = () => false;
  let frameCb: () => void = () => undefined;
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.append(canvas);
  document.body.append(host);
  canvas.getBoundingClientRect = () => RECT as DOMRect;
  host.getBoundingClientRect = () => RECT as DOMRect;
  const camera = new PerspectiveCamera(50, 400 / 300, 0.1, 5000);
  camera.position.set(50, 80, 60);
  camera.lookAt(50, 9, 0);
  camera.updateMatrixWorld();
  const stage = {
    scene: new Scene(),
    camera,
    renderer: { domElement: canvas },
    controls: { enabled: true },
    requestRender: vi.fn(),
    raycastRay: () => null,
    onFrame: (fn: () => void) => {
      frameCb = fn;
      return () => undefined;
    },
    claimClicks: (fn: typeof claim) => {
      claim = fn;
      return () => undefined;
    },
  };
  /** Where a site point is on screen. */
  const screenOf = (p: SitePoint): [number, number] => {
    const l = frame.toLocal(p);
    const v = new Vector3(l[0], l[1], l[2]).project(camera);
    return [((v.x + 1) / 2) * 400, ((1 - v.y) / 2) * 300];
  };
  const detach = attachHover3d(stage as unknown as EngineStage, frame);
  const group = () => stage.scene.getObjectByName('aio-link');
  return {
    stage,
    canvas,
    host,
    screenOf,
    named: (name: string) => group()?.children.filter((c) => c.name === name) ?? [],
    move: (x: number, y: number) =>
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y })),
    click: (x: number, y: number) => claim({ clientX: x, clientY: y } as PointerEvent),
    dbl: (x: number, y: number) =>
      canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: x, clientY: y })),
    render: () => {
      frameCb();
    },
    tag: () => host.querySelector<HTMLElement>('[data-testid="link-tag"]'),
    pin: () => host.querySelector<HTMLElement>('[data-testid="link-pin"]'),
    detach: () => {
      detach();
      host.remove();
    },
  };
}

describe('3D', () => {
  it('a chart hover adds dots, gap, trace and a tag with "42.3 m · −1.63"', () => {
    const s = fakeStage();
    linkedHover.getState().register(line(TWO));
    linkedHover.getState().setHover({ key: 'measure:m', chainageM: 42.3, source: 'chart' });
    const dots = s.named('link-dot') as Points[];
    expect(dots).toHaveLength(2);
    expect(dots.map((d) => d.userData.filled === true)).toEqual([false, true]);
    // drawn over the scene, like the measurement lines, and never picked
    for (const d of dots) expect((d.material as PointsMaterial).depthTest).toBe(false);
    expect((dots[0]?.material as PointsMaterial).sizeAttenuation).toBe(false);
    expect(s.named('link-gap')).toHaveLength(1);
    expect(s.named('link-trace')).toHaveLength(1);
    expect(s.named('link-ground')).toHaveLength(1);
    const tag = s.tag();
    expect(tag?.hidden).toBe(false);
    expect(tag?.textContent).toBe('42.3 m · −1.63');
    expect(tag?.dataset.key).toBe('measure:m');
    expect(tag?.dataset.chainage).toBe('42.30');
    expect(tag?.classList.contains('cut')).toBe(true);
    expect(s.pin()?.hidden).toBe(true);
    s.detach();
    expect(s.stage.scene.getObjectByName('aio-link')).toBeUndefined();
    expect(s.tag()).toBeNull();
  });

  it('one series: one dot, no gap, tag without delta', () => {
    const s = fakeStage();
    linkedHover.getState().register(line([JAN]));
    linkedHover.getState().setHover({ key: 'measure:m', chainageM: 42.3, source: 'chart' });
    expect(s.named('link-dot')).toHaveLength(1);
    expect(s.named('link-gap')).toHaveLength(0);
    expect(s.tag()?.textContent).toBe('42.3 m');
    s.detach();
  });

  it('pointer within 12 px of a registered line sets the hover with source 3d', () => {
    const s = fakeStage();
    linkedHover.getState().register(line(TWO));
    const [x, y] = s.screenOf([30, 0, 8.37]);
    s.move(x, y + 8);
    const hover = linkedHover.getState().hover;
    expect(hover?.source).toBe('3d');
    expect(hover?.key).toBe('measure:m');
    expect(hover?.chainageM).toBeGreaterThan(28);
    expect(hover?.chainageM).toBeLessThan(32);
    // a miss clears the hover this view set
    s.move(x, y + 60);
    expect(linkedHover.getState().hover).toBeNull();
    s.detach();
  });

  it('a miss leaves a hover the chart set', () => {
    const s = fakeStage();
    linkedHover.getState().register(line(TWO));
    linkedHover.getState().setHover({ key: 'measure:m', chainageM: 5, source: 'chart' });
    s.move(5, 5);
    expect(linkedHover.getState().hover?.source).toBe('chart');
    s.detach();
  });

  it('a click on the snapped line pins and is claimed; elsewhere it is not claimed', () => {
    const s = fakeStage();
    linkedHover.getState().register(line(TWO));
    const [x, y] = s.screenOf([60, 0, 8.37]);
    expect(s.click(x, y + 200)).toBe(false);
    expect(linkedHover.getState().pin).toBeNull();
    expect(s.click(x, y)).toBe(true);
    const pin = linkedHover.getState().pin;
    expect(pin?.source).toBe('3d');
    expect(pin?.chainageM).toBeCloseTo(60, 0);
    expect(s.pin()?.hidden).toBe(false);
    s.detach();
  });

  it('no snapping while a measurement is being drawn', () => {
    const s = fakeStage();
    linkedHover.getState().register(line(TWO));
    measureStore.setState({ draw: {} as never });
    const [x, y] = s.screenOf([60, 0, 8.37]);
    expect(s.click(x, y)).toBe(false);
    s.move(x, y);
    expect(linkedHover.getState().hover).toBeNull();
    s.detach();
  });

  it('double-click asks the workspace to fly to the point', () => {
    const fly = vi.spyOn(workspace.getState(), 'flyTo').mockImplementation(() => undefined);
    const offFly = attachHoverFly(frame);
    const s = fakeStage();
    linkedHover.getState().register(line(TWO));
    const [x, y] = s.screenOf([50, 0, 8.37]);
    s.dbl(x, y);
    expect(fly).toHaveBeenCalledTimes(1);
    const target = fly.mock.calls[0]?.[0] as { kind: string; p: number[]; distance: number };
    expect(target.kind).toBe('point');
    expect(target.distance).toBe(40);
    expect(target.p[0]).toBeCloseTo(50, 0);
    expect(target.p[1]).toBeCloseTo(8.37, 1);
    s.detach();
    offFly();
    fly.mockRestore();
  });
});

// ---------------------------------------------------------------- map

function fakeMap() {
  const layers = new Map<string, { type: string }>();
  let data: { features: { properties: Record<string, unknown> }[] } = { features: [] };
  let added = false;
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  container.append(canvas);
  document.body.append(container);
  canvas.getBoundingClientRect = () => RECT as DOMRect;
  container.getBoundingClientRect = () => RECT as DOMRect;
  // a plain projection around the first vertex: 1 px a metre or so
  const [lng0, lat0] = toWgs84([500_000, 2_700_000, 0], 32640);
  const map = {
    getCanvas: () => canvas,
    getContainer: () => container,
    project: (ll: [number, number]) => ({
      x: 50 + (ll[0] - lng0) * 100_000,
      y: 150 - (ll[1] - lat0) * 100_000,
    }),
    isStyleLoaded: () => true,
    getSource: (id: string) =>
      id === 'aio-link' && added
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
    removeSource: () => {
      added = false;
    },
    getLayer: (id: string) => layers.get(id),
    addLayer: (l: { id: string; type: string }) => layers.set(l.id, l),
    removeLayer: (id: string) => layers.delete(id),
    on: () => undefined,
    off: () => undefined,
    once: () => undefined,
  };
  return {
    ctl: { map } as unknown as MapController,
    container,
    layers,
    source: () => added,
    features: () => data.features,
  };
}

describe('map', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const mapFrame = frameOf({ origin: [0, 0, 0], crs: { epsg: 32640 } });
  const mapLine: HoverLine = {
    key: 'pile:p',
    polyline: [
      [500_000, 2_700_000],
      [500_100, 2_700_000],
    ],
    series: TWO,
  };

  it('the map attach adds the aio-link layers and removes them on detach', () => {
    const m = fakeMap();
    const detach = attachHoverMap(m.ctl, mapFrame);
    expect([...m.layers.keys()]).toEqual([...LINK_LAYERS]);
    linkedHover.getState().register(mapLine);
    linkedHover.getState().setHover({ key: 'pile:p', chainageM: 42.3, source: 'chart' });
    const kinds = m.features().map((f) => f.properties.kind);
    expect(kinds.filter((k) => k === 'dot')).toHaveLength(2);
    expect(kinds).toContain('trace');
    const tag = m.container.querySelector<HTMLElement>('[data-testid="link-tag"]');
    expect(tag?.textContent).toBe('42.3 m · −1.63');
    detach();
    expect(m.layers.size).toBe(0);
    expect(m.source()).toBe(false);
    expect(m.container.querySelector('[data-testid="link-tag"]')).toBeNull();
  });

  it('a pointer near the line on the map sets the hover, a click pins', () => {
    const m = fakeMap();
    const detach = attachHoverMap(m.ctl, mapFrame);
    linkedHover.getState().register(mapLine);
    // 30 m along is about 30 px right of the first vertex at (50, 150)
    m.container.dispatchEvent(new MouseEvent('pointermove', { clientX: 80, clientY: 156 }));
    expect(linkedHover.getState().hover?.source).toBe('map');
    const click = new MouseEvent('click', { clientX: 80, clientY: 150, bubbles: true });
    m.container.dispatchEvent(click);
    expect(linkedHover.getState().pin?.source).toBe('map');
    detach();
  });
});
