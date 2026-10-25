import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { build, type Plugin } from 'vite';

/**
 * Import suffixes for files that are embedded as text rather than loaded by URL (the offline
 * volumetric HTML report, which may load nothing):
 *
 * - `?script`: the module and everything it imports, bundled to one minified IIFE, as a string
 *   (`import code from './viewer/viewer.ts?script'`). The report puts it in one inline `<script>`
 *   and names its SHA-256 in the file's own CSP.
 * - `?datauri`: the file as a `data:` URI (`data:font/woff2;base64,...`), for fonts.
 * - `?text`: the file's text as it is on disk, for stylesheets (Vite's `?raw` of a `.css` file
 *   comes back empty in Vitest, which does not process CSS).
 *
 * Used by the renderer build (electron.vite.config.ts) and by Vitest (vitest.config.ts), so the
 * tests embed the same bytes the app does.
 */

const MEDIA: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const SUFFIX = /\?(script|datauri|text)$/;

/**
 * The resolved id is virtual and names the file in base64url, so no other plugin takes the file as
 * its own (Vitest empties every id that ends in `.css`, Vite's CSS plugin would parse it).
 */
const PREFIX = '\0aio-inline:';

/** A module bundled with its imports into one minified IIFE (no `import` or `export` left). */
export async function bundleScript(entry: string): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    publicDir: false,
    build: {
      write: false,
      minify: true,
      sourcemap: false,
      copyPublicDir: false,
      lib: { entry, formats: ['iife'], name: 'QuadrionInline', fileName: () => 'inline.js' },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const out of outputs) {
    if (!('output' in out)) continue;
    for (const o of out.output) if (o.type === 'chunk') return o.code.trim();
  }
  throw new Error(`${entry}: the bundle has no script`);
}

/** A file as a base64 `data:` URI of its media type (by extension). */
export async function dataUriOf(file: string): Promise<string> {
  const type = MEDIA[extname(file).toLowerCase()];
  if (!type) throw new Error(`${file}: no media type for a data: URI`);
  return `data:${type};base64,${(await readFile(file)).toString('base64')}`;
}

export function inlineImports(): Plugin {
  return {
    name: 'aio-inline-imports',
    enforce: 'pre',
    async resolveId(source, importer) {
      const m = SUFFIX.exec(source);
      if (!m) return null;
      const resolved = await this.resolve(source.slice(0, m.index), importer, { skipSelf: true });
      if (!resolved) return null;
      return `${PREFIX}${m[1] ?? ''}:${Buffer.from(resolved.id.split('?')[0] ?? resolved.id).toString('base64url')}`;
    },
    async load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const rest = id.slice(PREFIX.length);
      const colon = rest.indexOf(':');
      const kind = rest.slice(0, colon);
      const file = Buffer.from(rest.slice(colon + 1), 'base64url').toString('utf8');
      this.addWatchFile(file);
      if (kind === 'script') return `export default ${JSON.stringify(await bundleScript(file))};`;
      if (kind === 'text') return `export default ${JSON.stringify(await readFile(file, 'utf8'))};`;
      return `export default ${JSON.stringify(await dataUriOf(file))};`;
    },
  };
}
