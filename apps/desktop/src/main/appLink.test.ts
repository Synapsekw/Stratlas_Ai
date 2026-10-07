import { describe, expect, it } from 'vitest';
import { linkPathFromArgv, parseAppLink } from './appLink';

const link = (path: string) => `quadrion://open?path=${encodeURIComponent(path)}`;

describe('parseAppLink', () => {
  it('opens an absolute local .aio package on macOS', () => {
    expect(parseAppLink(link('/Users/me/Al Zour.aio'), 'quadrion', 'darwin')).toEqual({
      kind: 'open',
      path: '/Users/me/Al Zour.aio',
    });
  });

  it('opens a drive path on Windows', () => {
    expect(parseAppLink(link('D:\\Sites\\masafi.AIO'), 'quadrion', 'win32')).toEqual({
      kind: 'open',
      path: 'D:\\Sites\\masafi.AIO',
    });
  });

  it('only brings the app forward for other links of the scheme', () => {
    const focus = { kind: 'focus' };
    expect(parseAppLink('quadrion://', 'quadrion', 'darwin')).toEqual(focus);
    expect(parseAppLink('quadrion://settings', 'quadrion', 'darwin')).toEqual(focus);
    expect(parseAppLink(link('/Users/me/notes.txt'), 'quadrion', 'darwin')).toEqual(focus);
    expect(parseAppLink(link('relative/site.aio'), 'quadrion', 'darwin')).toEqual(focus);
  });

  it('never opens a network location', () => {
    const focus = { kind: 'focus' };
    expect(parseAppLink(link('//server/share/site.aio'), 'quadrion', 'darwin')).toEqual(focus);
    expect(parseAppLink(link('\\\\server\\share\\site.aio'), 'quadrion', 'win32')).toEqual(focus);
  });

  it('finds the package a Windows protocol launch passes as an argument', () => {
    const argv = ['C:/Program Files/Quadrion AI/QuadrionAI.exe', link('D:\\Sites\\hcl.aio')];
    expect(linkPathFromArgv(argv, 'quadrion', 'win32')).toBe('D:\\Sites\\hcl.aio');
    expect(linkPathFromArgv(['QuadrionAI.exe'], 'quadrion', 'win32')).toBeNull();
    expect(linkPathFromArgv(['QuadrionAI.exe', 'quadrion://'], 'quadrion', 'win32')).toBeNull();
  });

  it('also answers the legacy stratlas scheme from before the rename', () => {
    const schemes = ['quadrion', 'stratlas'];
    const old = `stratlas://open?path=${encodeURIComponent('/Users/me/site.aio')}`;
    expect(parseAppLink(old, schemes, 'darwin')).toEqual({
      kind: 'open',
      path: '/Users/me/site.aio',
    });
    expect(parseAppLink(link('/Users/me/site.aio'), schemes, 'darwin')).toEqual({
      kind: 'open',
      path: '/Users/me/site.aio',
    });
    expect(parseAppLink('stratlas://settings', schemes, 'darwin')).toEqual({ kind: 'focus' });
    expect(parseAppLink(old, 'quadrion', 'darwin')).toBeNull();
    expect(linkPathFromArgv(['QuadrionAI.exe', old], schemes, 'darwin')).toBe('/Users/me/site.aio');
  });

  it('ignores other schemes and malformed URLs', () => {
    expect(parseAppLink('aio://project/x/model.glb', 'quadrion', 'darwin')).toBeNull();
    expect(parseAppLink('https://example.com/a.aio', 'quadrion', 'darwin')).toBeNull();
    expect(parseAppLink('not a url', 'quadrion', 'darwin')).toBeNull();
  });
});
