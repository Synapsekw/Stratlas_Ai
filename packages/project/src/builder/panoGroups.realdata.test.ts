import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupPanoFrames } from './panoGroups';
import { readPanoFrameMeta } from './panoScan';

const pairs = (process.env.QUADRION_PANO_REFERENCE ?? '')
  .split(';')
  .filter(Boolean)
  .map((p) => {
    const at = p.lastIndexOf('=');
    return { folder: p.slice(0, at), count: Number(p.slice(at + 1)) };
  });

async function jpegs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await jpegs(p)));
    else if (/\.jpe?g$/i.test(e.name)) out.push(p);
  }
  return out;
}

describe.skipIf(pairs.length === 0)(
  '@realdata drone sphere grouping on the reference folders',
  () => {
    pairs.forEach(({ folder, count }, i) => {
      it(`finds ${String(count)} spheres in reference folder ${String(i + 1)}`, async () => {
        const metas = await Promise.all((await jpegs(folder)).map((f) => readPanoFrameMeta(f)));
        const g = groupPanoFrames(metas);
        expect(g.spheres.filter((s) => s.shape === 'sphere')).toHaveLength(count);
        const seen = new Set<string>();
        for (const s of g.spheres) {
          const sizes = new Set(s.frames.map((f) => `${String(f.width)}x${String(f.height)}`));
          expect([...sizes]).toHaveLength(1);
          for (const f of s.frames) {
            // a stitched output is never a frame, whatever its aspect ratio
            expect(f.gpano).toBeUndefined();
            expect(seen.has(f.file)).toBe(false);
            seen.add(f.file);
          }
        }
      }, 120_000);
    });
  },
);
