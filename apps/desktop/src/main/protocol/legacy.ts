import { SHIM_SOURCE } from './shim';

/**
 * Content Security Policy of a legacy viewer document (`aio://project/<id>/legacy/*.html`).
 *
 * The viewers are self-contained offline builds: large inline scripts, `<script src>` data
 * files and libraries next to the HTML, embedded data: fonts, blob: workers (Meshopt) and
 * WebAssembly. They may load anything from their own aio: origin and nothing remote; a remote
 * script (cdnjs pdf.js) or font fails and the viewer uses its own fallback.
 */
export const LEGACY_CSP = [
  "default-src 'self' aio:",
  "script-src 'self' aio: 'unsafe-inline' 'wasm-unsafe-eval' blob:",
  "style-src 'self' aio: 'unsafe-inline'",
  "img-src 'self' aio: data: blob:",
  "media-src 'self' aio: data: blob:",
  "connect-src 'self' aio: data: blob:",
  "worker-src 'self' aio: blob:",
  "font-src 'self' aio: data:",
  "frame-src 'self' aio: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const HTML = /\.html?$/i;

/** Path segments (after the project id) of an HTML document under the project's `legacy/` folder. */
export function isLegacyDocument(segments: readonly string[]): boolean {
  const last = segments.at(-1);
  return segments.length >= 2 && segments[0] === 'legacy' && last !== undefined && HTML.test(last);
}

/** The CSP for a response: the legacy policy for legacy documents, else the app policy. */
export function cspForUrl(url: string, appCsp: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return appCsp;
  }
  if (u.protocol !== 'aio:' || u.host !== 'project') return appCsp;
  const segments = u.pathname.split('/').filter((s) => s !== '');
  return isLegacyDocument(segments.slice(1)) ? LEGACY_CSP : appCsp;
}

/** Insert `tag` as the first child of `<head>` (or after `<html>`, the doctype, or at the start). */
export function injectIntoHead(html: string, tag: string): string {
  for (const re of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) {
      const at = m.index + m[0].length;
      return html.slice(0, at) + tag + html.slice(at);
    }
  }
  return tag + html;
}

const LINK = /<link\b[^>]*>/gi;
const REMOTE_HREF = /\bhref\s*=\s*["']?\s*(https?:)?\/\//i;

/** Remove `<link>` tags that point off the machine (Google Fonts, CDN stylesheets). */
export function stripRemoteLinks(html: string): string {
  return html.replace(LINK, (tag) =>
    REMOTE_HREF.test(tag) ? '<!-- remote link removed for offline use -->' : tag,
  );
}

/** The inline `<script>` that installs the shims for one project. */
export function shimTag(projectId: string): string {
  const cfg = JSON.stringify({ projectId }).replace(/</g, '\\u003c');
  return `<script>(${SHIM_SOURCE})(${cfg});</script>`;
}

/** Prepare a legacy viewer document for the host: no remote links, shims first. */
export function prepareLegacyHtml(html: string, projectId: string): string {
  return injectIntoHead(stripRemoteLinks(html), shimTag(projectId));
}
