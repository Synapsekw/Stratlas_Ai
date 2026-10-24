import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AIO_FILE_CSP,
  APP_CSP,
  APP_CSP_DIRECTIVES,
  cspForUrl,
  cspMetaTag,
  devAppCsp,
  HEADER_ONLY_DIRECTIVES,
  inlineScripts,
  metaPolicy,
} from './csp';

const unescape = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

function metaContent(tag: string): string {
  const m = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(tag);
  if (!m?.[1]) throw new Error(`not a CSP meta: ${tag}`);
  return unescape(m[1]);
}

describe('app CSP', () => {
  it('meta and header carry the same policy (no header-only directive in it)', () => {
    expect(metaContent(cspMetaTag(APP_CSP))).toBe(APP_CSP);
    expect(metaPolicy(APP_CSP)).toBe(APP_CSP);
  });

  it('allows no JavaScript eval and no inline script', () => {
    const script = APP_CSP_DIRECTIVES.find((d) => d.startsWith('script-src '));
    expect(script).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(APP_CSP).not.toContain("'unsafe-eval'");
    expect(script).not.toContain("'unsafe-inline'");
  });

  it('allows no plug-in and no frame', () => {
    expect(APP_CSP_DIRECTIVES).toContain("object-src 'none'");
    expect(APP_CSP_DIRECTIVES).toContain("frame-src 'none'");
  });

  it('reaches nothing remote', () => {
    expect(APP_CSP).not.toMatch(/https?:|wss?:|\*/);
  });

  it('keeps aio:// sources and blob: workers', () => {
    expect(APP_CSP).toContain("default-src 'self' aio:");
    expect(APP_CSP).toContain("connect-src 'self' aio: data: blob:");
    expect(APP_CSP).toContain("worker-src 'self' blob:");
  });
});

describe('devAppCsp', () => {
  const dev = devAppCsp('http://localhost:5173/');
  const directive = (name: string) => dev.split('; ').find((d) => d.startsWith(`${name} `));

  it("lets in Vite's inline React preamble and its hot-reload socket, nothing else", () => {
    expect(directive('script-src')).toBe("script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'");
    expect(directive('connect-src')).toBe(
      "connect-src 'self' aio: data: blob: ws://localhost:5173",
    );
  });

  it('keeps every other directive of the app policy', () => {
    const changed = ['script-src', 'connect-src'];
    const rest = (p: string) =>
      p.split('; ').filter((d) => !changed.some((c) => d.startsWith(`${c} `)));
    expect(rest(dev)).toEqual(rest(APP_CSP));
  });

  it('is the app policy when there is no dev server', () => {
    expect(devAppCsp(undefined)).toBe(APP_CSP);
    expect(devAppCsp('not a url')).toBe(APP_CSP);
  });
});

describe('cspForUrl', () => {
  const app = "default-src 'self'";
  it("leaves Chromium's own pages alone (the built-in PDF viewer needs chrome://resources)", () => {
    expect(cspForUrl('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html', app)).toBe(
      null,
    );
    expect(cspForUrl('chrome://resources/js/load_time_data.js', app)).toBe(null);
    expect(cspForUrl('devtools://devtools/bundled/devtools_app.html', app)).toBe(null);
  });
  it('sets no policy on a project PDF, which the built-in viewer renders', () => {
    expect(cspForUrl('aio://project/p1/report/Volume%20Report.PDF', app)).toBe(null);
    expect(cspForUrl('aio://project/p1/legacy/Volume%20Report.pdf', app)).toBe(null);
  });
  it('locks every other aio:// file opened as a page: no script, a sandbox', () => {
    expect(cspForUrl('aio://project/p1/legacy/Old%20Review.html', app)).toBe(AIO_FILE_CSP);
    expect(cspForUrl('aio://project/p1/legacy/data/site.js', app)).toBe(AIO_FILE_CSP);
    expect(cspForUrl('aio://project/p1/drawing.svg', app)).toBe(AIO_FILE_CSP);
    expect(cspForUrl('aio://packs/gcc.pdf', app)).toBe(AIO_FILE_CSP);
    expect(AIO_FILE_CSP).toContain("default-src 'none'");
    expect(AIO_FILE_CSP).toContain('sandbox');
    expect(AIO_FILE_CSP).not.toContain('script-src');
  });
  it('keeps the app policy for the app', () => {
    expect(cspForUrl('file:///C:/app/index.html', app)).toBe(app);
    expect(cspForUrl('not a url', app)).toBe(app);
  });
});

describe('metaPolicy', () => {
  it('drops the directives a meta policy ignores', () => {
    const policy = [
      "default-src 'self'",
      "frame-ancestors 'none'",
      'report-uri /csp',
      'sandbox allow-scripts',
      "img-src 'self'",
    ].join('; ');
    expect(metaPolicy(policy)).toBe("default-src 'self'; img-src 'self'");
    for (const d of HEADER_ONLY_DIRECTIVES) expect(metaPolicy(policy)).not.toContain(d);
  });
});

describe('inlineScripts', () => {
  it('finds inline scripts and ignores external ones and data blocks', () => {
    const html = [
      '<script type="module" crossorigin src="./assets/index.js"></script>',
      '<script type="application/json">{"a":1}</script>',
      '<script></script>',
      '<script type="module">import "x";</script>',
      '<script>window.a = 1</script>',
    ].join('\n');
    expect(inlineScripts(html)).toEqual([
      '<script type="module">import "x";</script>',
      '<script>window.a = 1</script>',
    ]);
  });
});

describe('renderer HTML entries', () => {
  const dir = join(import.meta.dirname, '../renderer');
  const pages = readdirSync(dir).filter((f) => f.endsWith('.html'));

  it('are the four pages the app loads from file://', () => {
    expect(pages.sort()).toEqual(['guide.html', 'house.html', 'index.html', 'report.html']);
  });

  it.each(pages)('%s has no policy or inline script of its own (the build adds the meta)', (f) => {
    const html = readFileSync(join(dir, f), 'utf8');
    expect(html).not.toMatch(/Content-Security-Policy/i);
    expect(inlineScripts(html)).toEqual([]);
  });
});
