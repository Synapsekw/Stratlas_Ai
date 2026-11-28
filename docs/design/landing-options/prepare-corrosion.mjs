import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flareProject } from './private-sources.mjs';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const source = flareProject();
const out = path.resolve(here, '../assets/corrosion');
const sharp = require('sharp');
await mkdir(out, { recursive: true });
const manifest = JSON.parse(
  await readFile(path.join(source, 'manifest.json'), 'utf8'),
);
const { issues } = JSON.parse(
  await readFile(path.join(source, 'issues.json'), 'utf8'),
);
const model = manifest.layers.find((l) => l.kind === 'mesh');
const photos = manifest.layers.find((l) => l.kind === 'photos').items;
await copyFile(path.join(source, model.src.path), path.join(out, 'stack.glb'));
const records = [],
  chunks = [];
let offset = 0;
for (const issue of issues) {
  const sighting = issue.sightings.find(
    (s) => s.on === 'mesh' && s.geom.type === 'spatch',
  );
  if (!sighting) continue;
  const p = JSON.parse(
    await readFile(path.join(source, sighting.geom.src.path), 'utf8'),
  );
  const photo = photos.find((v) => v.id === p.photo);
  const id = issue.code;
  if (!/^F\d+$/.test(id))
    throw new Error('Unexpected source record identifier');
  const positions = new Float32Array(p.positions),
    uvs = new Float32Array(p.uvs);
  const zone = issue.note.match(/side, ([^.]+)\./)?.[1] || p.component;
  const coverage = Number(issue.note.match(/Marked area ([\d.]+)/)?.[1] || 0);
  records.push({
    id,
    title: issue.title,
    description: issue.note.split('\n')[0],
    component: p.component,
    zone,
    severity: issue.severity,
    classId: issue.classId,
    center: p.center,
    photoId: p.photo,
    coverage,
    camera: { pos: photo.pos, q: photo.q, lens: photo.lens },
    vertexCount: p.vertexCount,
    offset,
    texture: `${id}-patch.png`,
    photo: `${id}.webp`,
    mask: `${id}-mask.png`,
    uncertain: !!issue.sightings.find(
      (s) => s.on === 'image' && s.geom.src?.path?.includes('uncertain'),
    ),
  });
  chunks.push(Buffer.from(positions.buffer), Buffer.from(uvs.buffer));
  offset += positions.byteLength + uvs.byteLength;
  await copyFile(
    path.join(source, p.texture),
    path.join(out, `${id}-patch.png`),
  );
  await sharp(path.join(source, photo.src.path))
    .resize({ width: 1600, withoutEnlargement: true })
    .webp({ quality: 84 })
    .toFile(path.join(out, `${id}.webp`));
  const mask = issue.sightings.find(
    (s) => s.on === 'image' && s.photo === p.photo && s.geom.type === 'mask',
  );
  if (!mask) throw new Error(`Missing source mask for ${id}`);
  await sharp(path.join(source, mask.geom.src.path))
    .resize({ width: 1024, kernel: 'nearest' })
    .png()
    .toFile(path.join(out, `${id}-mask.png`));
}
await writeFile(path.join(out, 'patches.bin'), Buffer.concat(chunks));
await writeFile(
  path.join(out, 'data.json'),
  JSON.stringify({
    transform: model.transform,
    records,
    legend: manifest.classCatalogues[0].classes.map(({ id, label, color }) => ({
      id,
      label,
      color,
    })),
  }),
);
await require('esbuild').build({
  entryPoints: [path.join(here, 'corrosion.js')],
  bundle: true,
  format: 'esm',
  outfile: path.join(out, 'corrosion.bundle.js'),
  minify: true,
  target: 'es2022',
});
console.log(
  `Prepared ${records.length} original surface patches, source masks and photos. No source project files changed.`,
);
