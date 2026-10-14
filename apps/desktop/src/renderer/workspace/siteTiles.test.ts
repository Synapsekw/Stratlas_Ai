import type { RasterPackInfo } from '@aio/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rasterPacks, unchanged } from './siteTiles';

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
    expect(await rasterPacks.getState().setOnlineSatellite(true)).toBeNull();
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
    expect(await rasterPacks.getState().setOnlineSatellite(false)).toBeNull();
    expect(rasterPacks.getState().prefs.onlineSatellite).toBe(false);
  });

  it('online satellite stays off when main refuses the change', async () => {
    g.aio = {
      invoke: vi.fn(() =>
        Promise.resolve({ ok: false, error: 'The online satellite setting was not saved.' }),
      ),
    };
    expect(await rasterPacks.getState().setOnlineSatellite(true)).toBe(
      'The online satellite setting was not saved.',
    );
    expect(rasterPacks.getState().prefs.onlineSatellite).toBe(false);
    g.aio = { invoke: vi.fn(() => Promise.reject(new Error('No answer.'))) };
    expect(await rasterPacks.getState().setOnlineSatellite(true)).toBe('No answer.');
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
});
