/**
 * The app's Content Security Policy: one source for both ways it reaches a page.
 *
 * - Built pages load from `file://` (the main window, the report windows, the printed guide).
 *   `session.webRequest.onHeadersReceived` never sees a `file://` load, so the build writes the
 *   policy into each renderer HTML entry as `<meta http-equiv="Content-Security-Policy">`
 *   (electron.vite.config.ts, `cspMeta`).
 * - In dev the pages come from the Vite dev server over http, and main sets the same policy as
 *   a response header (index.ts, `hardenSession`). The meta is added at build only.
 *
 * Legacy viewer documents (`aio://project/<id>/legacy/*.html`) have their own policy, sent by the
 * aio:// handler as a header (protocol/legacy.ts, `LEGACY_CSP`).
 *
 * This module is imported by the Vite config at build time, so it must not import Electron.
 */

/** Directives a `<meta>` policy ignores (CSP3 §6.1); they only work as a header. */
export const HEADER_ONLY_DIRECTIVES = ['frame-ancestors', 'report-uri', 'sandbox'] as const;

/** The app policy, one directive per entry. */
export const APP_CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self' aio:",
  // WebAssembly compile only (Meshopt GLB decoder, laz-perf), no JavaScript eval or inline script.
  // Workers are same-origin modules (`file://.../assets/*.js`, pdf.js, Cesium's Workers/) or blob:
  // (MapLibre); WebGL needs no directive.
  "script-src 'self' 'wasm-unsafe-eval'",
  // React and MapLibre set style attributes
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' aio: data: blob:",
  "media-src 'self' aio: blob:",
  // aio:// project files and PMTiles packs (range requests), data:/blob: decoded in the page
  "connect-src 'self' aio: data: blob:",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
];

/** The app policy as a header value (dev, and any response main can add a header to). */
export const APP_CSP = APP_CSP_DIRECTIVES.join('; ');

const directiveName = (d: string) => d.trim().split(/\s+/)[0]?.toLowerCase() ?? '';

/**
 * The policy for a `<meta http-equiv>` tag: `policy` without the directives a meta tag cannot
 * carry (`frame-ancestors`, `report-uri`, `sandbox`), which stay header-only. The app policy has
 * none of them today, so its meta and header values are equal (csp.test.ts).
 */
export function metaPolicy(policy: string): string {
  const skip: readonly string[] = HEADER_ONLY_DIRECTIVES;
  return policy
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d !== '' && !skip.includes(directiveName(d)))
    .join('; ');
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The `<meta>` tag for `policy`. */
export function cspMetaTag(policy: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(metaPolicy(policy))}" />`;
}

/**
 * Inline `<script>` elements (no `src`) in built HTML. The app policy has no 'unsafe-inline' and
 * no hashes for scripts, so the build fails on any (electron.vite.config.ts) instead of shipping
 * a page whose script the policy blocks.
 */
export function inlineScripts(html: string): string[] {
  const found: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    // data blocks are never run (an import map is, and needs the policy's leave)
    if (/\btype\s*=\s*["']?application\/(ld\+)?json/i.test(attrs)) continue;
    if (body.trim() !== '') found.push(m[0].slice(0, 200));
  }
  return found;
}
