// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
import type * as EngineModule from '@aio/engine';
import type { PointSelection } from '@aio/engine';
import type * as PointcloudModule from '@aio/pointcloud';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StoreModule from './antennaStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  tools: [] as { opts: { onClose(sel: PointSelection): void; onCancel(): void }; off: number }[],
  points: new Float32Array(0),
  hit: null as { point: { x: number; y: number; z: number }; object: object } | null,
  removed: 0,
  drawn: [] as Float32Array[],
  layers: [] as (string | undefined)[],
}));

const stage = {
  camera: { position: { x: 0, y: 0, z: 0 } },
  raycast: vi.fn(() => h.hit),
};

vi.mock('@aio/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof EngineModule>()),
  getActiveStage: () => stage,
  PolygonClickTool: class {
    constructor(_stage: unknown, opts: (typeof h.tools)[number]['opts']) {
      h.tools.push({ opts, off: 0 });
    }
    attach() {
      const entry = h.tools[h.tools.length - 1]!;
      return () => {
        entry.off++;
      };
    }
  },
}));
vi.mock('@aio/pointcloud', async (importOriginal) => ({
  ...(await importOriginal<typeof PointcloudModule>()),
  collectDrawn: (_handle: unknown, layer: string) => {
    h.layers.push(layer);
    return h.points;
  },
}));
vi.mock('../pointcloud/cleanupScene', () => ({ selectionTest: () => () => true }));
vi.mock('./AntennaRunner', () => ({
  useAntennaClouds: () => [
    { id: 'cloud-old', kind: 'pointcloud', visible: true },
    { id: 'cloud-new', kind: 'pointcloud', visible: true },
    { id: 'cloud-hidden', kind: 'pointcloud', visible: false },
  ],
}));
vi.mock('./flagScene', () => ({
  drawFlagPoints: (_stage: unknown, pts: Float32Array) => {
    h.drawn.push(pts);
    return () => {
      h.removed++;
    };
  },
}));
vi.mock('./antennaStore', async (importOriginal) => ({
  ...(await importOriginal<typeof StoreModule>()),
  startFlag: vi.fn(() => Promise.resolve()),
  endFlag: vi.fn(),
}));

const { AntennaFlagTool } = await import('./AntennaFlagTool');
const { antennaStore, endFlag, startFlag } = await import('./antennaStore');

const SEL: PointSelection = {
  shape: 'lasso',
  polygon: [
    [-0.1, -0.1],
    [0.1, -0.1],
    [0.1, 0.1],
  ],
  viewProj: Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0)),
};
/** `n` points 10 m from the eye, a centimetre apart: one surface. */
function surface(n: number) {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) out.set([i * 0.01, 0, -10], i * 3);
  return out;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.tools = [];
  h.points = new Float32Array(0);
  h.hit = null;
  h.removed = 0;
  h.drawn = [];
  h.layers = [];
  vi.mocked(startFlag).mockClear();
  vi.mocked(endFlag).mockClear();
  antennaStore.setState({ cloudLayer: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(<AntennaFlagTool />);
  });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (el: Element) => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const closeOutline = () => {
  act(() => {
    h.tools[h.tools.length - 1]!.opts.onClose(SEL);
  });
};

describe('AntennaFlagTool', () => {
  it('arms the outline tool and shows the drawing hint', () => {
    expect(h.tools).toHaveLength(1);
    expect(q('antenna-flag-hint')?.textContent).toContain('Click around the unit');
    expect(q('antenna-flag-bar')).toBeNull();
  });

  it('the flag tool shows the kept count and sends the selection on Measure', () => {
    h.points = surface(12);
    closeOutline();
    // the tool is put away while the person looks at the result
    expect(h.tools[0]!.off).toBe(1);
    expect(h.layers).toEqual(['cloud-new']);
    expect(q('antenna-flag-hint')).toBeNull();
    expect(q('antenna-flag-bar')?.textContent).toContain('12 points kept, nearest the camera.');
    expect(h.drawn[0]).toHaveLength(36);
    click(q('antenna-flag-confirm')!);
    expect(startFlag).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(startFlag).mock.calls[0]![0];
    expect(arg.layer).toBe('cloud-new');
    expect(arg.sel).toBe(SEL);
    expect(arg.bounds.min[2]).toBeCloseTo(-10.1);
    expect(arg.bounds.max[0]).toBeCloseTo(0.21);
    expect(arg.anchor[0]).toBeCloseTo(0.055);
  });

  it('uses the layer detection was set to', () => {
    act(() => {
      antennaStore.setState({ cloudLayer: 'cloud-old' });
    });
    h.points = surface(12);
    closeOutline();
    expect(h.layers).toEqual(['cloud-old']);
  });

  it('with no points kept, places at the raycast and says so', () => {
    h.hit = { point: { x: 1, y: 2, z: 3 }, object: {} };
    closeOutline();
    expect(stage.raycast).toHaveBeenLastCalledWith(
      expect.closeTo(0.1 / 3, 5),
      expect.closeTo(-0.1 / 3, 5),
    );
    expect(q('antenna-flag-bar')?.textContent).toContain('No cloud points inside the outline.');
    click(q('antenna-flag-confirm')!);
    expect(vi.mocked(startFlag).mock.calls[0]![0].anchor).toEqual([1, 2, 3]);
  });

  it('disables Measure off the cloud', () => {
    closeOutline();
    const b = q('antenna-flag-confirm')!;
    expect(b.getAttribute('aria-disabled')).toBe('true');
    const id = b.getAttribute('aria-describedby');
    expect(host.querySelector(`[id="${id ?? ''}"]`)?.textContent).toBe(
      'Draw the outline over the cloud.',
    );
    click(b);
    expect(startFlag).not.toHaveBeenCalled();
  });

  it('Draw again removes the highlight and re-arms the tool', () => {
    h.points = surface(12);
    closeOutline();
    click(q('antenna-flag-again')!);
    expect(h.removed).toBe(1);
    expect(h.tools).toHaveLength(2);
    expect(q('antenna-flag-hint')).not.toBeNull();
    expect(endFlag).not.toHaveBeenCalled();
  });

  it('Cancel ends the tool and removes the highlight', () => {
    h.points = surface(12);
    closeOutline();
    click(q('antenna-flag-cancel')!);
    expect(endFlag).toHaveBeenCalledTimes(1);
    expect(h.removed).toBe(1);
  });

  it('Escape while drawing ends the tool', () => {
    act(() => {
      h.tools[0]!.opts.onCancel();
    });
    expect(endFlag).toHaveBeenCalledTimes(1);
  });

  it('unmounting disarms the tool', () => {
    act(() => {
      root.unmount();
    });
    expect(h.tools[0]!.off).toBe(1);
    root = createRoot(host);
  });
});
