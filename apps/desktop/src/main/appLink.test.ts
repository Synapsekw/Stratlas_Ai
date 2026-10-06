import { describe, expect, it } from 'vitest';
import { linkPathFromArgv, parseAppLink } from './appLink';

const link = (path: string) => `stratlas://open?path=${encodeURIComponent(path)}`;

describe('parseAppLink', () => {
  it('opens an absolute local .aio package on macOS', () => {
    expect(parseAppLink(link('/Users/me/Al Zour.aio'), 'stratlas', 'darwin')).toEqual({
      kind: 'open',
      path: '/Users/me/Al Zour.aio',
    });
  });

  it('opens a drive path on Windows', () => {
    expect(parseAppLink(link('D:\\Sites\\masafi.AIO'), 'stratlas', 'win32')).toEqual({
      kind: 'open',
      path: 'D:\\Sites\\masafi.AIO',
    });
  });

  it('only brings the app forward for other links of the scheme', () => {
    const focus = { kind: 'focus' };
    expect(parseAppLink('stratlas://', 'stratlas', 'darwin')).toEqual(focus);
    expect(parseAppLink('stratlas://settings', 'stratlas', 'darwin')).toEqual(focus);
    expect(parseAppLink(link('/Users/me/notes.txt'), 'stratlas', 'darwin')).toEqual(focus);
    expect(parseAppLink(link('relative/site.aio'), 'stratlas', 'darwin')).toEqual(focus);
  });

  it('never opens a network location', () => {
    const focus = { kind: 'focus' };
    expect(parseAppLink(link('//server/share/site.aio'), 'stratlas', 'darwin')).toEqual(focus);
    expect(parseAppLink(link('\\\\server\\share\\site.aio'), 'stratlas', 'win32')).toEqual(focus);
  });

  it('finds the package a Windows protocol launch passes as an argument', () => {
    const argv = ['C:/Program Files/Stratlas/Stratlas.exe', link('D:\\Sites\\hcl.aio')];
    expect(linkPathFromArgv(argv, 'stratlas', 'win32')).toBe('D:\\Sites\\hcl.aio');
    expect(linkPathFromArgv(['Stratlas.exe'], 'stratlas', 'win32')).toBeNull();
    expect(linkPathFromArgv(['Stratlas.exe', 'stratlas://'], 'stratlas', 'win32')).toBeNull();
  });

  it('ignores other schemes and malformed URLs', () => {
    expect(parseAppLink('aio://project/x/model.glb', 'stratlas', 'darwin')).toBeNull();
    expect(parseAppLink('https://example.com/a.aio', 'stratlas', 'darwin')).toBeNull();
    expect(parseAppLink('not a url', 'stratlas', 'darwin')).toBeNull();
  });
});
