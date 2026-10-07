// Which file of the corpus belongs to which schema family, and how to find that family's schema
// in a schema module of any milestone (current `packages/schema/src` or an extracted `schema-0.x`).
// `null` from `pick` means that build had no such file.
import { z } from 'zod';

const issuesFile = (m) =>
  m.Issue ? z.object({ schema: z.literal('aio.issues/1'), issues: z.array(m.Issue) }) : null;

/**
 * @typedef {{ family: string, match: RegExp, pick: (m: Record<string, any>) => any }} Family
 * `match` is tested against the corpus-relative path (forward slashes) after `<project>/`.
 */

/** @type {readonly Family[]} */
export const FAMILIES = [
  { family: 'aio.project', match: /^manifest\.json$/, pick: (m) => m.ProjectManifest ?? null },
  { family: 'aio.issues', match: /^issues\.json$/, pick: issuesFile },
  { family: 'aio.volumes', match: /^volumes\.json$/, pick: (m) => m.VolumesFile ?? null },
  {
    family: 'aio.boundaries',
    match: /^edits\/boundaries\.json$/,
    pick: (m) => m.BoundaryEditsFile ?? null,
  },
  { family: 'aio.road', match: /^road\.json$/, pick: (m) => m.RoadModel ?? null },
  {
    family: 'aio.detections',
    match: /^detections\/[^/]+\.json$/,
    pick: (m) => m.DetectionsFile ?? null,
  },
  {
    family: 'aio.narrative',
    match: /^report\/narrative\.json$/,
    pick: (m) => m.NarrativeFile ?? null,
  },
  { family: 'aio.origin', match: /^package-origin\.json$/, pick: (m) => m.PackageOrigin ?? null },
  { family: 'aio.change', match: /^change\/[^/]+\.json$/, pick: (m) => m.ChangeSet ?? null },
  {
    family: 'aio.procmodel',
    match: /^models\/[^/]+\.procmodel\.json$/,
    pick: (m) => m.ProcModel ?? null,
  },
  {
    family: 'aio.detector',
    match: /^models\/detect\/[^/]+\/model\.json$/,
    pick: (m) => m.DetectorModelCard ?? null,
  },
  { family: 'aio.package', match: /^aio-package\.json$/, pick: (m) => m.PackageHeader ?? null },
  {
    family: 'aio.conversation',
    match: /^conversations\/[^/]+\.json$/,
    pick: (m) => m.Conversation ?? null,
  },
  // userData settings.json has no schema id; its shape is `Settings` (ipc.ts).
  { family: 'settings', match: /^settings\.json$/, pick: (m) => m.Settings ?? null },
];

/** The family of a corpus file (path inside a project folder), or undefined. */
export function familyOf(rel) {
  return FAMILIES.find((f) => f.match.test(rel));
}
