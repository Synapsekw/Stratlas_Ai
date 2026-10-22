import { describe, expect, it, vi } from 'vitest';
import { cropJpeg, type CropIo } from './crop';

function stub(width: number, height: number) {
  const calls: { sx: number; sy: number; sw: number; sh: number; w: number; h: number }[] = [];
  const io: CropIo = {
    load: () => Promise.resolve({ width, height, source: 'img' }),
    render: (_src, sx, sy, sw, sh, w, h) => {
      calls.push({ sx, sy, sw, sh, w, h });
      return Promise.resolve('BASE64');
    },
  };
  return { io, calls };
}

describe('cropJpeg', () => {
  it('crops with padding, clamps at the photo edge and fits within 512 px', async () => {
    // padded by 15% of the box on every side
    const a = stub(4000, 3000);
    expect(await cropJpeg('u', [1000, 1000, 1200, 1100], 512, 0.15, { io: a.io })).toBe('BASE64');
    expect(a.calls[0]).toEqual({ sx: 970, sy: 985, sw: 260, sh: 130, w: 260, h: 130 });
    // clamped at the top-left corner of the photo
    const b = stub(4000, 3000);
    await cropJpeg('u', [0, 10, 100, 110], 512, 0.15, { io: b.io });
    expect(b.calls[0]).toMatchObject({ sx: 0, sy: 0, sw: 115, sh: 125 });
    // clamped at the bottom-right edge
    const c = stub(500, 400);
    await cropJpeg('u', [450, 350, 500, 400], 512, 0.15, { io: c.io });
    expect(c.calls[0]).toMatchObject({ sx: 442.5, sy: 342.5, sw: 57.5, sh: 57.5 });
    // a large box is scaled down so its longest side is 512 px
    const d = stub(4000, 3000);
    await cropJpeg('u', [0, 0, 2000, 1000], 512, 0, { io: d.io });
    expect(d.calls[0]).toMatchObject({ sw: 2000, sh: 1000, w: 512, h: 256 });
  });

  it('rejects when the photo cannot be loaded', async () => {
    const io: CropIo = {
      load: () => Promise.reject(new Error('no photo')),
      render: () => Promise.resolve(''),
    };
    await expect(cropJpeg('u', [0, 0, 10, 10], 512, 0.15, { io })).rejects.toThrow('no photo');
  });

  it('scales a box from its own grid to the natural size of the photo', async () => {
    const a = stub(4000, 3000);
    await cropJpeg('u', [100, 100, 200, 150], 512, 0, { io: a.io, grid: [2000, 1500] });
    expect(a.calls[0]).toMatchObject({ sx: 200, sy: 200, sw: 200, sh: 100 });
  });

  it('runs at most two crops at once and decodes a photo once', async () => {
    let running = 0;
    let peak = 0;
    let loads = 0;
    const release: (() => void)[] = [];
    const io: CropIo = {
      load: () => {
        loads++;
        return Promise.resolve({ width: 100, height: 100, source: 'img' });
      },
      render: () => {
        running++;
        peak = Math.max(peak, running);
        return new Promise<string>((done) => {
          release.push(() => {
            running--;
            done('B');
          });
        });
      },
    };
    const all = Promise.all(
      [0, 1, 2, 3, 4].map((i) => cropJpeg('same', [i, i, i + 10, i + 10], 512, 0.15, { io })),
    );
    for (let n = 0; n < 5; n++) {
      await vi.waitFor(() => {
        expect(release.length).toBeGreaterThan(n);
      });
      expect(running).toBeLessThanOrEqual(2);
      release[n]?.();
    }
    expect(await all).toEqual(['B', 'B', 'B', 'B', 'B']);
    expect(peak).toBe(2);
    expect(loads).toBe(1);
  });
});
