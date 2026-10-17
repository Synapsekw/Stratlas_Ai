// @vitest-environment jsdom
import type * as Maps from '@aio/maps';
import type { ProjectManifest } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aio/maps', async (importOriginal) => ({
  ...(await importOriginal<typeof Maps>()),
  getActiveMap: () => null,
  onActiveMap: () => () => undefined,
}));

const { createPinStore } = await import('./pinStore');
const { PinStrip } = await import('./PinStrip');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Store = ReturnType<typeof createPinStore>;

let host: HTMLDivElement;
let stage: HTMLDivElement;
let root: Root | undefined;

const photo = { kind: 'photo' as const, layerId: 'photos', itemId: 'a' };

function store(): Store {
  return createPinStore({
    manifest: () => workspace.getState().project?.manifest ?? null,
    save: () => Promise.resolve(null),
    openPanoBeside: vi.fn(),
  });
}

function mount(s: Store): void {
  act(() => {
    root = createRoot(host);
    root.render(<PinStrip store={s} />);
  });
}

const strip = () => document.querySelector<HTMLElement>('[data-testid="pin-strip"]');

beforeEach(() => {
  host = document.createElement('div');
  stage = document.createElement('div');
  stage.className = 'stage';
  document.body.append(host, stage);
  workspace.getState().openProject({
    id: 'pin-strip-test',
    root: 'x',
    manifest: {
      layers: [
        {
          kind: 'photos',
          id: 'photos',
          name: 'Photos',
          visible: true,
          items: [{ id: 'a', src: { path: 'photos/IMG_0001.jpg' } }],
        },
      ],
    } as unknown as ProjectManifest,
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
  stage.remove();
  workspace.getState().closeProject();
});

describe('PinStrip', () => {
  it('renders nothing without a target', () => {
    mount(store());
    expect(strip()).toBeNull();
  });

  it("says the pick step with the item's name, inside the stage", () => {
    const s = store();
    s.setState({ target: photo, step: 'pick' });
    mount(s);
    const el = strip();
    expect(el?.parentElement).toBe(stage);
    expect(el?.textContent).toContain(t('pin.strip.pick', { name: 'IMG_0001.jpg' }));
    expect(document.querySelector('[data-testid="pin-eye-height"]')).toBeNull();
  });

  it('shows the note and the save error', () => {
    const s = store();
    s.setState({ target: photo, step: 'aim', note: 'pin.strip.tooClose', error: 'disk full' });
    mount(s);
    expect(strip()?.textContent).toContain(t('pin.strip.tooClose'));
    expect(strip()?.textContent).toContain(t('pin.strip.saveFailed', { reason: 'disk full' }));
  });

  it('offers the eye height once the pin is down and saves what is typed', () => {
    const s = store();
    const setEyeM = vi.fn(() => Promise.resolve());
    s.setState({ target: photo, step: 'pick', setEyeM });
    mount(s);
    act(() => {
      s.setState({ ground: [0, 0, 0], step: 'aim' });
    });
    const input = document.querySelector<HTMLInputElement>('[data-testid="pin-eye-height"]');
    expect(input?.value).toBe('1.6');
    expect(input?.step).toBe('0.1');
    expect(input?.min).toBe('0');
    expect(input?.max).toBe('10');
    act(() => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '2');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(setEyeM).toHaveBeenCalledWith(2);
  });

  it('Escape and Cancel cancel; Done finishes', () => {
    const s = store();
    const cancel = vi.fn();
    const done = vi.fn();
    s.setState({ target: photo, step: 'pick', cancel, done });
    mount(s);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="pin-cancel"]')?.click();
    });
    expect(cancel).toHaveBeenCalledTimes(2);
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="pin-done"]')?.click();
    });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('carries no title tooltips', () => {
    const s = store();
    s.setState({ target: photo, step: 'pick', ground: [0, 0, 0] });
    mount(s);
    const el = strip();
    expect(el?.hasAttribute('title')).toBe(false);
    expect(el?.querySelector('[title]')).toBeNull();
  });
});
