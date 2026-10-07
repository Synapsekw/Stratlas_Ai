// The milestone builds whose file formats Stratlas 1.x must keep reading, by the commit that
// was handed to the founder for testing (docs/plans/ROADMAP.md, docs/TESTING.md). The app version
// stayed 0.1.0 until M7, so 0.4 to 0.6 are named by milestone, not by package.json.

/** @typedef {{ version: string, commit: string, date: string, note: string }} Milestone */

/** @type {readonly Milestone[]} */
export const MILESTONES = [
  { version: '0.4', commit: 'a8bf0c5', date: '2026-10-04', note: 'M4 testing guide' },
  { version: '0.5', commit: '8847687', date: '2026-10-04', note: 'M5 done, M6 plan drafted' },
  { version: '0.6', commit: 'eafae4a', date: '2026-10-04', note: 'M6 merged, pack 0.2.0' },
  { version: '0.7', commit: 'af820d6', date: '2026-10-06', note: '0.7.0 merged (M7)' },
  { version: '0.8', commit: '7faf945', date: '2026-10-07', note: '0.8.0 merged (M8)' },
];

/** The build whose schema the "0.9 writes stay readable" test runs against. */
export const OLDEST_SUPPORTED_DOWNGRADE = '0.8';

export function milestone(version) {
  const m = MILESTONES.find((x) => x.version === version);
  if (!m)
    throw new Error(
      `No milestone ${version}. Known: ${MILESTONES.map((x) => x.version).join(', ')}`,
    );
  return m;
}
