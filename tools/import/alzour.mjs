// Convert the staged Al-Zour plant twin (artifact files + asset store blobs) into a native Quadrion AI project.
// Usage (from packages/project): pnpm import:alzour [--src <folder>] [--out <folder>]
//   [--originals <folder with the original DJI_xxxx.MOV/MP4 recordings>]
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importAlzour } from '../../packages/project/src/import/index.ts';
import { parseArgs } from './args.mjs';

const { src, out, originals } = parseArgs('alzour');
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const design = join(repo, 'docs', 'design', 'assets', 'alzour');
const t = Date.now();
const r = await importAlzour({
  src,
  out,
  ...(originals ? { originals } : {}),
  log: (m) => process.stdout.write(`  ${m}\n`),
  ...(existsSync(design) ? { designAssets: design } : {}),
});
process.stdout.write(
  `Al-Zour: ${r.layers} layers, ${r.issues} issues, ${r.written} written, ${r.skipped} unchanged ` +
    `in ${((Date.now() - t) / 1000).toFixed(1)} s\n${join(out, 'IMPORT-REPORT.md')}\n`,
);
for (const w of r.warnings) process.stdout.write(`  warning: ${w}\n`);
