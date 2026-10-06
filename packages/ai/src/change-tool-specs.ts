/**
 * Agent tools of change between survey dates (M8 stream C1, FUS-12, AI-5): specs only, shared by
 * the main process (offered to the model) and the renderer. Executors: `change-tools.ts`.
 */
import { z } from 'zod';
import type { ToolSpec } from './tools';

const Capture = z.string().min(1).max(120);
const InAppKind = z.enum(['issue', 'detection', 'vector']);

export const changeToolInputs = {
  list_changes: z
    .object({
      from: Capture.optional().describe('Earlier capture id, label or date; default the first'),
      to: Capture.optional().describe('Later capture id, label or date; default the last'),
      kind: z
        .enum(['issue', 'detection', 'vector', 'region', 'component', 'frame'])
        .optional()
        .describe('Only this kind of change'),
      verdict: z.string().min(1).max(20).optional().describe('Only this verdict, e.g. new'),
      status: z.enum(['open', 'confirmed', 'dismissed']).optional(),
      limit: z.number().int().positive().max(200).default(50),
    })
    .strict(),
  show_change: z
    .object({
      id: z.string().min(1).max(200).describe('Change item id from list_changes, e.g. issue:F03'),
      from: Capture.optional(),
      to: Capture.optional(),
    })
    .strict(),
  run_change_detection: z
    .object({
      from: Capture.optional(),
      to: Capture.optional(),
      kinds: z
        .array(InAppKind)
        .min(1)
        .optional()
        .describe('What to compare in the app; default issues, detections and map layers'),
    })
    .strict(),
} as const;

export type ChangeToolName = keyof typeof changeToolInputs;

export const CHANGE_TOOL_SPECS: readonly ToolSpec[] = [
  {
    meta: {
      name: 'list_changes',
      description:
        'List what changed between two survey dates from the saved change sets: each item with its kind (issue, detection, map feature, region, model part, frame), verdict (new, resolved, grown, moved...), review status and id. Use run_change_detection first when there are none.',
      scope: 'project',
      risk: 'read',
    },
    input: changeToolInputs.list_changes,
  },
  {
    meta: {
      name: 'show_change',
      description:
        'Fly the view to one change item (from list_changes); an issue change also selects the issue of the later date.',
      scope: 'project',
      risk: 'navigate',
    },
    input: changeToolInputs.show_change,
    undoable: true,
  },
  {
    meta: {
      name: 'run_change_detection',
      description:
        'Compare issues, detections and map layers of two survey dates in the app and save the change sets for review. Writes files, so the app asks for approval first. Nothing changes an issue until a person confirms.',
      scope: 'project',
      risk: 'write',
    },
    input: changeToolInputs.run_change_detection,
  },
];
