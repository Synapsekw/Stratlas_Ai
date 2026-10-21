import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'electron-vite';
import { describe, expect, it } from 'vitest';
import { brokenChunk, placeEsmShim } from './esmShim';

// electron-vite 5's shim for Electron >= 30, as it inserts it.
const SHIM = `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`;

const HEAD = `import { join } from "node:path";\nimport fs from "node:fs";\n`;
const BODY = `function check(d, root) {
  d.assertWritable?.(root, "detector import");
  if ("conflict" in d) return join(__dirname, "x");
  return fs.existsSync(root);
}
export { check };
`;

describe('placeEsmShim', () => {
  it('moves a shim the regex put inside "detector import" to after the last import', () => {
    // where electron-vite's regex puts it: after `import");\n  if ("`
    const at = BODY.indexOf('if ("') + 'if ("'.length;
    const broken = HEAD + BODY.slice(0, at) + SHIM + BODY.slice(at);
    expect(brokenChunk('index.js', broken)).toMatch(/does not parse/);

    const out = placeEsmShim(broken, 'index.js');
    expect(out).toBe(HEAD.trimEnd() + SHIM + '\n' + BODY);
    expect(out).toContain('d.assertWritable?.(root, "detector import");');
    expect(brokenChunk('index.js', out ?? '')).toBeNull();
  });

  it('leaves a chunk alone when the shim is already after the imports, or absent', () => {
    expect(placeEsmShim(HEAD.trimEnd() + SHIM + BODY, 'index.js')).toBeNull();
    expect(placeEsmShim(HEAD + BODY, 'index.js')).toBeNull();
  });

  it('puts the shim first in a chunk without imports', () => {
    const at = BODY.indexOf('if ("') + 'if ("'.length;
    const out = placeEsmShim(BODY.slice(0, at) + SHIM + BODY.slice(at), 'index.js');
    expect(out).toBe(SHIM + BODY);
  });

  it('refuses a chunk that does not parse even without the shim', () => {
    expect(() => placeEsmShim(`${HEAD}${SHIM}const x = "open;\n`, 'index.js')).toThrow(
      /does not parse without the CommonJS shim/,
    );
  });
});

describe('brokenChunk', () => {
  it('names an empty or unparseable chunk', () => {
    expect(brokenChunk('index.js', '')).toBe('index.js is empty');
    expect(brokenChunk('index.js', ' \n')).toBe('index.js is empty');
    expect(brokenChunk('index.js', 'if ("\n')).toMatch(/^index\.js does not parse/);
    expect(brokenChunk('index.js', HEAD + BODY)).toBeNull();
  });
});

describe('electron-vite build with esmShimPlacement', () => {
  it('keeps a string literal with " import" in the main bundle', async () => {
    // inside apps/desktop so the fixture's config resolves vite and electron-vite from here
    const dir = await mkdtemp(
      join(resolve(import.meta.dirname, '../../node_modules'), '.esm-shim-'),
    );
    try {
      await writeFile(
        join(dir, 'package.json'),
        '{ "type": "module", "main": "out/main/index.js" }',
      );
      await writeFile(
        join(dir, 'main.js'),
        `import { join } from 'node:path';\n` +
          `export function check(d, root) {\n` +
          `  d.assertWritable?.(root, 'detector import');\n` +
          `  if ('conflict' in d) return join(__dirname, 'x');\n` +
          `  return root;\n}\n` +
          `console.log(check({ assertWritable: (_r, op) => console.log(op) }, 'r'));\n`,
      );
      const plugin = pathToFileURL(resolve(import.meta.dirname, 'esmShim.ts')).href;
      await writeFile(
        join(dir, 'electron.vite.config.mjs'),
        `import { esmShimPlacement } from ${JSON.stringify(plugin)};\n` +
          `export default { main: { plugins: [esmShimPlacement()], build: {\n` +
          `  rollupOptions: { input: { index: ${JSON.stringify(join(dir, 'main.js'))} }, output: { format: 'es' } } } } };\n`,
      );
      await build({
        root: dir,
        configFile: join(dir, 'electron.vite.config.mjs'),
        logLevel: 'silent',
      });
      const out = await readFile(join(dir, 'out/main/index.js'), 'utf8');
      expect(out).toContain('d.assertWritable?.(root, "detector import");');
      expect(out).toContain('-- CommonJS Shims --');
      expect(brokenChunk('index.js', out)).toBeNull();
      // the shim sits after the import, not in the string
      expect(out.indexOf('-- CommonJS Shims --')).toBeLessThan(out.indexOf('detector import'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
