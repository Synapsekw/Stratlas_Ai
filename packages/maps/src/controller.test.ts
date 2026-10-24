// @vitest-environment jsdom
import { setActiveScene, type SceneHandle } from '@aio/engine';
import { createWorkspace } from '@aio/workspace';
import { PerspectiveCamera } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapDrawSeam } from './draw';

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
  /** How many times each source's data was set. */
  readonly sets = new Map<string, number>();
  /** Each layer added, with its metadata (rasters carry their project layer id). */
  private readonly layers = new Map<string, unknown>();
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
  /** What each source was added with. */
  readonly specs = new Map<string, Record<string, unknown>>();
  addSource(id: string, spec: Record<string, unknown> = {}): void {
    this.sources.add(id);
    this.specs.set(id, spec);
  }
  getSource(id: string) {
    this.sourceReads++;
    return this.sources.has(id)
      ? {
          setData: (d: unknown) => {
            this.sets.set(id, (this.sets.get(id) ?? 0) + 1);
            const spec = this.specs.get(id);
            if (spec) spec.data = d;
            return Promise.resolve();
          },
        }
      : undefined;
  }
  removeSource(id: string): void {
    this.sources.delete(id);
  }
  readonly addLayer = vi.fn((l: { id: string; metadata?: unknown }): void => {
    this.layers.set(l.id, l.metadata);
  });
  getLayer(id: string) {
    return this.layers.has(id) ? { id, metadata: this.layers.get(id) } : undefined;
  }
  readonly removeLayer = vi.fn((id: string): void => {
    this.layers.delete(id);
  });
  /** The paint properties set after a layer was added, per layer (`raster-opacity` and the like). */
  readonly paint = new Map<string, Record<string, unknown>>();
  setPaintProperty(id: string, name: string, value: unknown): void {
    this.paint.set(id, { ...this.paint.get(id), [name]: value });
  }
  /** The view's lon/lat box, as the pyramid loader reads it. */
  bounds = { west: -180, south: -85, east: 180, north: 85 };
  getBounds() {
    const b = this.bounds;
    return {
      getWest: () => b.west,
      getEast: () => b.east,
      getNorth: () => b.north,
      getSouth: () => b.south,
    };
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
  getBearing(): number {
    return 0;
  }
  getPitch(): number {
    return 0;
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

describe('lined-up dates on the map', () => {
  const ORIGIN: [number, number, number] = [500_000, 4_000_000, 0];
  const corners = { tl: [0, 0, 0], tr: [10, 0, 0], bl: [0, 0, 10] };
  const ortho = (id: string, capture: string) => ({
    kind: 'raster',
    id,
    name: id,
    visible: true,
    src: { path: `${id}.png` },
    format: 'image',
    role: 'ortho',
    corners,
    capture,
  });
  const vector = (id: string, capture?: string) => ({
    kind: 'vector',
    id,
    name: id,
    visible: true,
    src: { path: `${id}.geojson` },
    format: 'geojson',
    style: {},
    ...(capture ? { capture } : {}),
  });
  const manifest = (layers: unknown[], eastM = 2, northM = 0) => ({
    crs: { epsg: 32633 },
    origin: ORIGIN,
    captures: [
      { id: 'd1', label: 'First', date: '2026-01-10' },
      {
        id: 'd2',
        label: 'Second',
        date: '2026-02-10',
        lineUp: { eastM, northM, with: 'd1', at: '2026-10-16T08:00:00Z' },
      },
    ],
    layers,
  });
  const setProject = (
    store: ReturnType<typeof createWorkspace>,
    layers: unknown[],
    eastM = 2,
    northM = 0,
  ) => {
    store.setState({
      project: { id: 'p1', manifest: manifest(layers, eastM, northM) } as unknown as ReturnType<
        typeof store.getState
      >['project'],
    });
  };
  const open = (layers: unknown[], eastM = 2, northM = 0) => {
    const started = start();
    setProject(started.store, layers, eastM, northM);
    return started;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const proj = geo.frameProjection({ epsg: 32633 }, ORIGIN);

  it('places a lined-up ortho quad at the corrected place', async () => {
    if (!proj) throw new Error('projection');
    const { map, ctl } = open([ortho('moved', 'd2'), ortho('still', 'd1')]);
    await flush();
    const coords = (id: string) =>
      (map.specs.get(`aio-raster-${id}-0`)?.coordinates ?? []) as [number, number][];
    const tl = coords('moved')[0];
    const still = coords('still')[0];
    if (!tl || !still) throw new Error('quads');
    const [x] = proj.toLocal(tl[0], tl[1]);
    const [x0] = proj.toLocal(still[0], still[1]);
    expect(x - x0).toBeCloseTo(2, 3);
    ctl.dispose();
  });

  it('keeps a common vector on its URL', async () => {
    const { map, ctl } = open([vector('common'), vector('dated', 'd1')]);
    await flush();
    expect(map.specs.get('aio-ov-layer-common')?.data).toBe('aio://project/p1/common.geojson');
    ctl.dispose();
  });

  it('moves a lined-up vector layer by the shift', async () => {
    if (!proj) throw new Error('projection');
    const at = proj.toLonLat([5, 0, 5]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ type: 'Point', coordinates: at }),
        }),
      ),
    );
    const { map, ctl } = open([vector('moved', 'd2')]);
    await flush();
    await flush();
    const data = map.specs.get('aio-ov-layer-moved')?.data as GeoJSON.FeatureCollection;
    const g = data.features[0]?.geometry;
    if (g?.type !== 'Point') throw new Error('point');
    const [x] = proj.toLocal(g.coordinates[0] ?? 0, g.coordinates[1] ?? 0);
    expect(x).toBeCloseTo(7, 3);
    ctl.dispose();
  });

  const eastNorth = (lon: number, lat: number) => {
    if (!proj) throw new Error('projection');
    const [x, , z] = proj.toLocal(lon, lat);
    return { east: x, north: -z };
  };
  const vectorData = (map: InstanceType<typeof FakeMap>, id: string) =>
    map.specs.get(`aio-ov-layer-${id}`)?.data as GeoJSON.FeatureCollection;
  const pointOf = (fcData: GeoJSON.FeatureCollection) => {
    const g = fcData.features[0]?.geometry;
    if (g?.type !== 'Point') throw new Error('point');
    return eastNorth(g.coordinates[0] ?? 0, g.coordinates[1] ?? 0);
  };
  const deferred = () => {
    let resolve: (v: unknown) => void = () => undefined;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const reply = (at: [number, number]) => ({
    ok: true,
    json: () => Promise.resolve({ type: 'Point', coordinates: at }),
  });
  const quadStart = (map: InstanceType<typeof FakeMap>, id: string) => {
    const c = (map.specs.get(`aio-raster-${id}-0`)?.coordinates ?? []) as [number, number][];
    const p = c[0];
    if (!p) throw new Error('quad');
    return eastNorth(p[0], p[1]);
  };

  it('shows nothing of a lined-up vector before its shifted data arrives', async () => {
    const d = deferred();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => d.promise),
    );
    const { map, ctl } = open([vector('moved', 'd2')]);
    await flush();
    const data = vectorData(map, 'moved');
    expect(data).not.toBe('aio://project/p1/moved.geojson');
    expect(data.features).toEqual([]);
    ctl.dispose();
  });

  it('ends on the current shift when two fetches resolve out of order', async () => {
    if (!proj) throw new Error('projection');
    const at = proj.toLonLat([5, 0, 5]);
    const first = deferred();
    const second = deferred();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal('fetch', fetchMock);
    const { map, store, ctl } = open([vector('moved', 'd2')], 2);
    await flush();
    // the date is lined up again before the first answer comes back
    setProject(store, [vector('moved', 'd2')], 5);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    second.resolve(reply(at));
    await flush();
    first.resolve(reply(at));
    await flush();
    expect(pointOf(vectorData(map, 'moved')).east).toBeCloseTo(10, 3);
    ctl.dispose();
  });

  it('tries a failed vector fetch again on the next sync', async () => {
    if (!proj) throw new Error('projection');
    const at = proj.toLonLat([5, 0, 5]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) })
      .mockResolvedValue(reply(at));
    vi.stubGlobal('fetch', fetchMock);
    const { map, store, ctl } = open([vector('moved', 'd2')]);
    await flush();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(vectorData(map, 'moved').features).toEqual([]);
    store.setState({ hidden: { other: true } });
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pointOf(vectorData(map, 'moved')).east).toBeCloseTo(7, 3);
    warn.mockRestore();
    ctl.dispose();
  });

  it('moves a lined-up vector 1 m south for a negative north shift', async () => {
    if (!proj) throw new Error('projection');
    const at = proj.toLonLat([5, 0, 5]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(reply(at))),
    );
    const { map, ctl } = open([vector('moved', 'd2')], 0, -1);
    await flush();
    await flush();
    const base = eastNorth(at[0], at[1]);
    const moved = pointOf(vectorData(map, 'moved'));
    expect(moved.north - base.north).toBeCloseTo(-1, 3);
    expect(moved.east - base.east).toBeCloseTo(0, 3);
    ctl.dispose();
  });

  it('places a lined-up ortho quad 1 m south for a negative north shift', async () => {
    const { map, ctl } = open([ortho('moved', 'd2'), ortho('still', 'd1')], 0, -1);
    await flush();
    expect(quadStart(map, 'moved').north - quadStart(map, 'still').north).toBeCloseTo(-1, 3);
    ctl.dispose();
  });

  it('draws a lined-up flight path at the corrected place', async () => {
    const samples = [0, 1000, 2000].map((t) => ({ t, pos: [t / 100, 30, 0], q: [0, 0, 0, 1] }));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ samples }) })),
    );
    const flight = (id: string, capture: string) => ({
      kind: 'video',
      id,
      name: id,
      visible: true,
      capture,
      flight: { src: { path: `${id}.json` }, startUtcMs: 0 },
    });
    const { map, ctl } = open([flight('moved', 'd2'), flight('still', 'd1')], 2);
    await flush();
    await flush();
    const data = map.specs.get('aio-flights')?.data as GeoJSON.FeatureCollection;
    const start = (id: string) => {
      const g = data.features.find((f) => f.id === id)?.geometry;
      if (g?.type !== 'LineString') throw new Error('line');
      const p = g.coordinates[0];
      return eastNorth(p?.[0] ?? 0, p?.[1] ?? 0);
    };
    expect(start('moved').east - start('still').east).toBeCloseTo(2, 3);
    ctl.dispose();
  });

  it('places a waiting raster at the corrected place when it is first shown', async () => {
    const plan = (id: string, capture: string) => ({ ...ortho(id, capture), role: 'plan' });
    const { map, store, ctl } = start();
    store.setState({ hidden: { moved: true, still: true } });
    setProject(store, [plan('moved', 'd2'), plan('still', 'd1')], 2);
    await flush();
    expect(map.specs.has('aio-raster-moved-0')).toBe(false);
    store.setState({ hidden: {} });
    await flush();
    expect(quadStart(map, 'moved').east - quadStart(map, 'still').east).toBeCloseTo(2, 3);
    ctl.dispose();
  });
});

const flushTask = () => new Promise((r) => setTimeout(r, 0));
const VIDEO = {
  kind: 'video',
  id: 'v1',
  name: 'v1',
  visible: true,
  lens: { model: 'pinhole', hfovDeg: 70, aspect: 1.7778 },
  flight: { src: { path: 'v1.json' }, startUtcMs: 0 },
};
/** A map with a project of one flight (its samples served by a stubbed fetch). */
async function startWithFlight(samples: { t: number; pos: number[]; q: number[] }[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ samples }) })),
  );
  const started = start();
  started.store.setState({
    project: {
      id: 'p1',
      manifest: {
        crs: { epsg: 32633 },
        origin: [500_000, 4_000_000, 0],
        captures: [],
        layers: [VIDEO],
      },
    } as unknown as ReturnType<typeof started.store.getState>['project'],
  });
  await flushTask();
  await flushTask();
  return started;
}

describe('a map kept alive while hidden (the stage shows only its 3D view)', () => {
  const samples = [0, 1000, 2000].map((t) => ({ t, pos: [t / 100, 30, 0], q: [0, 0, 0, 1] }));

  it('does not follow the workspace while hidden and catches up when shown', async () => {
    const { map, ctl, store } = await startWithFlight(samples);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => frames.push(cb)),
    );
    ctl.setHidden(true);
    const reads = map.sourceReads;
    store.setState({ activeClip: 'v1', nowMs: 1000, selection: null, issues: [] });
    await flushTask();
    expect(frames).toHaveLength(0);
    expect(map.sourceReads).toBe(reads);

    ctl.setHidden(false);
    await new Promise((r) => setTimeout(r, 100));
    for (const f of frames.splice(0)) f(performance.now());
    const drone = map.specs.get('aio-drone')?.data as GeoJSON.FeatureCollection;
    expect(drone.features.some((f) => f.geometry.type === 'Point')).toBe(true);
    ctl.dispose();
  });

  it('stops the 3D view wedge while hidden and redraws it when shown', () => {
    const ticks: (() => void)[] = [];
    const scene = {
      onFrame: (fn: () => void) => {
        ticks.push(fn);
        return () => undefined;
      },
      camera: new PerspectiveCamera(),
    } as unknown as SceneHandle;
    setActiveScene(scene);
    const { map, ctl } = start();
    ctl.setHidden(true);
    const before = map.sets.get('aio-view3d') ?? 0;
    const now = vi.spyOn(performance, 'now').mockReturnValue(1e9);
    for (const t of ticks) t();
    expect(map.sets.get('aio-view3d') ?? 0).toBe(before);
    ctl.setHidden(false);
    expect(map.sets.get('aio-view3d') ?? 0).toBe(before + 1);
    now.mockRestore();
    ctl.dispose();
  });
});

describe('the drone overlay during playback', () => {
  it('redraws at most about 15 times a second, and not when nothing moved', async () => {
    const samples = [0, 10_000].map((t) => ({ t, pos: [t / 100, 30, 0], q: [0, 0, 0, 1] }));
    const { map, ctl, store } = await startWithFlight(samples);
    vi.useFakeTimers();
    try {
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
        setTimeout(() => {
          cb(performance.now());
        }, 7),
      );
      vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        clearTimeout(id);
      });
      store.setState({ activeClip: 'v1' });
      vi.advanceTimersByTime(200);
      const start0 = map.sets.get('aio-drone') ?? 0;
      // one second of playback at 144 Hz
      for (let i = 1; i <= 144; i++) {
        store.setState({ nowMs: i * 7 });
        vi.advanceTimersByTime(7);
      }
      vi.advanceTimersByTime(200);
      const played = (map.sets.get('aio-drone') ?? 0) - start0;
      expect(played).toBeGreaterThan(5);
      expect(played).toBeLessThanOrEqual(17);
      // the last position is drawn
      const drone = map.specs.get('aio-drone')?.data as GeoJSON.FeatureCollection;
      const pt = drone.features.find((f) => f.geometry.type === 'Point')?.geometry;
      if (pt?.type !== 'Point') throw new Error('no drone point');
      const last = geo
        .frameProjection({ epsg: 32633 }, [500_000, 4_000_000, 0])
        ?.toLonLat([10.08, 30, 0]);
      expect(pt.coordinates[0]).toBeCloseTo(last?.[0] ?? 0, 6);
      // a state change that does not move the drone does not redraw it
      const settled = map.sets.get('aio-drone') ?? 0;
      store.setState({ hidden: {} });
      vi.advanceTimersByTime(200);
      expect(map.sets.get('aio-drone') ?? 0).toBe(settled);
    } finally {
      vi.useRealTimers();
      ctl.dispose();
    }
  });
  it('draws where the full-rate clock is, and lands on the exact time on pause', async () => {
    const samples = [0, 10_000].map((t) => ({ t, pos: [t / 100, 30, 0], q: [0, 0, 0, 1] }));
    const { map, ctl, store } = await startWithFlight(samples);
    const lonAt = (x: number) =>
      geo.frameProjection({ epsg: 32633 }, [500_000, 4_000_000, 0])?.toLonLat([x, 30, 0])[0] ?? 0;
    const droneLon = () => {
      const drone = map.specs.get('aio-drone')?.data as GeoJSON.FeatureCollection;
      const pt = drone.features.find((f) => f.geometry.type === 'Point')?.geometry;
      if (pt?.type !== 'Point') throw new Error('no drone point');
      return pt.coordinates[0] ?? 0;
    };
    vi.useFakeTimers();
    try {
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
        setTimeout(() => {
          cb(performance.now());
        }, 7),
      );
      vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        clearTimeout(id);
      });
      store.setState({ activeClip: 'v1' });
      store.getState().play();
      vi.advanceTimersByTime(200);
      // playback frames: the workspace's nowMs follows only every COMMIT_MS of clip time
      for (let i = 1; i <= 98; i++) {
        store.getState().tick(i * 7);
        vi.advanceTimersByTime(7);
      }
      vi.advanceTimersByTime(200);
      const committed = store.getState().nowMs;
      expect(committed).toBeLessThan(686);
      // the last redraw read the clock: ahead of what the workspace last committed
      expect(droneLon()).toBeGreaterThan(lonAt(committed / 100) + 1e-7);
      expect(droneLon()).toBeLessThanOrEqual(lonAt(6.86) + 1e-9);
      store.getState().tick(703);
      store.getState().pause();
      vi.advanceTimersByTime(200);
      expect(store.getState().nowMs).toBe(703);
      expect(droneLon()).toBeCloseTo(lonAt(7.03), 6);
      // a seek while paused lands exactly too
      store.getState().setTime(4321);
      vi.advanceTimersByTime(200);
      expect(droneLon()).toBeCloseTo(lonAt(43.21), 6);
    } finally {
      vi.useRealTimers();
      ctl.dispose();
    }
  });
});

describe('the draw preview', () => {
  it('is sent to the map only when it changes (the stage hands a new seam on every render)', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const at = (mode: MapDrawSeam['mode'], vertices: MapDrawSeam['vertices']): MapDrawSeam => ({
      mode,
      vertices,
      onClick: () => undefined,
      onFinish: () => undefined,
    });
    let seam = at(null, []);
    const ctl = createMapController(el, {
      packs: [],
      store: createWorkspace(),
      showFlights: true,
      draw: () => seam,
    });
    const map = FakeMap.last;
    if (!map) throw new Error('no map');
    map.fire('load');
    const sent = () => map.sets.get('aio-draw') ?? 0;
    const start0 = sent();
    for (let i = 0; i < 10; i++) {
      seam = at(null, []);
      ctl.updateDraw();
    }
    expect(sent()).toBe(start0);
    seam = at('polygon', [
      [15, 36],
      [15.001, 36],
    ]);
    ctl.updateDraw();
    ctl.updateDraw();
    expect(sent()).toBe(start0 + 1);
    seam = at(null, []);
    ctl.updateDraw();
    expect(sent()).toBe(start0 + 2);
    ctl.dispose();
  });
});

describe('vector layer overlays on a layer toggle', () => {
  it('switches visibility in place instead of removing and adding the layers again', async () => {
    const { map, ctl, store } = start();
    store.setState({
      project: {
        id: 'p1',
        manifest: {
          crs: { epsg: 32633 },
          origin: [500_000, 4_000_000, 0],
          captures: [],
          layers: [
            {
              kind: 'vector',
              id: 'roads',
              name: 'roads',
              visible: true,
              src: { path: 'roads.geojson' },
              format: 'geojson',
              style: { line: { color: '#fff', width: 2 } },
            },
          ],
        },
      } as unknown as ReturnType<typeof store.getState>['project'],
    });
    await flushTask();
    expect(map.getLayer('aio-ov-layer-roads-line')).toBeTruthy();
    map.addLayer.mockClear();
    map.removeLayer.mockClear();
    const sets = map.sets.get('aio-ov-layer-roads') ?? 0;
    store.setState({ hidden: { roads: true } });
    expect(map.layout.get('aio-ov-layer-roads-line')?.visibility).toBe('none');
    store.setState({ hidden: {} });
    expect(map.layout.get('aio-ov-layer-roads-line')?.visibility).toBe('visible');
    expect(map.removeLayer).not.toHaveBeenCalled();
    expect(map.addLayer).not.toHaveBeenCalled();
    expect(map.sets.get('aio-ov-layer-roads') ?? 0).toBe(sets);
    ctl.dispose();
  });
});

describe('raster blend (the timelapse crossfade between two dated orthos)', () => {
  const ORIGIN: [number, number, number] = [500_000, 4_000_000, 0];
  const corners = { tl: [0, 0, 0], tr: [100, 0, 0], bl: [0, 0, 100] };
  const ortho = (id: string, capture: string, format: 'image' | 'kit-pyramid' = 'image') => ({
    kind: 'raster',
    id,
    name: id,
    visible: true,
    src: { path: format === 'image' ? `${id}.png` : `${id}/tiles.json` },
    format,
    role: 'ortho',
    corners,
    capture,
  });
  const open = (layers: unknown[], hidden: Record<string, true>) => {
    const started = start();
    started.store.setState({
      hidden,
      project: {
        id: 'p1',
        manifest: {
          crs: { epsg: 32633 },
          origin: ORIGIN,
          captures: [
            { id: 'd1', label: 'First', date: '2026-01-10' },
            { id: 'd2', label: 'Second', date: '2026-02-10' },
          ],
          layers,
        },
      } as unknown as ReturnType<typeof started.store.getState>['project'],
    });
    return started;
  };
  /** The opacity a map layer draws at: the last one set, else the one it was added with. */
  const opacity = (map: FakeMap, sid: string): unknown => {
    const set = map.paint.get(sid)?.['raster-opacity'];
    if (set !== undefined) return set;
    const added = map.addLayer.mock.calls.find(([l]) => l.id === sid)?.[0] as
      { paint?: Record<string, unknown> } | undefined;
    return added?.paint?.['raster-opacity'];
  };
  const visibility = (map: FakeMap, sid: string) => map.layout.get(sid)?.visibility;

  it('blend shows a hidden layer with the given opacity', async () => {
    const { map, store, ctl } = open([ortho('a', 'd1'), ortho('b', 'd2')], { b: true });
    await flushTask();
    expect(visibility(map, 'aio-raster-b-0')).toBe('none');
    ctl.setRasterBlend([
      { layerId: 'a', opacity: 0.45 },
      { layerId: 'b', opacity: 0.55 },
    ]);
    expect(visibility(map, 'aio-raster-a-0')).toBe('visible');
    expect(visibility(map, 'aio-raster-b-0')).toBe('visible');
    expect(opacity(map, 'aio-raster-a-0')).toBe(0.45);
    expect(opacity(map, 'aio-raster-b-0')).toBe(0.55);
    // a later step of the blend only moves the opacities
    ctl.setRasterBlend([
      { layerId: 'a', opacity: 0.2 },
      { layerId: 'b', opacity: 0.8 },
    ]);
    expect(opacity(map, 'aio-raster-b-0')).toBe(0.8);
    // a workspace change while blending keeps the blended layer shown
    store.setState({ hidden: { b: true, other: true } });
    expect(visibility(map, 'aio-raster-b-0')).toBe('visible');
    ctl.dispose();
  });

  it('null restores visibility and opacity', async () => {
    const { map, ctl } = open([ortho('a', 'd1'), ortho('b', 'd2')], { b: true });
    await flushTask();
    ctl.setRasterBlend([
      { layerId: 'a', opacity: 0.3 },
      { layerId: 'b', opacity: 0.7 },
    ]);
    ctl.setRasterBlend(null);
    expect(visibility(map, 'aio-raster-a-0')).toBe('visible');
    expect(visibility(map, 'aio-raster-b-0')).toBe('none');
    expect(opacity(map, 'aio-raster-a-0')).toBe(0.95);
    expect(opacity(map, 'aio-raster-b-0')).toBe(0.95);
    ctl.dispose();
  });

  it('a blended hidden layer loads its pyramid tiles', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              levels: [
                { z: 0, tileSize: 256, cols: 1, rows: 1, pattern: 'b/{z}/{x}/{y}.png' },
                { z: 1, tileSize: 256, cols: 8, rows: 8, pattern: 'b/{z}/{x}/{y}.png' },
              ],
            }),
        }),
      ),
    );
    const proj = geo.frameProjection({ epsg: 32633 }, ORIGIN);
    if (!proj) throw new Error('projection');
    const { map, ctl } = open([ortho('b', 'd2', 'kit-pyramid')], { b: true });
    await flushTask();
    await flushTask();
    // a close view over the middle of the survey: the fine level's tiles are wanted
    const [west, north] = proj.toLonLat([40, 0, 40]);
    const [east, south] = proj.toLonLat([60, 0, 60]);
    map.bounds = { west, south, east, north };
    map.center = { lng: (west + east) / 2, lat: (north + south) / 2 };
    map.zoom = 20;
    map.fire('moveend');
    const fineTiles = () =>
      [...map.specs.keys()].filter((k) => k.startsWith('aio-pyr-b-1-') && map.getSource(k));
    expect(fineTiles()).toEqual([]);
    ctl.setRasterBlend([{ layerId: 'b', opacity: 0.6 }]);
    expect(fineTiles().length).toBeGreaterThan(0);
    for (const sid of fineTiles()) expect(opacity(map, sid)).toBe(0.6);
    ctl.setRasterBlend(null);
    expect(fineTiles()).toEqual([]);
    ctl.dispose();
  });
});
