import { describe, expect, it } from 'vitest';
import {
  cspForUrl,
  injectIntoHead,
  isLegacyDocument,
  LEGACY_CSP,
  stripRemoteLinks,
  shimTag,
} from './legacy';

describe('isLegacyDocument', () => {
  it.each([
    [['legacy', 'Masafi Stockpile Review.html'], true],
    [['legacy', 'sub', 'index.HTM'], true],
    [['legacy', 'data', 'site.js'], false],
    [['report', 'index.html'], false],
    [['index.html'], false],
    [['legacy'], false],
  ])('%j is %s', (segments, expected) => {
    expect(isLegacyDocument(segments)).toBe(expected);
  });
});

describe('cspForUrl', () => {
  const app = "default-src 'self'";
  it('gives legacy documents the legacy policy', () => {
    expect(cspForUrl('aio://project/masafi/legacy/Masafi%20Review.html', app)).toBe(LEGACY_CSP);
  });
  it("leaves Chromium's own pages alone (the built-in PDF viewer needs chrome://resources)", () => {
    expect(cspForUrl('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html', app)).toBe(
      null,
    );
    expect(cspForUrl('chrome://resources/js/load_time_data.js', app)).toBe(null);
    expect(cspForUrl('devtools://devtools/bundled/devtools_app.html', app)).toBe(null);
  });
  it('sets no policy on a PDF, which the built-in viewer renders', () => {
    expect(cspForUrl('aio://project/masafi/legacy/Volume%20Report.PDF', app)).toBe(null);
  });
  it('keeps the app policy for everything else', () => {
    expect(cspForUrl('aio://project/masafi/legacy/data/site.js', app)).toBe(app);
    expect(cspForUrl('aio://project/masafi/report.html', app)).toBe(app);
    expect(cspForUrl('file:///C:/app/index.html', app)).toBe(app);
    expect(cspForUrl('not a url', app)).toBe(app);
  });
});

describe('LEGACY_CSP', () => {
  const directive = (name: string) =>
    LEGACY_CSP.split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `)) ?? '';

  it('allows the viewer its own aio: scripts, inline scripts and wasm, nothing remote', () => {
    expect(directive('script-src')).toContain("'self'");
    expect(directive('script-src')).toContain("'unsafe-inline'");
    expect(directive('script-src')).toContain("'wasm-unsafe-eval'");
    expect(LEGACY_CSP).not.toMatch(/https?:|\*/);
  });

  it('allows embedded data fonts and blob workers', () => {
    expect(directive('font-src')).toContain('data:');
    expect(directive('worker-src')).toContain('blob:');
    expect(directive('connect-src')).toContain("'self'");
  });
});

describe('injectIntoHead', () => {
  const tag = '<script>S</script>';
  it('puts the tag first inside <head>, before any viewer script', () => {
    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><script src="a.js">';
    expect(injectIntoHead(html, tag)).toBe(
      '<!doctype html><html lang="en"><head><script>S</script><meta charset="utf-8"><script src="a.js">',
    );
  });
  it('handles <head> with attributes and any case', () => {
    expect(injectIntoHead('<HEAD class="x"><title>t</title>', tag)).toBe(
      '<HEAD class="x"><script>S</script><title>t</title>',
    );
  });
  it('falls back to after <html> when there is no head', () => {
    expect(injectIntoHead('<!DOCTYPE html><html><body>x', tag)).toBe(
      '<!DOCTYPE html><html><script>S</script><body>x',
    );
  });
  it('falls back to after the doctype, then to the very start', () => {
    expect(injectIntoHead('<!doctype html><p>x', tag)).toBe(
      '<!doctype html><script>S</script><p>x',
    );
    expect(injectIntoHead('<p>x', tag)).toBe('<script>S</script><p>x');
  });
});

describe('stripRemoteLinks', () => {
  it('removes remote stylesheet and preconnect links (Google Fonts)', () => {
    const html =
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
      "<link href='https://fonts.googleapis.com/css2?family=IBM+Plex+Sans' rel='stylesheet'>" +
      '<link rel="stylesheet" href="//cdn.example.com/x.css">';
    const out = stripRemoteLinks(html);
    expect(out).not.toMatch(/googleapis|gstatic|cdn\.example/);
    expect(out).toContain('<!-- remote link removed for offline use -->');
  });
  it('keeps local links', () => {
    const html = '<link rel="stylesheet" href="lib/leaflet.css"><link rel="icon" href="data:,">';
    expect(stripRemoteLinks(html)).toBe(html);
  });
});

describe('shimTag', () => {
  it('is an inline script that cannot be closed early by the project id', () => {
    const tag = shimTag('evil</script><script>alert(1)');
    expect(tag.startsWith('<script>')).toBe(true);
    expect(tag.endsWith('</script>')).toBe(true);
    expect(tag.slice('<script>'.length, -'</script>'.length)).not.toMatch(/<\/script/i);
  });
});
