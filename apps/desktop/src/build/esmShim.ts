import { parseSync, type Plugin } from 'vite';

/**
 * electron-vite's `vite:esm-shim` (electron-vite 5) adds a CommonJS shim (`__filename`,
 * `__dirname`, `require`) to every ES main chunk that uses them, after the chunk's last static
 * `import`. It finds that import with a regular expression over the chunk's text, not a parser,
 * so a string such as `"detector import"` followed later by another quote reads as
 * `import "<specifier>"`: the shim then lands inside a string in the middle of the code, the chunk
 * no longer parses and rolldown writes it EMPTY without an error (an app with no main process).
 *
 * `esmShimPlacement` runs after it (a user `post` plugin comes after electron-vite's built-in
 * ones) and moves the shim to where it belongs, after the chunk's last top-level import found by
 * a parser. `generateBundle` then fails the build on any main chunk that is empty or does not
 * parse, so a broken main bundle can never pass silently again.
 */

const SHIM_START = '\n// -- CommonJS Shims --\n';
const SHIM_END = '.createRequire(import.meta.url);\n';

function parseErrors(fileName: string, code: string): string[] {
  return parseSync(fileName, code, { sourceType: 'module' }).errors.map((e) => e.message);
}

/**
 * `code` with electron-vite's CommonJS shim right after its last top-level import, or null when
 * there is no shim or it is already there. Throws when the chunk does not parse without the shim
 * (the chunk itself is broken, not the shim's place).
 */
export function placeEsmShim(code: string, fileName: string): string | null {
  const from = code.indexOf(SHIM_START);
  if (from < 0) return null;
  const endAt = code.indexOf(SHIM_END, from);
  if (endAt < 0) throw new Error(`${fileName}: CommonJS shim without its end`);
  const to = endAt + SHIM_END.length;
  const shim = code.slice(from, to);
  const rest = code.slice(0, from) + code.slice(to);
  const parsed = parseSync(fileName, rest, { sourceType: 'module' });
  if (parsed.errors.length) {
    throw new Error(
      `${fileName}: does not parse without the CommonJS shim: ${parsed.errors.map((e) => e.message).join('; ')}`,
    );
  }
  const imports = parsed.program.body.filter((n) => n.type === 'ImportDeclaration');
  const at = imports.at(-1)?.end ?? 0;
  if (at === from) return null;
  return rest.slice(0, at) + shim + rest.slice(at);
}

/** Why a built main chunk is unusable, or null when it is fine. */
export function brokenChunk(fileName: string, code: string): string | null {
  if (code.trim() === '') return `${fileName} is empty`;
  const errors = parseErrors(fileName, code);
  return errors.length ? `${fileName} does not parse: ${errors.join('; ')}` : null;
}

export function esmShimPlacement(): Plugin {
  return {
    name: 'aio-esm-shim-placement',
    apply: 'build',
    enforce: 'post',
    renderChunk(code, chunk, options) {
      if (options.format !== 'es') return null;
      const out = placeEsmShim(code, chunk.fileName);
      // The main build writes no source maps (electron-vite's main preset), so none is returned.
      return out === null ? null : { code: out, map: null };
    },
    generateBundle(_options, bundle) {
      const broken = Object.values(bundle).flatMap((f) =>
        f.type === 'chunk' ? (brokenChunk(f.fileName, f.code) ?? []) : [],
      );
      if (broken.length) {
        this.error(
          `Main bundle unusable (the app would have no main process):\n${broken.join('\n')}`,
        );
      }
    },
  };
}
