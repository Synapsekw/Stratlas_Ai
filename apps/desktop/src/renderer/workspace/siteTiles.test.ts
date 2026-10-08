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
});
