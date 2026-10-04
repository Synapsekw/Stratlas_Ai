// Convert the staged Masafi stockpile review (Volumetric Survey Kit offline build) into a native
// Stratlas project. Usage (from packages/project): pnpm import:masafi [--src <folder>] [--out <folder>]
import { join } from 'node:path';
import { importMasafi } from '../../packages/project/src/import/index.ts';
import { parseArgs } from './args.mjs';

const { src, out } = parseArgs('masafi');
const t = Date.now();
const r = await importMasafi({ src, out, log: (m) => process.stdout.write(`  ${m}\n`) });
process.stdout.write(
  `Masafi: ${r.layers} layers, ${r.issues} issues, ${r.written} written, ${r.skipped} unchanged ` +
    `in ${((Date.now() - t) / 1000).toFixed(1)} s\n${join(out, 'IMPORT-REPORT.md')}\n`,
);
for (const w of r.warnings) process.stdout.write(`  warning: ${w}\n`);
