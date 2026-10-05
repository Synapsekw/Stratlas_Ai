import { describe, expect, it } from 'vitest';
import { en as catalogue } from './i18n/en';
import {
  ariaKeys,
  comboMatches,
  isShortcut,
  keyLabel,
  matchShortcut,
  parseCombo,
  SHORTCUT_SCOPES,
  SHORTCUTS,
  shortcutConflicts,
  type Shortcut,
} from './shortcuts';

const en = catalogue as Record<string, string>;

const press = (
  key: string,
  mods: Partial<Record<'ctrl' | 'shift' | 'alt' | 'meta', boolean>> = {},
) => ({
  key,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
});

describe('shortcut registry', () => {
  it('has no two shortcuts on one key in scopes that are live together', () => {
    // A conflict means one key press would do two things. Either move one of them to another
    // key or, when one should win (road keys over the stage keys), list it in `shadows`.
    expect(shortcutConflicts()).toEqual([]);
  });

  it('reports a conflict, and accepts it once one shortcut shadows the other', () => {
    const a: Shortcut = { id: 'a', scope: 'scene', keys: ['M'], label: 'keys.scene.measure' };
    const b: Shortcut = { id: 'b', scope: 'road', keys: ['M'], label: 'keys.road.measure' };
    const c: Shortcut = {
      id: 'c',
      scope: 'global',
      keys: ['Ctrl+Shift+Z'],
      label: 'keys.review.redo',
    };
    const d: Shortcut = {
      id: 'd',
      scope: 'pdf',
      keys: ['Shift+Ctrl+Z'],
      label: 'keys.review.redo',
    };
    expect(shortcutConflicts([a, b])).toEqual(['M: a and b']);
    expect(shortcutConflicts([a, { ...b, shadows: ['a'] }])).toEqual([]);
    expect(shortcutConflicts([c, d])).toEqual(['Ctrl+Shift+Z: c and d']);
    // review and pdf never run together
    expect(
      shortcutConflicts([
        { ...a, scope: 'review' },
        { ...b, scope: 'pdf' },
      ]),
    ).toEqual([]);
    expect(shortcutConflicts([a, a])).toContain('a: id used twice');
  });

  it('parses every combo, names every scope and has a label for every row', () => {
    const scopes = new Set(SHORTCUT_SCOPES.map((s) => s.scope));
    const shadowed = new Set(SHORTCUTS.flatMap((s) => ('shadows' in s ? s.shadows : [])));
    for (const s of SHORTCUTS as readonly Shortcut[]) {
      for (const k of s.keys) expect(() => parseCombo(k), `${s.id} ${k}`).not.toThrow();
      expect(scopes.has(s.scope), s.id).toBe(true);
      expect(en[s.label], s.id).toBeTruthy();
    }
    for (const id of shadowed)
      expect(
        SHORTCUTS.some((s) => s.id === id),
        id,
      ).toBe(true);
    for (const s of SHORTCUT_SCOPES) expect(en[s.label]).toBeTruthy();
  });

  it('matches modifiers exactly, Ctrl or Cmd, and ignores Shift on symbols only', () => {
    expect(comboMatches('Ctrl+K', press('k', { ctrl: true }))).toBe(true);
    expect(comboMatches('Ctrl+K', press('k', { meta: true }))).toBe(true);
    expect(comboMatches('Ctrl+K', press('k'))).toBe(false);
    expect(comboMatches('Ctrl+B', press('b', { ctrl: true, alt: true }))).toBe(false);
    expect(comboMatches('M', press('M'))).toBe(true); // Caps Lock
    expect(comboMatches('M', press('M', { shift: true }))).toBe(false);
    expect(comboMatches('Shift+R', press('R', { shift: true }))).toBe(true);
    expect(comboMatches('Plus', press('+', { shift: true }))).toBe(true);
    expect(comboMatches('Plus', press('='))).toBe(true);
    expect(comboMatches('Space', press(' '))).toBe(true);
    expect(comboMatches('Esc', press('Escape'))).toBe(true);
    expect(comboMatches('Down', press('ArrowDown'))).toBe(true);
  });

  it('finds the shortcut of a scope for a key press', () => {
    expect(matchShortcut('scene', press('2'))).toBe('scene.modeMap');
    expect(matchShortcut('scene', press('m'))).toBe('scene.measure');
    expect(matchShortcut('road', press('m'))).toBe('road.measure');
    expect(matchShortcut('review', press('J', { shift: true }))).toBe('review.nextSource');
    expect(matchShortcut('review', press('j'))).toBe('review.next');
    expect(matchShortcut('scene', press('q'))).toBeNull();
    expect(isShortcut('global.rightPanel', press('b', { ctrl: true, alt: true }))).toBe(true);
    expect(isShortcut('global.sidebar', press('b', { ctrl: true, alt: true }))).toBe(false);
  });

  it('writes keys for people and for aria-keyshortcuts', () => {
    expect(keyLabel('Ctrl+Shift+F')).toBe('Ctrl Shift F');
    expect(keyLabel('Up')).toBe('↑');
    expect(ariaKeys('global.palette')).toBe('Control+K');
    expect(ariaKeys('issues.redo')).toBe('Control+Y Control+Shift+Z');
    expect(ariaKeys('scene.escape')).toBe('Escape');
  });
});
