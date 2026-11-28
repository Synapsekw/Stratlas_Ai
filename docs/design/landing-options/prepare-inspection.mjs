import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assetFolder } from './private-sources.mjs';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const source = assetFolder(
  'TANK_ASSETS',
  'the prepared tank assets (a folder name under docs/design/assets, or a path)',
);
const out = path.resolve(here, '../assets/inspection');
await mkdir(out, { recursive: true });
for (const [from, to] of [
  ['tank.glb', 'vessel.glb'],
  ['cloud.bin', 'scan.bin'],
  ['clip_f108_roof.mp4', 'interior.mp4'],
  ['clip_f108_roof_poster.jpg', 'interior.jpg'],
])
  await copyFile(path.join(source, from), path.join(out, to));
const pose = JSON.parse(await readFile(path.join(source, 'clip_f108_roof_pose.json'), 'utf8'));
await writeFile(
  path.join(out, 'flight.json'),
  JSON.stringify({
    duration: 11,
    lens: pose.lens,
    samples: pose.samples.map(({ t, pos, q }) => ({ t, pos, q })),
  }),
);
const sourceFindings = JSON.parse(await readFile(path.join(source, 'findings.json'), 'utf8'));
const findings = [];
for (const p of sourceFindings.photos) {
  await copyFile(path.join(source, p.file), path.join(out, `${p.finding_id}.jpg`));
  findings.push({
    id: p.finding_id,
    title: p.title,
    severity: p.severity,
    class: p.class,
    area: p.area,
    description: p.description,
    position: p.location.pos_m,
    height: p.location.height_m,
    bearing: p.location.bearing_deg,
    photo: `${p.finding_id}.jpg`,
    sourceImage: p.photo.source_image,
    sourceFlight: p.photo.flight,
    sourceTime: p.photo.flight_video_t_s,
    camera: p.photo.camera_pos_m,
    cameraDistance: p.photo.distance_m,
    reportPage: p.report_page,
  });
}
await writeFile(path.join(out, 'findings.json'), JSON.stringify(findings));
await require('esbuild').build({
  entryPoints: [path.join(here, 'inspection.js')],
  bundle: true,
  format: 'esm',
  outfile: path.join(out, 'inspection.bundle.js'),
  minify: true,
  target: 'es2022',
});
console.log(
  'Prepared six source findings, the tank model, 280,000 LiDAR points and the interior flight.',
);
