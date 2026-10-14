// @vitest-environment jsdom
import type { RasterPackInfo } from '@aio/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groundLevel } from './siteBasemap';
import { rasterPacks, sceneOnline, showSurroundings, unchanged } from './siteTiles';

const pack = (id: string): RasterPackInfo =>
  ({
    id,
    kind: 'imagery',
    label: id,
    bbox: [50, 28, 51, 29],
    minZoom: 10,
    maxZoom: 17,
    tileSize: 256,
    attribution: 'E2E',
    licence: 'CC0-1.0',
  }) as unknown as RasterPackInfo;

const g = globalThis as { aio?: unknown };

afterEach(() => {
  delete g.aio;
});

describe('raster packs store', () => {
  it('keeps the current list when a refresh lists the same packs', () => {
    const a = [pack('one')];
    expect(unchanged(a, [pack('one')])).toBe(a);
    const b = [pack('one'), pack('two')];
    expect(unchanged(a, b)).toBe(b);
  });

  it('a refresh with nothing new bumps rev but keeps the arrays (the map keeps its layers)', async () => {
    const invoke = vi.fn((channel: string) =>
      Promise.resolve({ ok: true, packs: channel === 'imageryPacks:list' ? [pack('one')] : [] }),
    );
    g.aio = { invoke };
    rasterPacks.getState().refresh();
    await vi.waitFor(() => {
      expect(rasterPacks.getState().imagery).toHaveLength(1);
    });
    const first = rasterPacks.getState();
    rasterPacks.getState().refresh();
    await vi.waitFor(() => {
      expect(rasterPacks.getState().rev).toBe(first.rev + 1);
    });
    expect(rasterPacks.getState().imagery).toBe(first.imagery);
    expect(rasterPacks.getState().terrain).toBe(first.terrain);
  });

  it('online satellite is off until main says otherwise, and asks main before it draws', async () => {
    expect(rasterPacks.getState().prefs.onlineSatellite).toBe(false);
    const asked: unknown[] = [];
    let stored = false;
    g.aio = {
      invoke: vi.fn((channel: string, req: { enabled?: boolean }) => {
        if (channel === 'onlineTiles:set') {
          asked.push(req);
          // the layer must not be on before main has answered
          expect(rasterPacks.getState().prefs.onlineSatellite).toBe(stored);
          stored = req.enabled === true;
          return Promise.resolve({ ok: true, enabled: stored, source: 'esri-world-imagery' });
        }
        if (channel === 'onlineTiles:status')
          return Promise.resolve({
            enabled: stored,
            source: 'esri-world-imagery',
            cache: { bytes: 0, tiles: 0, capBytes: 1 },
          });
        // the app's settings carry no such switch: only main's own answer counts
        if (channel === 'settings:get') return Promise.resolve({ onlineSatellite: !stored });
        return Promise.resolve({ ok: true, packs: [] });
      }),
    };
    expect(await rasterPacks.getState().setOnline({ enabled: true })).toBeNull();
    expect(asked).toEqual([{ enabled: true }]);
    expect(rasterPacks.getState().prefs.onlineSatellite).toBe(true);

    // main is the one that decides: a refresh follows what it has stored
    stored = false;
    rasterPacks.getState().refresh();
    await vi.waitFor(() => {
      expect(rasterPacks.getState().prefs.onlineSatellite).toBe(false);
    });
    stored = true;
    rasterPacks.getState().refresh();
    await vi.waitFor(() => {
      expect(rasterPacks.getState().prefs.onlineSatellite).toBe(true);
    });
    expect(await rasterPacks.getState().setOnline({ enabled: false })).toBeNull();
    expect(rasterPacks.getState().prefs.onlineSatellite).toBe(false);
  });

  it('online satellite stays off when main refuses the change', async () => {
    g.aio = {
      invoke: vi.fn(() =>
        Promise.resolve({ ok: false, error: 'The online satellite setting was not saved.' }),
      ),
    };
    expect(await rasterPacks.getState().setOnline({ enabled: true })).toBe(
      'The online satellite setting was not saved.',
    );
    expect(rasterPacks.getState().prefs.onlineSatellite).toBe(false);
    g.aio = { invoke: vi.fn(() => Promise.reject(new Error('No answer.'))) };
    expect(await rasterPacks.getState().setOnline({ enabled: true })).toBe('No answer.');
    expect(rasterPacks.getState().prefs.onlineSatellite).toBe(false);
  });
  it('a session-only switch shows on the map but is never stored; a choice stores what was chosen', () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => stored.set(k, v),
    });
    try {
      const saved = () =>
        JSON.parse(stored.get('stratlas.rasterPacks') ?? '{}') as Record<string, unknown>;
      rasterPacks.getState().set({ satellite: false, streets: true });
      rasterPacks.getState().setForSession({ satellite: true });
      expect(rasterPacks.getState().prefs.satellite).toBe(true);
      // quit now: the next start reads Streets
      expect(saved().satellite).toBe(false);
      // another choice stores only itself, not the session's switch
      rasterPacks.getState().set({ hillshade: false });
      expect(saved()).toMatchObject({ satellite: false, hillshade: false });
      expect(rasterPacks.getState().prefs).toMatchObject({ satellite: true, hillshade: false });
      // a choice of map type is the person's: stored, and counted (Place walk then leaves it)
      const before = rasterPacks.getState().chosen;
      rasterPacks.getState().setForSession({ satellite: false });
      rasterPacks.getState().set({ hillshade: true });
      expect(rasterPacks.getState().chosen).toBe(before);
      rasterPacks.getState().set({ satellite: true, streets: false });
      expect(rasterPacks.getState().chosen).toBe(before + 1);
      expect(saved()).toMatchObject({ satellite: true, streets: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads the source and which map keys this computer holds on refresh', async () => {
    g.aio = {
      invoke: vi.fn((channel: string) => {
        if (channel === 'onlineTiles:status')
          return Promise.resolve({
            enabled: true,
            source: 'mapbox-satellite',
            cache: { bytes: 0, tiles: 0, capBytes: 1 },
          });
        if (channel === 'mapKeys:status') return Promise.resolve({ esri: false, mapbox: true });
        return Promise.resolve({ ok: true, packs: [] });
      }),
    };
    rasterPacks.getState().refresh();
    await vi.waitFor(() => {
      expect(rasterPacks.getState().online).toEqual({
        source: 'mapbox-satellite',
        keys: { esri: false, mapbox: true },
      });
    });
  });

  it('keeps the base maps chosen in the Map menus', () => {
    rasterPacks.getState().set({ mapBase: 'esri-world-imagery', sceneBase: 'mapbox-dark' });
    expect(JSON.parse(localStorage.getItem('stratlas.rasterPacks') ?? '{}')).toMatchObject({
      mapBase: 'esri-world-imagery',
      sceneBase: 'mapbox-dark',
    });
  });
});

describe('the online map of the 3D scene', () => {
  const NO_KEYS = { esri: false, mapbox: false };

  it('is the picked source when main can serve it', () => {
    expect(
      sceneOnline(
        { sceneBase: 'esri-world-imagery', onlineSatellite: true },
        { keys: NO_KEYS },
        false,
      ),
    ).toBe('esri-world-imagery');
  });

  it('offline-only: none, so the street map stays (no fallback to saved Sentinel-2)', () => {
    expect(
      sceneOnline(
        { sceneBase: 'esri-world-imagery', onlineSatellite: true },
        { keys: NO_KEYS },
        true,
      ),
    ).toBeNull();
    expect(
      sceneOnline({ sceneBase: 'mapbox-dark', onlineSatellite: true }, { keys: NO_KEYS }, false),
    ).toBeNull();
  });
});

describe('the landscape around the site in the scene', () => {
  interface Obj {
    position: { y: number };
    userData: Record<string, unknown>;
    updateMatrixWorld(): void;
  }
  const landscape = (flat: boolean): Obj => ({
    position: { y: 0 },
    userData: { flat, dropM: 0.3 },
    updateMatrixWorld: () => undefined,
  });
  function fakeStage() {
    const inScene = new Set<unknown>();
    const targets = new Map<unknown, string>();
    const stage = {
      scene: {
        add: (o: unknown) => inScene.add(o),
        remove: (o: unknown) => inScene.delete(o),
      },
      addRaycastTarget(o: unknown, id: string) {
        targets.set(o, id);
        return () => targets.delete(o);
      },
      requestRender: vi.fn(),
    };
    return { stage, inScene, targets };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stands in for the plain ground, which would otherwise cover it', () => {
    const { stage, inScene, targets } = fakeStage();
    const mesh = landscape(false);
    const remove = showSurroundings(stage as never, mesh, () => null);
    expect(inScene.has(mesh)).toBe(true);
    // the stage hides its plain ground (y = 0, over the landscape) while a ground target shows
    expect(targets.get(mesh)).toBe('site-surroundings');
    expect(mesh.userData.aioGround).toBe(true);
    // a landscape that follows the terrain keeps its own heights
    expect(mesh.position.y).toBe(0);
    remove();
    expect(inScene.has(mesh)).toBe(false);
    expect(targets.size).toBe(0);
  });

  it('lays a flat one (an online map, imagery without terrain) under the lowest model, as the street map', () => {
    vi.useFakeTimers();
    const { stage } = fakeStage();
    const mesh = landscape(true);
    let floor: number | null = null;
    const remove = showSurroundings(stage as never, mesh, () => floor);
    // nothing under the origin: just under it, where the street map lies
    expect(mesh.position.y - 0.3).toBeCloseTo(groundLevel(null), 6);
    expect(groundLevel(null)).toBeCloseTo(-0.4, 6);
    expect(groundLevel(5)).toBe(-0.25);
    // a model that runs 12 m under the origin (a slope, a pit) loads: the picture goes under it,
    // instead of cutting through it at the origin's height
    floor = -12;
    vi.advanceTimersByTime(1500);
    expect(mesh.position.y - 0.3).toBeCloseTo(groundLevel(-12), 6);
    expect(groundLevel(-12)).toBeCloseTo(-12.4, 6);
    remove();
    floor = -40;
    vi.advanceTimersByTime(3000);
    expect(mesh.position.y - 0.3).toBeCloseTo(-12.4, 6);
  });
});
