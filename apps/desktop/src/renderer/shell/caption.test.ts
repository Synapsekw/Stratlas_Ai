import { describe, expect, it } from 'vitest';
import { captionInset, platformOf, railWidth } from './caption';

describe('captionInset', () => {
  it('keeps 138 px at the end for the Windows caption buttons', () => {
    expect(captionInset('win32')).toEqual({ inlineEnd: 138, inlineStart: 0 });
  });
  it('keeps 72 px at the start for the macOS traffic lights', () => {
    expect(captionInset('darwin')).toEqual({ inlineEnd: 0, inlineStart: 72 });
  });
  it('keeps nothing elsewhere', () => {
    expect(captionInset('linux')).toEqual({ inlineEnd: 0, inlineStart: 0 });
    expect(captionInset('web')).toEqual({ inlineEnd: 0, inlineStart: 0 });
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
