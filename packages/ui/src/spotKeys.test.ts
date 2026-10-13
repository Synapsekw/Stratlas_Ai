import { describe, expect, it } from 'vitest';
import { t } from './i18n';
import { matchShortcut, SHORTCUT_SCOPES } from './shortcuts';

const key = (k: string) => ({
  key: k,
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
});

describe('spot history keys', () => {
  it('steps dates with left and right, images with up and down', () => {
    expect(matchShortcut('spot', key('ArrowLeft'))).toBe('spot.prevDate');
    expect(matchShortcut('spot', key('ArrowRight'))).toBe('spot.nextDate');
    expect(matchShortcut('spot', key('ArrowUp'))).toBe('spot.prevMatch');
    expect(matchShortcut('spot', key('ArrowDown'))).toBe('spot.nextMatch');
    expect(matchShortcut('spot', key('c'))).toBe('spot.compare');
    expect(matchShortcut('spot', key('Escape'))).toBe('spot.close');
  });
  it('has a heading in the keyboard map and its words', () => {
    expect(SHORTCUT_SCOPES.some((s) => s.scope === 'spot')).toBe(true);
    expect(t('spot.slot.none', { m: 15 })).toBe('Nothing within 15 m');
    expect(t('spot.slot.skipped', { count: 2 })).toBe('2 items without a position were left out');
  });
});
