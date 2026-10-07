import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_CSP,
  APP_CSP_DIRECTIVES,
  cspMetaTag,
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

  it('reaches nothing remote', () => {
    expect(APP_CSP).not.toMatch(/https?:|wss?:|\*/);
  });

  it('keeps aio:// sources and blob: workers', () => {
    expect(APP_CSP).toContain("default-src 'self' aio:");
    expect(APP_CSP).toContain("connect-src 'self' aio: data: blob:");
    expect(APP_CSP).toContain("worker-src 'self' blob:");
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
