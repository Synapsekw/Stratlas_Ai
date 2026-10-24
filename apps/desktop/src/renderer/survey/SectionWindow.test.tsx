// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// the body has its own tests; here only the window around it
vi.mock('./SectionBody', () => ({ SectionBody: () => <div data-testid="section-body" /> }));

const { SectionWindow } = await import('./SectionWindow');
const { sectionStore } = await import('./sectionStore');
const { linkedHover } = await import('./linkedHover');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  sectionStore.setState({
    window: true,
    source: { kind: 'measurement', id: 'm1', label: 'Section 1' },
  });
  root = createRoot(host);
  act(() => root?.render(<SectionWindow />));
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  sectionStore.setState({ window: false, source: null });
  linkedHover.setState({ hover: null, pin: null, fly: null });
});

const esc = () => {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => {
    document.body.dispatchEvent(e);
  });
  return e;
};

describe('the larger section window', () => {
  it('the section window has no scrim and Esc closes it', () => {
    const w = host.querySelector<HTMLElement>('[data-testid="section-window"]');
    expect(w).not.toBeNull();
    // a panel over the stage, not a modal: no scrim, no aria-modal, the stage stays usable
    expect(host.querySelector('.sv-scrim')).toBeNull();
    expect(w?.getAttribute('aria-modal')).toBeNull();
    expect(w?.getAttribute('role')).toBe('region');
    expect(w?.querySelector('[data-testid="section-body"]')).not.toBeNull();
    esc();
    expect(sectionStore.getState().window).toBe(false);
  });

  it('Esc clears a pin on the section first, then closes', () => {
    act(() => {
      linkedHover.getState().setPin({ key: 'section', chainageM: 4, source: 'chart' });
    });
    // taken here, so the stage's own Esc (the open pile) waits for the next one
    expect(esc().defaultPrevented).toBe(true);
    expect(linkedHover.getState().pin).toBeNull();
    expect(sectionStore.getState().window).toBe(true);
    esc();
    expect(sectionStore.getState().window).toBe(false);
  });

  it('an Esc another control has taken does not close it', () => {
    act(() => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      e.preventDefault();
      document.body.dispatchEvent(e);
    });
    expect(sectionStore.getState().window).toBe(true);
  });

  it('an Esc in a field (search, rename, density) stays with the field', () => {
    const input = document.createElement('input');
    document.body.append(input);
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      input.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(false);
    expect(sectionStore.getState().window).toBe(true);
  });

  it('an Esc while a menu is open closes the menu, not the window', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    expect(esc().defaultPrevented).toBe(false);
    expect(sectionStore.getState().window).toBe(true);
  });

  it('its close button returns the section to the dock', () => {
    const close = host.querySelector<HTMLButtonElement>('[data-testid="section-window-close"]');
    expect(close?.getAttribute('aria-label')).toBe('Close the section');
    act(() => close?.click());
    expect(sectionStore.getState().window).toBe(false);
  });
});
