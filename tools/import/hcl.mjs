// Convert the staged HCl tank offline package into a native Stratlas project.
// Usage (from packages/project): pnpm import:hcl [--src <folder>] [--out <folder>]
import { join } from 'node:path';
import { importHcl } from '../../packages/project/src/import/index.ts';
import { parseArgs } from './args.mjs';

const { src, out } = parseArgs('hcl');
const t = Date.now();
const r = await importHcl({ src, out, log: (m) => process.stdout.write(`  ${m}\n`) });
process.stdout.write(
  `HCl: ${r.layers} layers, ${r.issues} issues, ${r.written} written, ${r.skipped} unchanged ` +
    `in ${((Date.now() - t) / 1000).toFixed(1)} s\n${join(out, 'IMPORT-REPORT.md')}\n`,
);
for (const w of r.warnings) process.stdout.write(`  warning: ${w}\n`);
