/**
 * Agent tools that show things in the app: one finding, Media and Issues with a filter set, a
 * screen, and the findings per asset. Specs only, shared by main (offered to the model) and the
 * renderer. Executors: `show-tools.ts`.
 *
 * All of them are view changes or reads: nothing here writes project data, so none asks for
 * approval, and each view change can be undone.
 */
import { z } from 'zod';
import type { ToolSpec } from './tools';

// What a field takes, as text: a description on an optional field replaces the one inside it in
// the schema the provider gets, so a field with a text of its own has to repeat this.
const ISSUE_REF = 'Issue code or id, e.g. F03';
const WHERE =
  'A tagged asset or an area (component group) by name, or "selection" for the selected asset (with nothing selected: the whole project)';

const IssueRef = z.string().min(1).max(60).describe(ISSUE_REF);
const Where = z.string().min(1).max(120).describe(WHERE);
// A level value only: a word like "critical" is an input error the model reads and corrects, so
// the error says what is allowed.
const Level = z
  .union([z.number().int().min(0).max(9), z.enum(['uncertain', 'highest'])], {
    error: 'Give a level value from severityLevels (a number), "uncertain" or "highest"',
  })
  .describe(
    'A severity level value from severityLevels in the window context, or "highest" for the highest level present',
  );
const Status = z.enum(['draft', 'reviewed', 'approved', 'closed']);

export const showToolInputs = {
  show_issue: z
    .object({
      issue: IssueRef.optional().describe(
        `${ISSUE_REF}. Leave out to show the most severe open finding`,
      ),
      where: Where.optional().describe(
        `With no issue: the most severe open finding on this asset or in this area. ${WHERE}`,
      ),
      evidence: z.boolean().default(true).describe('Open its photo beside the 3D view'),
    })
    .strict(),
  show_photos: z
    .object({
      severity: Level.optional(),
      where: Where.optional(),
      issue: IssueRef.optional(),
      classId: z.string().min(1).optional(),
      onlyFindings: z.boolean().optional(),
      order: z.enum(['file', 'severity', 'count']).default('severity'),
    })
    .strict(),
  show_issues: z
    .object({
      severity: Level.optional(),
      where: Where.optional(),
      classId: z.string().min(1).optional(),
      status: Status.optional(),
      text: z.string().min(1).max(120).optional(),
      sort: z.enum(['severity', 'code', 'status', 'updated', 'class']).default('severity'),
    })
    .strict(),
  open_screen: z
    .object({ screen: z.enum(['scene', 'issues', 'inspect', 'media', 'detections', 'reports']) })
    .strict(),
  list_assets: z
    .object({
      by: z.enum(['asset', 'area']).default('asset'),
      sort: z
        .enum(['worst', 'findings'])
        .default('worst')
        .describe(
          '"worst": the worst open level first. "findings": the most findings first, then the most open ones',
        ),
      limit: z.number().int().positive().max(100).default(20),
    })
    .strict(),
} as const;

export type ShowToolName = keyof typeof showToolInputs;

export const SHOW_TOOL_SPECS: ToolSpec[] = [
  {
    meta: {
      name: 'show_issue',
      description:
        "Show one finding: select it, open Scene, fly to it and open its photo beside the 3D view. With no issue given it shows the most severe open finding, of the whole project or of an asset or area. Use this for 'take me to' and 'show me' a finding. Returns the finding with its severity name and asset, and the other findings at the same level.",
      scope: 'app',
      risk: 'navigate',
    },
    input: showToolInputs.show_issue,
    undoable: true,
  },
  {
    meta: {
      name: 'show_photos',
      description:
        'Open Inspect filtered: photos with findings of one severity level (or the highest present), on an asset or in an area, of one finding or of one class, worst first. Returns how many photos it shows.',
      scope: 'app',
      risk: 'navigate',
    },
    input: showToolInputs.show_photos,
    undoable: true,
  },
  {
    meta: {
      name: 'show_issues',
      description:
        'Open Issues filtered and sorted: by severity level, class, status, text, or the findings on an asset or in an area. Returns how many it shows.',
      scope: 'app',
      risk: 'navigate',
    },
    input: showToolInputs.show_issues,
    undoable: true,
  },
  {
    meta: {
      name: 'open_screen',
      description:
        'Open a screen of the project: scene, issues, inspect (photos, drawing and AI review) or reports. The old names media and detections open Inspect.',
      scope: 'app',
      risk: 'navigate',
    },
    input: showToolInputs.open_screen,
    undoable: true,
  },
  {
    meta: {
      name: 'list_assets',
      description:
        "Per tagged asset or per area: how many findings, how many open, and the worst open severity. Use it for 'which asset is in the worst shape'. Use sort findings for 'which asset has the most findings'.",
      scope: 'project',
      risk: 'read',
    },
    input: showToolInputs.list_assets,
  },
];
