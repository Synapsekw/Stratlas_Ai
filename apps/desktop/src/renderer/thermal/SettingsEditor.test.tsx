// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsEditor, settingsOf } from './SettingsEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settings = { emissivity: 0.95, distanceM: 10, airC: 25, humidityPct: 50, reflectedC: null };
const form = {
  emissivity: '0.95',
  distanceM: '10',
  airC: '25',
  humidityPct: '50',
  reflected: '25',
  sameAsAir: true,
};

describe('settingsOf', () => {
  it('reads the form, reflected null when same as the air', () => {
    expect(settingsOf(form)).toEqual(settings);
    expect(settingsOf({ ...form, sameAsAir: false, reflected: '40' })).toEqual({
      ...settings,
      reflectedC: 40,
    });
  });
  it('refuses missing and out-of-range values', () => {
    expect(settingsOf({ ...form, emissivity: '0' })).toBeNull();
    expect(settingsOf({ ...form, emissivity: '1.2' })).toBeNull();
    expect(settingsOf({ ...form, distanceM: '-1' })).toBeNull();
    expect(settingsOf({ ...form, airC: '' })).toBeNull();
    expect(settingsOf({ ...form, humidityPct: '101' })).toBeNull();
    expect(settingsOf({ ...form, sameAsAir: false, reflected: 'x' })).toBeNull();
  });
});

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

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const type = (id: string, value: string) => {
  const el = byId(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`no ${id}`);
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  act(() => {
    desc?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('SettingsEditor', () => {
  it('greys the scopes on a bad value and offers "selected" only for several marked', () => {
    const onApply = vi.fn();
    root = createRoot(host);
    act(() => {
      root?.render(
        <SettingsEditor
          open
          onClose={() => undefined}
          opener={createRef()}
          settings={settings}
          selected={1}
          onApply={onApply}
        />,
      );
    });
    expect(byId('thermal-apply-selected')).toBeNull();
    type('thermal-setting-humidityPct', '140');
    expect(byId('thermal-apply-photo')?.hasAttribute('disabled')).toBe(true);
    type('thermal-setting-humidityPct', '70');
    act(() => {
      byId('thermal-apply-photo')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // only what the person changed: the other photos keep their own distance and the rest
    expect(onApply).toHaveBeenCalledWith('photo', { humidityPct: 70 });
  });
});
