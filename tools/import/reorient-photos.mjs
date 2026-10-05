// One-off repair: turn project photos (and their grid thumbnails and the issue shapes drawn on
// them) that are stored another way up than their camera originals. Written for the HCl tank,
// whose kit thumbnails dropped the Elios 3 EXIF Orientation (3, turn 180 deg).
//
// Usage (from packages/project):
//   pnpm reorient:photos --project <project dir> --originals <folder> [--originals <folder> ...]
//        [--layer photos] [--apply]
//
// Without --apply it only prints the plan. With --apply every file it changes is first copied to
// <project>/photos.before-orientation-<stamp>/ (with issues.json and report.json), then replaced
// atomically. Originals are only read. Close the project in the app first: the app keeps its
// issues in memory and would save the old shapes back.
import { reorientPhotos } from '../../packages/project/src/import/reorient.ts';

const argv = process.argv.slice(2);
const all = (name) =>
  argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []));
const project = all('project')[0];
const references = all('originals');
if (!project || !references.length) {
  process.stderr.write('Give --project <dir> and at least one --originals <folder>.\n');
  process.exit(2);
}
const layers = all('layer');
const apply = argv.includes('--apply');
const plan = await reorientPhotos({
  project,
  references,
  ...(layers.length ? { layers } : {}),
  apply,
  log: (m) => process.stdout.write(`  ${m}\n`),
});
const byTurn = {};
for (const p of plan.photos) (byTurn[90 * p.turn] ??= []).push(p.id);
process.stdout.write(`${plan.photosChecked} photos checked against their originals\n`);
for (const [deg, ids] of Object.entries(byTurn))
  process.stdout.write(`  turn ${deg} deg: ${ids.length} photos (${ids.join(' ')})\n`);
process.stdout.write(`  grid thumbnails to turn: ${plan.thumbs.length}\n`);
process.stdout.write(`  left alone: ${plan.unmatched.length}\n`);
for (const u of plan.unmatched) process.stdout.write(`    ${u.id}: ${u.reason}\n`);
process.stdout.write(`  issue sightings turned: ${plan.sightings.length}\n`);
for (const c of plan.sightings)
  process.stdout.write(
    `    ${c.code} on ${c.photo}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}\n`,
  );
if (plan.masks.length) process.stdout.write(`  masks turned: ${plan.masks.join(', ')}\n`);
process.stdout.write(
  apply
    ? plan.backupDir
      ? `Applied. Backup: ${plan.backupDir}\n`
      : 'Nothing to change.\n'
    : 'Plan only; run again with --apply to change the files.\n',
);
