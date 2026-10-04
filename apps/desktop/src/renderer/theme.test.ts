import { describe, expect, it } from 'vitest';
import { applyAppearance, resolveTheme } from './theme';

describe('resolveTheme', () => {
  it('uses the chosen theme, or the system preference for system', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('applyAppearance', () => {
  it('sets the resolved theme, the choice and the layout direction on <html>', () => {
    const html = { dataset: {} as Record<string, string>, dir: '', lang: '' };
    applyAppearance(html, { theme: 'system', direction: 'rtl' }, false);
    expect(html.dataset).toEqual({ theme: 'light', themeSetting: 'system' });
    expect(html.dir).toBe('rtl');
    applyAppearance(html, { theme: 'dark' }, false);
    expect(html.dataset.theme).toBe('dark');
    expect(html.dir).toBe('ltr');
  });
});
