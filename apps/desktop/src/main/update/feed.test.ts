import { describe, expect, it } from 'vitest';
import { feedUrl, parseFeed, platformKey, signatureUrl } from './feed';

const file = { url: 'QuadrionAI-0.8.0-win-x64-setup.exe', sha256: 'AB'.repeat(32), size: 10 };
const feed = (over: object = {}) =>
  JSON.stringify({
    schema: 'aio.update-feed/1',
    version: '0.8.0',
    files: { 'win-x64': file },
    ...over,
  });

describe('update feed', () => {
  it('takes a .json address as is and appends the feed name to a folder', () => {
    expect(feedUrl('https://u.example.com/s/feed.json')).toBe('https://u.example.com/s/feed.json');
    expect(feedUrl('https://u.example.com/s/')).toBe(
      'https://u.example.com/s/stratlas-update.json',
    );
    expect(feedUrl('https://u.example.com/s')).toBe('https://u.example.com/s/stratlas-update.json');
  });

  it('takes https only, and plain http to this computer only when allowed', () => {
    expect(() => feedUrl('http://u.example.com/s/')).toThrow(/https/);
    expect(() => feedUrl('http://127.0.0.1:8080/s/')).toThrow(/https/);
    expect(feedUrl('http://127.0.0.1:8080/s/', true)).toBe(
      'http://127.0.0.1:8080/s/stratlas-update.json',
    );
    expect(() => feedUrl('http://u.example.com/s/', true)).toThrow(/https/);
    expect(() => feedUrl('file:///C:/feed.json', true)).toThrow(/https/);
    expect(signatureUrl('https://u.example.com/s/stratlas-update.json')).toBe(
      'https://u.example.com/s/stratlas-update.json.sig',
    );
  });

  it('refuses an installer on plain http', () => {
    const r = parseFeed(
      feed({ files: { 'win-x64': { ...file, url: 'http://u.example.com/a.exe' } } }),
      'https://u.example.com/s/stratlas-update.json',
      'win-x64',
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/https/) as unknown });
  });

  it('maps platform and CPU to a feed slot', () => {
    expect(platformKey('win32', 'x64')).toBe('win-x64');
    expect(platformKey('darwin', 'arm64')).toBe('mac-arm64');
    expect(platformKey('linux', 'x64')).toBeNull();
    expect(platformKey('win32', 'ia32')).toBeNull();
  });

  it('resolves the installer against the feed address and lower-cases the hash', () => {
    const r = parseFeed(feed(), 'https://u.example.com/s/stratlas-update.json', 'win-x64');
    expect(r).toEqual({
      ok: true,
      feed: expect.objectContaining({ version: '0.8.0' }) as unknown,
      file: {
        ...file,
        sha256: 'ab'.repeat(32),
        href: 'https://u.example.com/s/QuadrionAI-0.8.0-win-x64-setup.exe',
        name: 'QuadrionAI-0.8.0-win-x64-setup.exe',
      },
    });
    expect(parseFeed(feed(), 'https://u.example.com/f.json', 'mac-arm64')).toMatchObject({
      ok: true,
      file: null,
    });
  });

  it('refuses invalid feeds and non-http downloads', () => {
    expect(parseFeed('{', 'https://x/', 'win-x64')).toMatchObject({ ok: false });
    expect(parseFeed(feed({ version: 'latest' }), 'https://x/', 'win-x64')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/version/) as unknown,
    });
    const bad = feed({ files: { 'win-x64': { ...file, url: 'file:///C:/evil.exe' } } });
    expect(parseFeed(bad, 'https://x/', 'win-x64')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/http/) as unknown,
    });
  });
});
