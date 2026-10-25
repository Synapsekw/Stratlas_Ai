import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleScript, dataUriOf, inlineImports } from './inlineImports';

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-inline-'));
  await writeFile(join(dir, 'dep.ts'), 'export const word: string = "hello";\n');
  await writeFile(
    join(dir, 'entry.ts'),
    'import { word } from "./dep";\nexport function say(): string { return word; }\n(globalThis as { said?: string }).said = say();\n',
  );
  await writeFile(join(dir, 'font.woff2'), Buffer.from([1, 2, 3, 250]));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('inline imports', () => {
  it('bundles a module and its imports into one self-running script', async () => {
    const code = await bundleScript(join(dir, 'entry.ts'));
    expect(code).not.toMatch(/\bimport\b|\bexport\b/);
    const scope: { said?: string } = {};
    runInNewContext(code, scope);
    expect(scope.said).toBe('hello');
  });

  it('reads a file as a data: URI with its media type', async () => {
    expect(await dataUriOf(join(dir, 'font.woff2'))).toBe('data:font/woff2;base64,AQID+g==');
  });

  it('serves `?script` and `?datauri` imports as default-exported strings', async () => {
    const plugin = inlineImports();
    const resolveHook = plugin.resolveId as (
      this: unknown,
      source: string,
      importer: string,
    ) => Promise<string | null>;
    const loadHook = plugin.load as (this: unknown, id: string) => Promise<string | null>;
    const ctx = {
      addWatchFile: () => undefined,
      resolve: (source: string) => Promise.resolve({ id: join(dir, source) }),
    };
    // resolved to a virtual id (no CSS or asset plugin takes it), then loaded from it
    const load = async (source: string) => {
      const id = await resolveHook.call(ctx, source, join(dir, 'x.ts'));
      expect(id?.startsWith('\0')).toBe(true);
      return loadHook.call(ctx, id ?? '');
    };
    const script = await load('entry.ts?script');
    expect(script).toMatch(/^export default "/);
    expect(await load('font.woff2?datauri')).toBe(
      'export default "data:font/woff2;base64,AQID+g==";',
    );
    expect(await load('dep.ts?text')).toBe(
      `export default ${JSON.stringify('export const word: string = "hello";\n')};`,
    );
    expect(await resolveHook.call(ctx, 'entry.ts', join(dir, 'x.ts'))).toBeNull();
    expect(await loadHook.call(ctx, join(dir, 'entry.ts'))).toBeNull();
  });
});
