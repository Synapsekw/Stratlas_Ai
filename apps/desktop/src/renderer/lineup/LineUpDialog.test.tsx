// @vitest-environment jsdom
import { createWorkspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LineUpDialog, type LineUpImage } from './LineUpDialog';
import { createLineUpMemory } from './lineUpMemory';
import { createLineUpStore } from './lineUpStore';
import { fitOf, lineUpManifest, measureOf } from './testing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
/** What the canvas was asked to draw, image by image: the top-left corner on the canvas, and the transform. */
const drawn: { image: unknown; x: number; y: number; w: number; h: number; m: Mat }[] = [];
let current: Mat = IDENTITY;
const saved: Mat[] = [];
const ctx = {
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  save: vi.fn(() => {
    saved.push(current);
  }),
  restore: vi.fn(() => {
    current = saved.pop() ?? IDENTITY;
  }),
  setTransform: vi.fn((a: number, b: number, c: number, d: number, e: number, f: number) => {
    current = [a, b, c, d, e, f];
  }),
  beginPath: vi.fn(),
  rect: vi.fn(),
  clip: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  drawImage: vi.fn((image: unknown, x: number, y: number, w: number, h: number) => {
    const [a, b, c, d, e, f] = current;
    drawn.push({ image, x: a * x + c * y + e, y: b * x + d * y + f, w, h, m: current });
  }),
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
};

const keepImage = { name: 'o1' };
const moveImage = { name: 'o2' };
const preview = (layerId: string): Promise<LineUpImage | null> =>
  Promise.resolve({
    image: (layerId === 'o1' ? keepImage : moveImage) as unknown as CanvasImageSource,
    box: { minX: 0, maxX: 100, minZ: 0, maxZ: 50 },
  });

function setup(measure = measureOf(), manifest = lineUpManifest()) {
  const workspace = createWorkspace();
  workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest });
  const store = createLineUpStore({
    workspace,
    measure: () => Promise.resolve(measure),
    saveCapture: () => Promise.resolve(null),
    pinCaptures: () => Promise.resolve(null),
    hints: () => ({}),
    issues: () => [],
    measurements: () => [],
    memory: createLineUpMemory(null),
    now: () => '2026-10-17T10:00:00.000Z',
  });
  return { store, workspace };
}

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};
const click = (id: string) => {
  act(() => {
    byId(id)?.click();
  });
};

describe('LineUpDialog', () => {
  beforeEach(() => {
    drawn.length = 0;
    current = IDENTITY;
    saved.length = 0;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ctx as unknown as CanvasRenderingContext2D,
    );
    host = document.body.appendChild(document.createElement('div'));
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    vi.restoreAllMocks();
  });

  it('shows the shift, confidence, counts and a preview', async () => {
    const { store, workspace } = setup();
    root = createRoot(host);
    act(() => root?.render(<LineUpDialog store={store} preview={preview} workspace={workspace} />));
    expect(byId('lineup-dialog')).toBeNull();
    await act(async () => {
      await store.getState().open('d1', 'd2');
    });
    await flush();
    expect(byId('lineup-dialog')).not.toBeNull();
    expect(byId('lineup-confirm')).toHaveProperty('disabled', true);
    expect(byId('lineup-confidence')?.textContent).toBe(
      'Confident: 12 matching areas agree within 0.02 m.',
    );
    expect(byId('lineup-preview')).not.toBeNull();
    click('lineup-keep-d1');
    expect(byId('lineup-keep-d1')?.getAttribute('aria-checked')).toBe('true');
    expect(byId('lineup-shift')?.textContent).toBe('2.00 m west, 0.00 m north (2.00 m in all)');
    expect(byId('lineup-moves')?.textContent).toBe(
      'Moves with Survey 13 April 2026: 2 datasets and 0 drawn items.',
    );
    expect(byId('lineup-confirm')).toHaveProperty('disabled', false);
    click('lineup-keep-d2');
    expect(byId('lineup-shift')?.textContent).toBe('2.00 m east, 0.00 m north (2.00 m in all)');
    expect(byId('lineup-moves')?.textContent).toBe(
      'Moves with Survey 2 March 2026: 1 dataset and 0 drawn items.',
    );
    click('lineup-cancel');
    expect(store.getState().dialog).toBeNull();
    expect(byId('lineup-dialog')).toBeNull();
  });

  it('closes on Escape', async () => {
    const { store, workspace } = setup();
    root = createRoot(host);
    act(() => root?.render(<LineUpDialog store={store} preview={preview} workspace={workspace} />));
    await act(async () => {
      await store.getState().open('d1', 'd2');
    });
    const radio = byId('lineup-keep-d1');
    act(() => {
      radio?.focus();
      radio?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(store.getState().dialog).toBeNull();
    expect(byId('lineup-dialog')).toBeNull();
  });

  it('shows the reason for a refused measurement', async () => {
    const { store, workspace } = setup(measureOf({ verdict: 'overlap' }));
    root = createRoot(host);
    act(() => root?.render(<LineUpDialog store={store} preview={preview} workspace={workspace} />));
    await act(async () => {
      await store.getState().open('d1', 'd2');
    });
    click('lineup-keep-d1');
    expect(byId('lineup-refusal')?.textContent).toBe('These dates hardly overlap.');
    expect(byId('lineup-confirm')).toHaveProperty('disabled', true);
    expect(byId('lineup-preview')).toBeNull();
  });

  it('switches the preview between Before and After', async () => {
    const { store, workspace } = setup();
    root = createRoot(host);
    act(() => root?.render(<LineUpDialog store={store} preview={preview} workspace={workspace} />));
    await act(async () => {
      await store.getState().open('d1', 'd2');
    });
    await flush();
    click('lineup-keep-d1');
    await flush();
    expect(byId('lineup-before')?.getAttribute('aria-pressed')).toBe('true');
    const before = drawn.filter((d) => d.image === moveImage).at(-1);
    click('lineup-after');
    expect(byId('lineup-after')?.getAttribute('aria-pressed')).toBe('true');
    expect(byId('lineup-before')?.getAttribute('aria-pressed')).toBe('false');
    const after = drawn.filter((d) => d.image === moveImage).at(-1);
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    // d2 moves 2 m west: drawn further left, the kept date where it was
    expect((after?.x ?? 0) < (before?.x ?? 0)).toBe(true);
    expect(after?.y).toBe(before?.y);
    const keeps = drawn.filter((d) => d.image === keepImage);
    expect(new Set(keeps.map((d) => d.x)).size).toBe(1);
  });

  it('dialog shows the turn line', async () => {
    const { store, workspace } = setup(measureOf({ fit: fitOf() }));
    root = createRoot(host);
    act(() => root?.render(<LineUpDialog store={store} preview={preview} workspace={workspace} />));
    await act(async () => {
      await store.getState().open('d1', 'd2');
    });
    await flush();
    click('lineup-keep-d1');
    await flush();
    // the pivot moves by the fit's shift, the edges by up to the fit's largest move
    expect(byId('lineup-shift')?.textContent).toBe(
      '2.00 m west, 0.50 m north at the centre, up to 2.40 m at the edges',
    );
    expect(byId('lineup-turn')?.textContent).toBe('turned 0.25°, scaled +0.35%');
    click('lineup-after');
    const after = drawn.filter((d) => d.image === moveImage).at(-1);
    const r = (0.25 * Math.PI) / 180;
    const [a, b, c, d] = after?.m ?? IDENTITY;
    expect(a).toBeCloseTo(1.0035 * Math.cos(r), 9);
    expect(b).toBeCloseTo(-1.0035 * Math.sin(r), 9);
    expect(c).toBeCloseTo(1.0035 * Math.sin(r), 9);
    expect(d).toBeCloseTo(1.0035 * Math.cos(r), 9);
    // keeping the other date turns it back
    click('lineup-keep-d2');
    expect(byId('lineup-turn')?.textContent).toBe('turned -0.25°, scaled -0.35%');
  });

  it('shows no turn line for a plain shift', async () => {
    const { store, workspace } = setup(measureOf({ fit: fitOf({ rotationDeg: 0, scale: 1 }) }));
    root = createRoot(host);
    act(() => root?.render(<LineUpDialog store={store} preview={preview} workspace={workspace} />));
    await act(async () => {
      await store.getState().open('d1', 'd2');
    });
    click('lineup-keep-d1');
    expect(byId('lineup-shift')?.textContent).toBe('2.00 m west, 0.50 m north (2.06 m in all)');
    expect(byId('lineup-turn')).toBeNull();
    expect(byId('lineup-clouds')).toBeNull();
  });

  it("dialog warns that clouds don't turn", async () => {
    // the default project has a point cloud on d2 and none on d1
    const { store, workspace } = setup(measureOf({ fit: fitOf() }));
    root = createRoot(host);
    act(() => root?.render(<LineUpDialog store={store} preview={preview} workspace={workspace} />));
    await act(async () => {
      await store.getState().open('d1', 'd2');
    });
    click('lineup-keep-d1');
    expect(byId('lineup-clouds')?.textContent).toBe("Point clouds move but don't turn yet.");
    click('lineup-keep-d2');
    expect(byId('lineup-clouds')).toBeNull();
  });

  it('tells same-named dates apart on the keep buttons and the preview', async () => {
    const manifest = lineUpManifest({
      captures: [
        { id: 'd1', label: 'Survey', date: '2024-09-04' },
        { id: 'd2', label: 'Survey', date: '2024-09-10' },
      ],
    });
    const { store, workspace } = setup(measureOf(), manifest);
    root = createRoot(host);
    act(() => root?.render(<LineUpDialog store={store} preview={preview} workspace={workspace} />));
    await act(async () => {
      await store.getState().open('d1', 'd2');
    });
    await flush();
    expect(byId('lineup-keep-d1')?.textContent).toBe('Survey · 4 Sep 2024');
    expect(byId('lineup-keep-d2')?.textContent).toBe('Survey · 10 Sep 2024');
    click('lineup-keep-d1');
    const sides = [...host.querySelectorAll('.lu-side')].map((e) => e.textContent);
    expect(sides).toEqual(['Survey · 4 Sep 2024', 'Survey · 10 Sep 2024']);
  });
});
