import { describe, expect, it } from 'vitest';
import { t } from './i18n';
import { matchShortcut, SHORTCUT_SCOPES, shortcutConflicts, shortcutHint } from './shortcuts';

const key = (k: string) => ({
  key: k,
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
});

describe('antenna review keys', () => {
  it('lists A and R for the selected unit, under their own heading', () => {
    expect(matchShortcut('antenna', key('a'))).toBe('antenna.accept');
    expect(matchShortcut('antenna', key('r'))).toBe('antenna.reject');
    const scope = SHORTCUT_SCOPES.find((s) => s.scope === 'antenna');
    expect(scope && t(scope.label)).toBe('Antennas, with a unit selected');
    expect(shortcutHint('antenna.accept', false)).toBe('A');
    expect(shortcutHint('antenna.reject', false)).toBe('R');
  });

  it('takes A from the stage on purpose, and clashes with nothing else', () => {
    expect(shortcutConflicts()).toEqual([]);
  });
});
