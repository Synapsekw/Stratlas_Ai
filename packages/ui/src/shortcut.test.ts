import { describe, expect, it } from 'vitest';
import { isMacPlatform, shortcut } from './shortcut';

describe('shortcut', () => {
  it('keeps the Windows label as written', () => {
    expect(shortcut('Ctrl K', false)).toBe('Ctrl K');
    expect(shortcut('Ctrl+Shift+F', false)).toBe('Ctrl+Shift+F');
  });

  it('uses Apple symbols in Apple order on macOS', () => {
    expect(shortcut('Ctrl K', true)).toBe('⌘K');
    expect(shortcut('Ctrl Alt B', true)).toBe('⌥⌘B');
    expect(shortcut('Ctrl+Shift+F', true)).toBe('⇧⌘F');
    expect(shortcut('Ctrl F', true)).toBe('⌘F');
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
