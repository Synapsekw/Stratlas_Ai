import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isAppSender, rendererUrlAllowed } from './rendererUrl';

describe('rendererUrlAllowed', () => {
  it('allows the app, aio:// and data/blob', () => {
    expect(rendererUrlAllowed('file:///C:/app/out/renderer/index.html')).toBe(true);
    expect(rendererUrlAllowed('aio://project/p1/a.glb')).toBe(true);
    expect(rendererUrlAllowed('blob:file:///x')).toBe(true);
    expect(rendererUrlAllowed('data:image/png;base64,AA')).toBe(true);
  });

  it('refuses the network', () => {
    for (const u of ['http://x.test/', 'https://x.test/', 'ws://x', 'wss://x', 'ftp://x'])
      expect(rendererUrlAllowed(u)).toBe(false);
  });

  it('refuses file:// URLs that reach another computer', () => {
    expect(rendererUrlAllowed('file://server/share/a.png')).toBe(false);
    expect(rendererUrlAllowed('file:////server/share/a.png')).toBe(false);
    expect(rendererUrlAllowed('file://192.168.1.4/c$/a.png')).toBe(false);
  });

  it("allows the dev server's hot-reload socket only when one is set", () => {
    const dev = 'http://localhost:5173';
    expect(rendererUrlAllowed('ws://localhost:5173/?token=abc', dev)).toBe(true);
    expect(rendererUrlAllowed('ws://localhost:5174/?token=abc', dev)).toBe(false);
    expect(rendererUrlAllowed('ws://localhost:5173.evil.test/', dev)).toBe(false);
    expect(rendererUrlAllowed('ws://localhost:5173/?token=abc')).toBe(false);
  });

  it('allows the dev server only when one is set', () => {
    expect(rendererUrlAllowed('http://localhost:5173/src/main.tsx', 'http://localhost:5173')).toBe(
      true,
    );
    expect(rendererUrlAllowed('http://localhost:5173.evil.test/', 'http://localhost:5173')).toBe(
      false,
    );
    expect(rendererUrlAllowed('http://localhost:5173/x')).toBe(false);
  });
});

describe('isAppSender', () => {
  const indexFile = join(process.cwd(), 'out', 'renderer', 'index.html');
  const own = pathToFileURL(indexFile).href;

  it('accepts the top frame of the app page, with a query or hash', () => {
    expect(isAppSender({ url: own, top: true }, { indexFile })).toBe(true);
    expect(isAppSender({ url: `${own}?a=1#x`, top: true }, { indexFile })).toBe(true);
  });

  it('refuses a sub-frame, another file, another scheme or no frame', () => {
    expect(isAppSender({ url: own, top: false }, { indexFile })).toBe(false);
    const other = pathToFileURL(join(process.cwd(), 'evil.html')).href;
    expect(isAppSender({ url: other, top: true }, { indexFile })).toBe(false);
    expect(isAppSender({ url: 'aio://project/p1/x.html', top: true }, { indexFile })).toBe(false);
    expect(isAppSender({ url: 'https://evil.test/', top: true }, { indexFile })).toBe(false);
    expect(isAppSender(null, { indexFile })).toBe(false);
  });

  it('in dev accepts the dev server only', () => {
    const devUrl = 'http://localhost:5173';
    expect(isAppSender({ url: 'http://localhost:5173/', top: true }, { indexFile, devUrl })).toBe(
      true,
    );
    expect(isAppSender({ url: own, top: true }, { indexFile, devUrl })).toBe(false);
  });
});
