import { join } from 'node:path';
import { importAik } from '../../packages/project/src/import/index.ts';
import { parseArgs } from './args.mjs';

/** Run the Asset Inspection Kit importer for one staged job and print a summary. */
export async function runAik(project, options) {
  const { src, out } = parseArgs(project);
  const t = Date.now();
  const r = await importAik({
    src,
    out,
    id: project,
    ...options,
    log: (m) => process.stdout.write(`  ${m}\n`),
  });
  process.stdout.write(
    `${project}: ${r.layers} layers, ${r.photos} photos, ${r.issues} issues, ${r.written} written, ` +
      `${r.skipped} unchanged in ${((Date.now() - t) / 1000).toFixed(1)} s\n${join(out, 'IMPORT-REPORT.md')}\n`,
  );
  for (const w of r.warnings) process.stdout.write(`  warning: ${w}\n`);
}
