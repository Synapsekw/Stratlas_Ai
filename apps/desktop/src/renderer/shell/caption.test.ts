import { describe, expect, it } from 'vitest';
import { captionInset, captionVars, platformOf, railWidth } from './caption';

describe('captionInset', () => {
  it('keeps 138 px at the right for the Windows caption buttons', () => {
    expect(captionInset('win32')).toEqual({ left: 0, right: 138 });
  });
  it('keeps 72 px at the left for the macOS traffic lights', () => {
    expect(captionInset('darwin')).toEqual({ left: 72, right: 0 });
  });
  it('keeps nothing elsewhere', () => {
    expect(captionInset('linux')).toEqual({ left: 0, right: 0 });
    expect(captionInset('web')).toEqual({ left: 0, right: 0 });
  });
});

describe('captionVars', () => {
  it('follows the window controls overlay on Windows, with 138 px at the right without it', () => {
    expect(captionVars('win32')).toEqual({
      '--caption-left': 'env(titlebar-area-x, 0px)',
      '--caption-right':
        'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px)))',
    });
  });
  it('keeps 72 px at the left on macOS without an overlay', () => {
    expect(captionVars('darwin')).toEqual({
      '--caption-left': 'env(titlebar-area-x, 72px)',
      '--caption-right':
        'calc(100vw - env(titlebar-area-x, 72px) - env(titlebar-area-width, calc(100vw - 72px)))',
    });
  });
  it('keeps no room where the window draws no buttons over the page', () => {
    expect(captionVars('linux')).toEqual({ '--caption-left': '0px', '--caption-right': '0px' });
    expect(captionVars('web')).toEqual({ '--caption-left': '0px', '--caption-right': '0px' });
  });
});

describe('platformOf', () => {
  it('reads the platform of the window the app runs in', () => {
    expect(platformOf('Win32', true)).toBe('win32');
    expect(platformOf('MacIntel', true)).toBe('darwin');
    expect(platformOf('Linux x86_64', true)).toBe('linux');
  });
  it('is the web without the desktop bridge', () => {
    expect(platformOf('Win32', false)).toBe('web');
  });
});

describe('railWidth', () => {
  it('widens the rail on macOS so the traffic lights fit in it', () => {
    expect(railWidth('darwin')).toBe(76);
  });
  it('keeps the 52 px rail elsewhere', () => {
    expect(railWidth('win32')).toBe(52);
    expect(railWidth('linux')).toBe(52);
    expect(railWidth('web')).toBe(52);
  });
});
