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
