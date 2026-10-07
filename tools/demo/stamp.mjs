// Hash of the demo generator's own sources: a demo built by another version of the generator is
// stale, and tools/release/dist.mjs rebuilds it before packaging.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));

export function generatorStamp() {
  const h = createHash('sha256');
  for (const f of readdirSync(dir).sort()) {
    if (!/\.(mjs|py)$/.test(f) || f.endsWith('.test.mjs')) continue;
    h.update(f);
    h.update(readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n'));
  }
  // M10: the photo demo's generator lives with the pipeline tests
  const synth = join(dir, '..', '..', 'python', 'tests', 'photo_synth.py');
  h.update('photo_synth.py');
  h.update(readFileSync(synth, 'utf8').replace(/\r\n/g, '\n'));
  return h.digest('hex').slice(0, 16);
}
