// @vitest-environment jsdom
import { defaultGlobeSettings, type RasterPackInfo } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobeMapMenu, type GlobeMapMenuProps } from './GlobeMapMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

const pack = (id: string, label: string): RasterPackInfo =>
  ({ id, label, sizeBytes: 1000 }) as RasterPackInfo;

function mount(over: Partial<GlobeMapMenuProps> = {}) {
  const onSave = vi.fn();
  const props: GlobeMapMenuProps = {
    prefs: defaultGlobeSettings(),
    look: 'satellite',
    tier: 'high',
    imagery: [pack('sat-1', 'Site flight')],
    terrain: [pack('dem-1', 'Surface model')],
    streetPacks: 1,
    online: false,
    onSave,
    ...over,
  };
  root = createRoot(host);
  act(() => root?.render(<GlobeMapMenu {...props} />));
  const open = () => {
    act(() => q('globe-map-button')?.click());
  };
  return { onSave, props, open };
}

/** The select under a field label, as a person finds it. */
const select = (label: string) =>
  [...host.querySelectorAll('label')]
    .find((l) => l.querySelector('span')?.textContent === label)
    ?.querySelector('select');

describe('the Globe Map button and its dialog', () => {
  it('opens a labelled dialog from the button, and the button says so', () => {
    mount();
    const button = q('globe-map-button');
    expect(button?.textContent).toBe('Map');
    expect(button?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(q('globe-map-menu')).toBeNull();

    act(() => button?.click());
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    const menu = q('globe-map-menu');
    expect(menu?.getAttribute('role')).toBe('dialog');
    expect(menu?.getAttribute('aria-label')).toBe('Map settings');
    // a second click on the button closes it again
    act(() => button?.click());
    expect(q('globe-map-menu')).toBeNull();
  });

  it('marks the current look, and a click on another saves it and keeps the dialog open', () => {
    const { onSave, props, open } = mount({ look: 'street' });
    open();
    expect(q('globe-look-street')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('globe-look-satellite')?.getAttribute('aria-pressed')).toBe('false');
    expect(q('globe-look-natural-earth')?.getAttribute('aria-pressed')).toBe('false');

    act(() => q('globe-look-satellite')?.click());
    expect(onSave).toHaveBeenCalledWith({ ...props.prefs, style: 'satellite' });
    expect(q('globe-map-menu')).not.toBeNull();
  });

  it('offers imagery on the satellite and Natural Earth looks, not on the street map', () => {
    const { open } = mount({ look: 'street' });
    open();
    expect(select('Imagery')).toBeUndefined();
    expect(select('Terrain')).not.toBeUndefined();
  });

  it('lists the installed packs and saves a pick with the other preferences kept', () => {
    const { onSave, props, open } = mount();
    open();
    const imagery = select('Imagery');
    expect([...(imagery?.options ?? [])].map((o) => o.textContent)).toEqual([
      'Best available',
      'Site flight',
    ]);
    act(() => {
      if (!imagery) return;
      imagery.value = 'sat-1';
      imagery.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onSave).toHaveBeenCalledWith({ ...props.prefs, imagery: 'sat-1' });

    const terrain = select('Terrain');
    expect([...(terrain?.options ?? [])].map((o) => o.textContent)).toEqual([
      'Best available',
      'Off (smooth Earth)',
      'Surface model',
    ]);
    act(() => {
      if (!terrain) return;
      terrain.value = 'off';
      terrain.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onSave).toHaveBeenLastCalledWith({ ...props.prefs, terrain: 'off' });
  });

  it('the Show issues box saves its change', () => {
    const { onSave, props, open } = mount();
    open();
    const box = host.querySelector<HTMLInputElement>('.globe-check input');
    expect(box?.checked).toBe(true);
    act(() => box?.click());
    expect(onSave).toHaveBeenCalledWith({ ...props.prefs, showIssues: false });
  });

  it('turns terrain off with a note on the Low graphics preset only', () => {
    const { open } = mount({ tier: 'low' });
    open();
    expect(select('Terrain')?.disabled).toBe(true);
    expect(host.textContent).toContain('Terrain is off on the Low graphics preset.');
  });

  it('keeps terrain and the note quiet on the other presets', () => {
    const { open } = mount({ tier: 'high' });
    open();
    expect(select('Terrain')?.disabled).toBe(false);
    expect(host.textContent).not.toContain('Low graphics preset');
  });

  it('says there is no street pack only on the street map with none installed', () => {
    const none = 'No street map pack is installed';
    const first = mount({ look: 'street', streetPacks: 0 });
    first.open();
    expect(host.textContent).toContain(none);
    act(() => root?.unmount());

    const second = mount({ look: 'street', streetPacks: 2 });
    second.open();
    expect(host.textContent).not.toContain(none);
    act(() => root?.unmount());

    const third = mount({ look: 'satellite', streetPacks: 0 });
    third.open();
    expect(host.textContent).not.toContain(none);
  });

  it('hints at online satellite only with no imagery and no network access', () => {
    const hint = 'Turn on Online satellite';
    const first = mount({ look: 'satellite', imagery: [], online: false });
    first.open();
    expect(host.textContent).toContain(hint);
    act(() => root?.unmount());

    const second = mount({ look: 'satellite', imagery: [], online: true });
    second.open();
    expect(host.textContent).not.toContain(hint);
    act(() => root?.unmount());

    const third = mount({ look: 'satellite', online: false });
    third.open();
    expect(host.textContent).not.toContain(hint);
    act(() => root?.unmount());

    const fourth = mount({ look: 'natural-earth', imagery: [], online: false });
    fourth.open();
    expect(host.textContent).not.toContain(hint);
  });

  it('has the key of the pins in both tones, and no Measure button', () => {
    const { open } = mount();
    open();
    const key = host.querySelector('ul.globe-key');
    expect(key?.getAttribute('aria-label')).toBe('Site pins');
    expect(
      [...(key?.querySelectorAll('li') ?? [])].map((li) => [li.dataset.tone, li.textContent]),
    ).toEqual([
      ['clear', 'No open issues'],
      ['attention', 'Open issues'],
    ]);
    expect(host.querySelector('.globe-measure')).toBeNull();
  });

  it('moves focus into the dialog; Escape closes it and focus returns to the button', async () => {
    const { open } = mount();
    const button = q('globe-map-button');
    button?.focus();
    open();
    expect(q('globe-map-menu')?.contains(document.activeElement)).toBe(true);
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(q('globe-map-menu')).toBeNull();
    await settle();
    expect(document.activeElement).toBe(button);
  });

  it('closes on a press away from it, and stays open on a press inside', () => {
    const { open } = mount();
    open();
    act(() => {
      q('globe-map-menu')?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(q('globe-map-menu')).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(q('globe-map-menu')).toBeNull();
  });
});
