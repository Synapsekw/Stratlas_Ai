import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { brotliCompress, constants } from 'node:zlib';
import { promisify } from 'node:util';
const compress = promisify(brotliCompress);
let original = 0,
  packed = 0;
for (const folder of ['fusion', 'inspection', 'corrosion', 'use-cases']) {
  const dir = new URL('../assets/' + folder + '/', import.meta.url);
  for (const name of await readdir(dir)) {
    if (!/\.(glb|xyz|bin|js|json)$/.test(name)) continue;
    const source = new URL(name, dir),
      target = new URL(name + '.br', dir);
    const input = await stat(source),
      output = await stat(target).catch(() => null);
    if (!output || output.mtimeMs < input.mtimeMs) {
      const bytes = await compress(await readFile(source), {
        params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
      });
      await writeFile(target, bytes);
    }
    original += input.size;
    packed += (await stat(target)).size;
  }
}
console.log(
  `Lossless transfer assets: ${(original / 1e6).toFixed(1)} MB → ${(packed / 1e6).toFixed(1)} MB. Original model and survey data preserved.`,
);
