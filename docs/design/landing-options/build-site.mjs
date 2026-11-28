import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { finishPage } from './quadrion-site.mjs';
import { refineHome } from './quadrion-home.mjs';
await import('./render-directions.mjs');
await import('./render-inspection.mjs');
await import('./render-corrosion.mjs');
await import('./render-use-cases.mjs');
const local = (name) => new URL(name, import.meta.url);
await copyFile(
  local('../../../docs/brand/quadrion/kit/lockup/quadrion-horizontal-on-dark.svg'),
  local('quadrion-wordmark.svg'),
);
await copyFile(local('../../../docs/brand/quadrion/kit/favicon/favicon.svg'), local('brand.svg'));
for (const page of [
  'atlas',
  'confined-spaces',
  'corrosion',
  'evidence',
  'reporting',
  'roads',
  'volumetric',
  'facades',
]) {
  let html = await readFile(local(page + '.html'), 'utf8');
  if (page === 'atlas') html = refineHome(html);
  await writeFile(local(page + '.html'), finishPage(html, page));
}
for (const page of ['index', 'mission', 'precision'])
  await writeFile(
    local(page + '.html'),
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=atlas.html"><title>Quadrion AI</title></head><body><a href="atlas.html">Explore Quadrion AI</a></body></html>',
  );
for (const [entry, folder] of [
  ['atlas', 'fusion'],
  ['inspection', 'inspection'],
  ['corrosion', 'corrosion'],
  ['use-cases', 'use-cases'],
])
  await build({
    entryPoints: [fileURLToPath(local(entry + '.js'))],
    bundle: true,
    format: 'esm',
    splitting: entry === 'use-cases',
    outdir: fileURLToPath(local('../assets/' + folder + '/')),
    entryNames: entry + '.bundle',
    chunkNames: 'q-[name]-[hash]',
    minify: true,
    target: 'es2022',
  });
console.log('Built eight Quadrion AI experiences and canonical Atlas entry points.');
