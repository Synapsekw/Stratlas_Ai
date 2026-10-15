// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { coverPalette, type CoverChoice } from './cover';
import { CoverPicker, type CoverPickerProps } from './CoverPicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
const onChange = vi.fn<(c: CoverChoice) => void>();

beforeEach(() => {
  // jsdom draws nothing; the drawing itself is covered by the covers e2e
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  onChange.mockClear();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.restoreAllMocks();
});

const render = (p: Partial<CoverPickerProps> = {}) => {
  root = createRoot(host);
  act(() =>
    root?.render(
      <CoverPicker
        palette={coverPalette('survey')}
        value={{ kind: 'builtin', id: 'contours' }}
        onChange={onChange}
        {...p}
      />,
    ),
  );
};
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('CoverPicker', () => {
  it('marks the chosen built-in cover and reports a new pick', () => {
    render({ value: { kind: 'builtin', id: 'grid' } });
    expect(q('cover-builtin-grid')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('cover-builtin-contours')?.getAttribute('aria-pressed')).toBe('false');
    expect(q('cover-builtin-grid')?.getAttribute('aria-label')).toBe('Site grid');
    expect(q('cover-builtin-dots')?.getAttribute('aria-label')).toBe('Point cloud');
    act(() => q('cover-builtin-dots')?.click());
    expect(onChange).toHaveBeenCalledWith({ kind: 'builtin', id: 'dots' });
  });

  it('greys Use current view and says why while no 3D view is open', () => {
    render({ currentView: true });
    const view = q('cover-current-view') as HTMLButtonElement;
    expect(view.disabled).toBe(true);
    const why = document.getElementById(view.getAttribute('aria-describedby') ?? '');
    expect(why?.textContent).toBe('Open the 3D view first');
  });

  it('offers No cover and the project picture only when allowed', () => {
    render();
    expect(q('cover-none')).toBeNull();
    expect(q('cover-reset')).toBeNull();
    act(() => root?.unmount());
    render({ allowNone: true, allowReset: true });
    act(() => q('cover-none')?.click());
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'none' });
    act(() => q('cover-reset')?.click());
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'reset' });
  });

  it('frees the object URL of an uploaded image when it goes away', async () => {
    const created = vi.fn(() => 'blob:cover-1');
    const revoked = vi.fn();
    // jsdom has no object URLs; give URL the two calls for this test only
    const saved = {
      create: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
      revoke: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
    };
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: created });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoked });
    onTestFinished(() => {
      for (const [name, d] of [
        ['createObjectURL', saved.create],
        ['revokeObjectURL', saved.revoke],
      ] as const) {
        if (d) Object.defineProperty(URL, name, d);
        else Reflect.deleteProperty(URL, name);
      }
    });
    // a stand-in decoder and canvas: the bytes are not looked at here
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve({ width: 40, height: 30, close: vi.fn() })),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: '' };
        }
        convertToBlob() {
          return Promise.resolve(new Blob([new Uint8Array([0xff, 0xd8, 0xff])]));
        }
      },
    );
    render();
    const input = q('cover-upload') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['x'], 'site.png', { type: 'image/png' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', url: 'blob:cover-1' }),
    );
    expect(revoked).not.toHaveBeenCalled();
    act(() => root?.unmount());
    root = undefined;
    expect(revoked).toHaveBeenCalledWith('blob:cover-1');
    vi.unstubAllGlobals();
  });

  it('shows a message under the picker for a file it cannot read', async () => {
    render();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('undecodable'))),
    );
    const input = q('cover-upload') as HTMLInputElement;
    expect(input.accept).toBe('image/*');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['not an image'], 'notes.txt', { type: 'text/plain' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(q('cover-bad-image')?.textContent).toContain(
      'This file is not an image the app can read.',
    );
    expect(onChange).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
