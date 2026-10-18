/**
 * The 3D view and the map are read through `activeViews.ts` only: a local copy that reads the
 * active view once on its first render and listens in an effect misses a view that comes up in
 * between (the hooks' own behaviour is in `PhotoMenu.views.test.tsx`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

it('no renderer file keeps its own copy of useScene or useMap', () => {
  const copies = sources(root)
    .filter((p) => !p.endsWith('activeViews.ts'))
    .filter((p) => /function use(Scene|Map)\(/.test(readFileSync(p, 'utf8')))
    .map((p) => relative(root, p).replaceAll('\\', '/'));
  expect(copies).toEqual([]);
});
