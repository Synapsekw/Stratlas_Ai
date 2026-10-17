// @vitest-environment jsdom
import { createWorkspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LineUpDialog, type LineUpImage } from './LineUpDialog';
import { createLineUpMemory } from './lineUpMemory';
import { createLineUpStore } from './lineUpStore';
import { lineUpManifest, measureOf } from './testing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** What the canvas was asked to draw, image by image. */
const drawn: { image: unknown; x: number; y: number; w: number; h: number }[] = [];
const ctx = {
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  beginPath: vi.fn(),
  rect: vi.fn(),
  clip: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  drawImage: vi.fn((image: unknown, x: number, y: number, w: number, h: number) => {
    drawn.push({ image, x, y, w, h });
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

function setup(measure = measureOf()) {
  const workspace = createWorkspace();
  workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest: lineUpManifest() });
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
});
