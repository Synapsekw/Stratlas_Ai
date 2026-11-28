import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
await require('esbuild').build({
  entryPoints: [fileURLToPath(new URL('./atlas.js', import.meta.url))],
  bundle: true,
  format: 'esm',
  outfile: fileURLToPath(
    new URL('../assets/fusion/atlas.bundle.js', import.meta.url),
  ),
  minify: true,
  target: 'es2022',
});
console.log('Built dark Atlas with the production video projector.');
