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
      invoke: vi.fn((channel: string, req: { on?: boolean }) => {
        if (channel === 'onlineTiles:setSatellite') {
          asked.push(req);
          // the layer must not be on before main has answered
          expect(rasterPacks.getState().prefs.onlineSatellite).toBe(stored);
          stored = req.on === true;
          return Promise.resolve({ ok: true, satellite: stored });
        }
        if (channel === 'onlineTiles:status')
          return Promise.resolve({
            satellite: stored,
            cache: { bytes: 0, tiles: 0, capBytes: 1 },
          });
        // the app's settings carry no such switch: only main's own answer counts
        if (channel === 'settings:get') return Promise.resolve({ onlineSatellite: !stored });
        return Promise.resolve({ ok: true, packs: [] });
      }),
    };
    expect(await rasterPacks.getState().setOnlineSatellite(true)).toBeNull();
    expect(asked).toEqual([{ on: true }]);
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
});
