// @vitest-environment jsdom
import { setActiveScene, type SceneHandle } from '@aio/engine';
import { createWorkspace } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Handler = (e: unknown) => void;

/** The slice of a MapLibre map the controller uses, recording listeners and removal. */
class FakeMap {
  static last: FakeMap | null = null;
  readonly handlers = new Map<string, Handler[]>();
  readonly canvas = document.createElement('canvas');
  readonly doubleClickZoom = { enable: vi.fn(), disable: vi.fn() };
  readonly dragPan = { enable: vi.fn(), disable: vi.fn() };
  /** Screen px of a lon/lat: a fixed linear map, so tests can aim at handles. */
  project(ll: [number, number] | { lng: number; lat: number }) {
    const [lng, lat] = Array.isArray(ll) ? ll : [ll.lng, ll.lat];
    return { x: lng * 1e5, y: -lat * 1e5 };
  }
  readonly remove = vi.fn(() => {
    this.handlers.clear();
  });
  sourceReads = 0;
  private readonly layers = new Set<string>();
  private readonly sources = new Set<string>();
  constructor() {
    FakeMap.last = this;
  }
  on(type: string, a: Handler | string, b?: Handler): void {
    const fn = typeof a === 'string' ? b : a;
    if (!fn) return;
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  once(type: string, fn: Handler): void {
    this.on(type, fn);
  }
  off(): void {
    /* not needed */
  }
  fire(type: string, e: unknown = {}): void {
    for (const fn of this.handlers.get(type) ?? []) fn(e);
  }
  addControl(): void {
    /* controls draw nothing here */
  }
  addSource(id: string): void {
    this.sources.add(id);
  }
  getSource(id: string) {
    this.sourceReads++;
    return this.sources.has(id) ? { setData: () => Promise.resolve() } : undefined;
  }
  removeSource(id: string): void {
    this.sources.delete(id);
  }
  addLayer(l: { id: string }): void {
    this.layers.add(l.id);
  }
  getLayer(id: string) {
    return this.layers.has(id) ? { id } : undefined;
  }
  removeLayer(id: string): void {
    this.layers.delete(id);
  }
  setPaintProperty(): void {
    /* style only */
  }
  /** The layout properties set, per layer (`visibility` and the like). */
  readonly layout = new Map<string, Record<string, unknown>>();
  setLayoutProperty(id: string, name: string, value: unknown): void {
    this.layout.set(id, { ...this.layout.get(id), [name]: value });
  }
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }
  /** The photo and 360 markers lay out over these (mediaMarkers.ts). */
  getContainer(): HTMLElement {
    return this.canvas.parentElement ?? this.canvas;
  }
  triggerRepaint(): void {
    this.fire('render');
  }
  queryRenderedFeatures(): unknown[] {
    return [];
  }
  resize(): void {
    /* no layout in jsdom */
  }
  /** The camera, as far as framing reads it. */
  zoom = 0;
  center = { lng: 0, lat: 0 };
  readonly framed = vi.fn();
  getZoom(): number {
    return this.zoom;
  }
  getCenter(): { lng: number; lat: number } {
    return this.center;
  }
  jumpTo(o: { center?: [number, number]; zoom?: number }): void {
    if (o.zoom !== undefined) this.zoom = o.zoom;
    if (o.center) this.center = { lng: o.center[0], lat: o.center[1] };
  }
  fitBounds(): void {
    this.framed();
    this.zoom = 16;
  }
}

/** A map control: nothing to draw here. */
class FakeControl {
  readonly kind = 'control';
}

vi.mock('maplibre-gl', () => ({
  Map: FakeMap,
  AttributionControl: FakeControl,
  NavigationControl: FakeControl,
  ScaleControl: FakeControl,
  Popup: class {
    remove = vi.fn();
    setLngLat() {
      return this;
    }
    setDOMContent() {
      return this;
    }
    addTo() {
      return this;
    }
  },
}));
// Vite-only asset and worker wiring.
vi.mock('./runtime', () => ({ installBasemap: vi.fn() }));

const { createMapController } = await import('./controller');
const geo = await import('./geo');

afterEach(() => {
  setActiveScene(null);
  vi.unstubAllGlobals();
});

function start() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const store = createWorkspace();
  const ctl = createMapController(el, { packs: [], store, showFlights: true });
  lastStore = store;
  const map = FakeMap.last;
  if (!map) throw new Error('no map');
  map.fire('load');
  return { el, store, ctl, map };
}

describe('the 3D camera wedge', () => {
  it('is hidden on the map unless asked for', () => {
    const { ctl, map } = start();
    for (const id of ['aio-view3d-fill', 'aio-view3d-line'])
      expect(map.layout.get(id)?.visibility).toBe('none');
    ctl.setCameraWedge(true);
    for (const id of ['aio-view3d-fill', 'aio-view3d-line'])
      expect(map.layout.get(id)?.visibility).toBe('visible');
    ctl.dispose();
  });
});

describe('map controller dispose (T8 soak: maps kept alive after a project closed)', () => {
  it('removes the map and lets go of the workspace, the 3D view and its container', () => {
    const offFrame = vi.fn();
    const onFrame = vi.fn(() => offFrame);
    const scene = { onFrame, camera: null } as unknown as SceneHandle;
    setActiveScene(null);
    const { el, store, ctl, map } = start();
    // the controller follows the active 3D view for its camera wedge
    setActiveScene(scene);
    expect(onFrame).toHaveBeenCalled();
    expect((el as unknown as { __aioMap?: unknown }).__aioMap).toBe(map);

    ctl.dispose();
    expect(map.remove).toHaveBeenCalledTimes(1);
    expect(offFrame).toHaveBeenCalled();
    expect('__aioMap' in el).toBe(false);

    // workspace changes and a new 3D view no longer reach the disposed map
    const reads = map.sourceReads;
    store.setState({ issues: [], selection: null, nowMs: 1 });
    const nextFrame = vi.fn(() => vi.fn());
    setActiveScene({ onFrame: nextFrame, camera: null } as unknown as SceneHandle);
    expect(nextFrame).not.toHaveBeenCalled();
    expect(map.sourceReads).toBe(reads);

    // a second dispose (React strict effects, a late cleanup) does nothing
    ctl.dispose();
    expect(map.remove).toHaveBeenCalledTimes(1);
  });

  it('cancels a hover redraw that waits for the next frame', () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 42),
    );
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const { ctl, map } = start();
    map.fire('mousemove', { point: { x: 1, y: 1 }, lngLat: { lng: 0, lat: 0 } });
    ctl.dispose();
    expect(cancel).toHaveBeenCalledWith(42);
  });
});

/** A map with a UTM project open, so clicks have a local point. */
let lastStore: ReturnType<typeof createWorkspace> | null = null;
/** Open a project with a coordinate system and no layers on the last started map's store. */
function openProjectOnLastMap(): void {
  lastStore?.setState({
    project: {
      id: 'p1',
      manifest: { crs: { epsg: 32633 }, origin: [500_000, 4_000_000, 0], layers: [] },
    } as unknown as ReturnType<ReturnType<typeof createWorkspace>['getState']>['project'],
  });
}

function startWithProject() {
  const started = start();
  const { frameProjection } = geo;
  const manifest = {
    crs: { epsg: 32633 },
    origin: [500_000, 4_000_000, 0],
    layers: [],
  };
  started.store.setState({
    project: { id: 'p1', manifest } as unknown as ReturnType<
      typeof started.store.getState
    >['project'],
  });
  const proj = frameProjection({ epsg: 32633 }, [500_000, 4_000_000, 0]);
  if (!proj) throw new Error('no projection');
  return { ...started, proj };
}
const click = (lng: number, lat: number) => ({
  point: { x: 10, y: 10 },
  lngLat: { lng, lat },
  originalEvent: { clientX: 10, clientY: 10, altKey: false },
});

describe('map point pick (placing a walk on the map)', () => {
  it('map pick returns the local point of the click and disarms', () => {
    const { ctl, map, proj, store } = startWithProject();
    const [lng, lat] = proj.toLonLat([12, 0, -34]);
    const onPick = vi.fn();
    ctl.pickPoint(onPick);
    expect(map.canvas.style.cursor).toBe('crosshair');
    expect(map.doubleClickZoom.disable).toHaveBeenCalled();
    map.doubleClickZoom.enable.mockClear();
    const select = vi.spyOn(store.getState(), 'select');
    map.fire('click', click(lng, lat));
    expect(onPick).toHaveBeenCalledTimes(1);
    const local = onPick.mock.calls[0]?.[0] as [number, number, number];
    expect(local[0]).toBeCloseTo(12, 3);
    expect(local[2]).toBeCloseTo(-34, 3);
    expect(select).not.toHaveBeenCalled();
    expect(map.canvas.style.cursor).toBe('');
    expect(map.doubleClickZoom.enable).toHaveBeenCalled();
    // disarmed: the next click is an ordinary one
    map.fire('click', click(lng, lat));
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('Escape cancels the pick, and the returned function disarms it', () => {
    const { ctl, map, proj } = startWithProject();
    const [lng, lat] = proj.toLonLat([1, 0, 1]);
    const onPick = vi.fn();
    const onCancel = vi.fn();
    ctl.pickPoint(onPick, onCancel);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(map.canvas.style.cursor).toBe('');
    map.fire('click', click(lng, lat));
    expect(onPick).not.toHaveBeenCalled();

    const disarm = ctl.pickPoint(onPick, onCancel);
    disarm();
    map.fire('click', click(lng, lat));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onPick).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('map pointer session (placing a walk: hover, click, handles)', () => {
  const ev = (
    proj: { toLonLat(v: [number, number, number]): [number, number] },
    local: [number, number, number],
  ) => {
    const [lng, lat] = proj.toLonLat(local);
    return {
      point: { x: lng * 1e5, y: -lat * 1e5 },
      lngLat: { lng, lat },
      originalEvent: { clientX: 0, clientY: 0, altKey: false },
      preventDefault: vi.fn(),
    };
  };

  it('reports hover points, null when the pointer leaves, and clicks without selecting', () => {
    const { ctl, map, proj, store } = startWithProject();
    const onMove = vi.fn();
    const onClick = vi.fn();
    ctl.pointerSession({ onMove, onClick });
    expect(map.canvas.style.cursor).toBe('crosshair');
    expect(map.doubleClickZoom.disable).toHaveBeenCalled();
    map.fire('mousemove', ev(proj, [12, 0, -34]));
    const moved = onMove.mock.calls[0]?.[0] as [number, number, number];
    expect(moved[0]).toBeCloseTo(12, 3);
    expect(moved[2]).toBeCloseTo(-34, 3);
    map.fire('mouseout');
    expect(onMove).toHaveBeenLastCalledWith(null);
    const select = vi.spyOn(store.getState(), 'select');
    map.fire('click', ev(proj, [1, 0, 2]));
    map.fire('click', ev(proj, [3, 0, 4]));
    // a session stays armed: both clicks are reported, nothing is selected
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(select).not.toHaveBeenCalled();
  });

  it('a press on a handle drags it with panning off; a press elsewhere pans', () => {
    const { ctl, map, proj } = startWithProject();
    const onDrag = vi.fn();
    const onDragEnd = vi.fn();
    const onMove = vi.fn();
    ctl.pointerSession({
      onMove,
      onDrag,
      onDragEnd,
      handles: () => [{ id: 'end', local: [40, 0, -30] }],
    });
    // far from the handle: no drag
    map.fire('mousedown', ev(proj, [0, 0, 0]));
    expect(map.dragPan.disable).not.toHaveBeenCalled();
    map.fire('mouseup', ev(proj, [0, 0, 0]));
    // on the handle
    const down = ev(proj, [40, 0, -30]);
    map.fire('mousedown', down);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(map.dragPan.disable).toHaveBeenCalledTimes(1);
    map.fire('mousemove', ev(proj, [41, 0, -29]));
    expect(onDrag).toHaveBeenCalledWith('end', expect.any(Array));
    expect(onMove).not.toHaveBeenCalled();
    map.fire('mouseup', ev(proj, [41, 0, -29]));
    expect(onDragEnd).toHaveBeenCalledWith('end', expect.any(Array));
    expect(map.dragPan.enable).toHaveBeenCalledTimes(1);
  });

  it('a press on a handle that barely moves is a drag, not a click', () => {
    const { ctl, map, proj } = startWithProject();
    const onClick = vi.fn();
    const onDragEnd = vi.fn();
    ctl.pointerSession({ onClick, onDragEnd, handles: () => [{ id: 'end', local: [40, 0, -30] }] });
    // MapLibre still sends a click after a press that moved less than 3 px
    map.fire('mousedown', ev(proj, [40, 0, -30]));
    map.fire('mouseup', ev(proj, [40, 0, -30]));
    map.fire('click', ev(proj, [40, 0, -30]));
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    // the next ordinary press and click is reported
    map.fire('mousedown', ev(proj, [0, 0, 0]));
    map.fire('mouseup', ev(proj, [0, 0, 0]));
    map.fire('click', ev(proj, [0, 0, 0]));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a release outside the map ends the drag, and Escape cancels and ends it', () => {
    const { ctl, map, proj } = startWithProject();
    const onDragEnd = vi.fn();
    const onCancel = vi.fn();
    ctl.pointerSession({ onDragEnd, onCancel, handles: () => [{ id: 'start', local: [0, 0, 0] }] });
    map.fire('mousedown', ev(proj, [0, 0, 0]));
    window.dispatchEvent(new MouseEvent('mouseup'));
    expect(onDragEnd).toHaveBeenCalledWith('start', null);
    expect(map.dragPan.enable).toHaveBeenCalledTimes(1);
    map.fire('mousedown', ev(proj, [0, 0, 0]));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(map.dragPan.enable).toHaveBeenCalledTimes(2);
  });

  it('an Escape the session takes is marked handled, so no other listener acts on it too', () => {
    const { ctl } = startWithProject();
    const onCancel = vi.fn();
    ctl.pointerSession({ onCancel });
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    window.dispatchEvent(e);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('the returned function and dispose stop the session', () => {
    const { ctl, map, proj } = startWithProject();
    const onClick = vi.fn();
    const stop = ctl.pointerSession({ onClick });
    stop();
    expect(map.canvas.style.cursor).toBe('');
    map.fire('click', ev(proj, [1, 0, 1]));
    expect(onClick).not.toHaveBeenCalled();
    ctl.pointerSession({ onClick });
    ctl.dispose();
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('framing the project while a walk is placed on the map', () => {
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('frames the project when it opens, also with a session that left the camera alone', async () => {
    const { ctl, map } = start();
    ctl.pointerSession({ onClick: vi.fn() });
    openProjectOnLastMap();
    await settle();
    expect(map.getZoom()).toBe(15);
  });

  it('keeps the view the person framed while a session runs', async () => {
    const { ctl, map } = start();
    ctl.pointerSession({ onClick: vi.fn() });
    // the person zooms in before the project's extent is known
    map.jumpTo({ center: [15, 36], zoom: 18 });
    openProjectOnLastMap();
    await settle();
    expect(map.framed).not.toHaveBeenCalled();
    expect(map.getZoom()).toBe(18);
    expect(map.getCenter()).toEqual({ lng: 15, lat: 36 });
  });

  it('without a session the project frames as before', async () => {
    const { map } = start();
    map.jumpTo({ center: [15, 36], zoom: 18 });
    openProjectOnLastMap();
    await settle();
    expect(map.getZoom()).toBe(15);
  });
});
