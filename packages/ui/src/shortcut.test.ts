import { describe, expect, it } from 'vitest';
import { isMacPlatform, platformKeys } from './shortcut';

describe('platformKeys', () => {
  it('keeps the Windows label as written', () => {
    expect(platformKeys('Ctrl K', false)).toBe('Ctrl K');
    expect(platformKeys('Ctrl+Shift+F', false)).toBe('Ctrl+Shift+F');
  });

  it('uses Apple symbols in Apple order on macOS', () => {
    expect(platformKeys('Ctrl K', true)).toBe('⌘K');
    expect(platformKeys('Ctrl Alt B', true)).toBe('⌥⌘B');
    expect(platformKeys('Ctrl+Shift+F', true)).toBe('⇧⌘F');
    expect(platformKeys('Ctrl F', true)).toBe('⌘F');
  });
});

describe('isMacPlatform', () => {
  it('reads the user agent', () => {
    const mac =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/142 Electron/44';
    const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142';
    expect(isMacPlatform(mac)).toBe(true);
    expect(isMacPlatform(win)).toBe(false);
  });
});
