import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetFolder, previewEnv, projectFolder, requiredEnv } from './private-sources.mjs';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { build } = require('esbuild');
const { Matrix4, Vector3, Quaternion, Euler } = await import('three');
const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, '../assets/fusion');
const source = assetFolder(
  'PLANT_ASSETS',
  'the prepared plant assets (a folder name under docs/design/assets, or a path)',
);
const projectRoot = projectFolder(
  'PLANT_PROJECT',
  'the plant source project (a path, or a folder name)',
);
const clipLayer = requiredEnv(
  'PLANT_CLIP_LAYER',
  'the id of the flight clip layer in the plant project manifest',
);
await mkdir(output, { recursive: true });
for (const [from, to] of [
  ['plant.glb', 'site.glb'],
  ['ortho.jpg', 'survey.jpg'],
  ['clip_dji0789_tanks.mp4', 'flight.mp4'],
  ['clip_dji0789_tanks_poster.jpg', 'flight.jpg'],
]) {
  await copyFile(path.join(source, from), path.join(output, to));
}
const flight = JSON.parse(
  await readFile(path.join(source, 'clip_dji0789_tanks_path.json'), 'utf8'),
);
const ortho = JSON.parse(await readFile(path.join(source, 'ortho.json'), 'utf8'));
await writeFile(path.join(output, 'survey.json'), JSON.stringify(ortho.placement_xz));
// The production cloud is in the project's local CRS. Restore the model frame
// using the inverse of its manifest transform so all four views share a pose.
const manifest = JSON.parse(await readFile(path.join(projectRoot, 'manifest.json'), 'utf8'));
const index = JSON.parse(
  await readFile(
    path.join(
      projectRoot,
      previewEnv('PLANT_CLOUD_INDEX') ?? `clouds/${path.basename(projectRoot)}/index.json`,
    ),
    'utf8',
  ),
);
const chunk = index.chunks.find((c) => c.lod === 0);
const { data, info } = await sharp(path.join(projectRoot, chunk.file))
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
if (info.channels !== 3) throw new Error('Expected RGB-packed cloud');
const stride = 2,
  n = Math.ceil(chunk.points / stride);
const positions = new Float32Array(n * 3),
  colors = new Uint8Array(n * 3);
const inverse = new Matrix4()
  .fromArray(manifest.layers.find((l) => l.id === 'plant').transform)
  .invert();
const layer = manifest.layers.find((l) => l.id === clipLayer);
const logged = JSON.parse(await readFile(path.join(projectRoot, layer.flight.src.path), 'utf8'));
const inverseRotation = new Quaternion().setFromRotationMatrix(inverse);
const bias = layer.orientation;
const calibration = new Quaternion().setFromEuler(
  new Euler(
    (bias.pitchDeg * Math.PI) / 180,
    (bias.yawDeg * Math.PI) / 180,
    (bias.rollDeg * Math.PI) / 180,
    'YXZ',
  ),
);
const start = flight.clip_start_in_source_s * 1000;
const samples = logged.samples
  .filter((s) => s.t >= start && s.t <= start + 11000)
  .map((s) => ({
    t: (s.t - start) / 1000,
    pos: new Vector3()
      .fromArray(s.pos)
      .add(new Vector3().fromArray(layer.positionOffsetM))
      .applyMatrix4(inverse)
      .toArray(),
    q: inverseRotation
      .clone()
      .multiply(new Quaternion().fromArray(s.q))
      .multiply(calibration)
      .normalize()
      .toArray(),
  }));
await writeFile(
  path.join(output, 'flight.json'),
  JSON.stringify({ hfov: layer.lens.hfovDeg, aspect: layer.lens.aspect, samples }),
);
const point = new Vector3();
for (let i = 0, k = 0; i < chunk.points; i += stride, k++) {
  const coords = [0, 1, 2].map(
    (a) =>
      chunk.quant.offset[a] +
      chunk.quant.scale *
        (data[2 * a * chunk.points + i] | (data[(2 * a + 1) * chunk.points + i] << 8)),
  );
  point
    .set(...coords)
    .applyMatrix4(inverse)
    .toArray(positions, k * 3);
  for (let a = 0; a < 3; a++) colors[k * 3 + a] = data[(6 + a) * chunk.points + i];
}
await writeFile(path.join(output, 'cloud.xyz'), new Uint8Array(positions.buffer));
await writeFile(path.join(output, 'cloud.rgb'), colors);
await writeFile(
  path.join(output, 'cloud.json'),
  JSON.stringify({
    count: n,
    source: 'Captured photogrammetry, subsampled from the survey cloud',
    frame: 'Aligned model frame',
    stride,
  }),
);
await build({
  entryPoints: [path.join(here, 'fusion.js')],
  bundle: true,
  format: 'esm',
  outfile: path.join(output, 'fusion.bundle.js'),
  minify: true,
  target: 'es2022',
  logLevel: 'warning',
});
console.log(`Prepared ${n.toLocaleString()} captured points and bundled the fusion experience.`);
await import('./build-atlas.mjs');
