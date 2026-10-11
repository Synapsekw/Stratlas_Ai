import type { WindowKind } from '@aio/schema';

/** Three starting prompts per window, shown in the empty panel. */
export const SUGGESTIONS: Record<WindowKind, readonly [string, string, string]> = {
  scene3d: [
    'Which clips fly within 40 m of the selected asset?',
    'Fly to the most severe open issue',
    'Hide the point cloud and play the clip closest to this asset',
  ],
  map: [
    'Which clips pass within 50 m of the selected issue?',
    'List the layers on this map and which are hidden',
    'Summarize open issues by severity',
  ],
  video: [
    'What is visible in this frame?',
    'Jump to the moment this clip is closest to the selected asset',
    'Draft an issue for the defect visible now',
  ],
  photo: [
    'Describe this photo and any visible defects',
    'Which clips pass near the selected issue?',
    'List issues with severity 4 or higher',
  ],
  pointcloud: [
    'Fly to the most severe open issue',
    'Hide the mesh so only the point cloud shows',
    'Which clips cover the selected point?',
  ],
  report: [
    'Summarize the issues for the report',
    'List draft issues that still need review',
    'Which issue classes have the most findings?',
  ],
  issues: [
    'Summarize open issues by severity and class',
    'List the drafts the agent created',
    'Fly to the most severe open issue',
  ],
};

/** What the open project has, so a suggestion never asks for something that is not there. */
export interface SuggestionFacts {
  hasPhotos: boolean;
  hasIssues: boolean;
  hasAssets: boolean;
  hasClips: boolean;
}

const MOST_SEVERE = 'Take me to the most severe finding';
const HIGHEST_PHOTOS = 'Show the photos with the highest severity';
const MOST_FINDINGS = 'Which asset has the most findings?';

/** The requests offered in the empty panel: at most four, the ones the project can answer first. */
export function suggestionsFor(window: WindowKind, facts: SuggestionFacts): string[] {
  const own = SUGGESTIONS[window].filter(
    (s) =>
      (facts.hasClips || !/clip/i.test(s)) &&
      (facts.hasPhotos || !/photo/i.test(s)) &&
      (facts.hasIssues || !/issue|finding/i.test(s)),
  );
  const first = [
    ...(facts.hasIssues ? [MOST_SEVERE] : []),
    ...(facts.hasIssues && facts.hasPhotos ? [HIGHEST_PHOTOS] : []),
    ...(facts.hasIssues && facts.hasAssets ? [MOST_FINDINGS] : []),
  ];
  return [...new Set([...first, ...own])].slice(0, 4);
}
