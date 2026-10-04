/**
 * The agent tool catalogue, shared by the main process (which offers tools to the model) and the
 * renderer (which runs them). Each spec pairs `ToolMeta` from @aio/schema with a zod input schema.
 * Executors live in renderer-tools.ts.
 */
import { needsApproval, ToolMeta, Vec3, type ToolRisk, type WindowKind } from '@aio/schema';
import { z } from 'zod';

export interface ToolSpec {
  meta: ToolMeta;
  /** Validates (and fills defaults of) the model's input before anything runs. */
  input: z.ZodType;
  /** The action changes view state that the renderer can put back (time, camera, selection). */
  undoable?: boolean;
}

const SPATIAL: WindowKind[] = ['scene3d', 'map', 'pointcloud'];
const TIMED: WindowKind[] = ['scene3d', 'map', 'video', 'pointcloud'];

/** An asset, an issue or a point in the project local frame (metres, Y up, X east, Z south). */
export const Target = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('asset'),
    id: z.string().min(1).describe('Asset tag, e.g. 20-T-0002'),
  }),
  z.object({ kind: z.literal('issue'), id: z.string().min(1).describe('Issue id or code') }),
  z.object({ kind: z.literal('point'), p: Vec3.describe('[x, y, z] in metres, local frame') }),
]);
export type Target = z.infer<typeof Target>;

const SelectionKind = z.enum(['asset', 'issue', 'clip', 'photo', 'layer', 'pano']);
const Severity = z.union([z.number().int().min(0).max(9), z.literal('uncertain')]);

export const toolInputs = {
  list_layers: z
    .object({
      kind: z
        .enum([
          'mesh',
          'pointcloud',
          'basemap',
          'raster',
          'vector',
          'video',
          'photos',
          'panoramas',
          'legacy',
        ])
        .optional(),
    })
    .strict(),
  list_clips: z.object({}).strict(),
  find_clips_near: z
    .object({
      target: Target,
      radiusM: z.number().positive().max(5000).default(40).describe('Search radius in metres'),
    })
    .strict(),
  set_time: z
    .object({
      iso: z.iso.datetime({ offset: true }).optional().describe('UTC time, ISO 8601'),
      utcMs: z.number().int().optional().describe('Project clock, UTC milliseconds'),
      clipId: z.string().min(1).optional().describe('Video layer id, with clipSeconds'),
      clipSeconds: z.number().nonnegative().optional().describe('Seconds into the clip'),
    })
    .strict()
    .refine(
      (v) =>
        [v.iso !== undefined, v.utcMs !== undefined, v.clipId !== undefined].filter(Boolean)
          .length === 1 && (v.clipId === undefined) === (v.clipSeconds === undefined),
      'Give exactly one of iso, utcMs, or clipId with clipSeconds',
    ),
  play_clip: z
    .object({
      clipId: z.string().min(1),
      fromSeconds: z.number().nonnegative().optional(),
    })
    .strict(),
  fly_to: z
    .object({
      target: Target,
      distanceM: z.number().positive().max(10000).optional(),
    })
    .strict(),
  // Providers need an object at the top of a tool schema, so no top-level union here.
  select: z
    .object({
      kind: SelectionKind.optional(),
      id: z.string().min(1).optional(),
      layer: z.string().min(1).optional(),
      clear: z.boolean().optional().describe('True to clear the selection'),
    })
    .strict()
    .refine(
      (v) => (v.clear === true) !== (v.kind !== undefined && v.id !== undefined),
      'Give kind and id, or clear: true',
    ),
  list_issues: z
    .object({
      status: z.enum(['draft', 'reviewed', 'approved', 'closed']).optional(),
      severityMin: z.number().int().min(0).max(9).optional(),
      severityMax: z.number().int().min(0).max(9).optional(),
      classId: z.string().min(1).optional(),
      source: z.enum(['human', 'agent', 'import']).optional(),
      text: z.string().min(1).optional().describe('Matches code, title or note'),
      limit: z.number().int().positive().max(200).default(50),
    })
    .strict(),
  create_issue_draft: z
    .object({
      title: z.string().min(1).max(200),
      note: z.string().max(4000).default(''),
      severity: Severity,
      classId: z.string().min(1).optional().describe('Issue class from the project catalogue'),
      at: Target.optional().describe('Where the issue is; defaults to the current selection'),
    })
    .strict(),
  set_layer_visible: z.object({ layerId: z.string().min(1), visible: z.boolean() }).strict(),
  capture_frame: z.object({}).strict(),
  summarize_issues: z
    .object({ status: z.enum(['draft', 'reviewed', 'approved', 'closed']).optional() })
    .strict(),
} as const;

export type ToolName = keyof typeof toolInputs;
export type ToolInput<N extends ToolName> = z.output<(typeof toolInputs)[N]>;

function spec(name: ToolName, meta: Omit<ToolMeta, 'name'>, undoable = false): ToolSpec {
  return { meta: { name, ...meta }, input: toolInputs[name], undoable };
}

const BUILT_IN: ToolSpec[] = [
  spec('list_layers', {
    description: 'List the layers of the open project with kind and visibility.',
    scope: 'project',
    risk: 'read',
  }),
  spec('list_clips', {
    description:
      'List the video clips of the project with start time, length and which one is active.',
    scope: 'project',
    risk: 'read',
  }),
  spec('find_clips_near', {
    description:
      'Find video clips whose flight path passes within radiusM metres of an asset, an issue or a point. Returns the closest distance and the time ranges inside the radius.',
    scope: 'project',
    risk: 'read',
    windows: ['scene3d', 'map', 'video', 'pointcloud', 'issues', 'photo'],
  }),
  spec(
    'set_time',
    {
      description:
        'Move the project clock (the playhead) to a UTC time, or to a number of seconds into a clip.',
      scope: 'project',
      risk: 'navigate',
      windows: TIMED,
    },
    true,
  ),
  spec(
    'play_clip',
    {
      description: 'Make a clip the active one and start playback, optionally from a second.',
      scope: 'project',
      risk: 'navigate',
      windows: TIMED,
    },
    true,
  ),
  spec(
    'fly_to',
    {
      description: 'Fly the 3D camera to an asset, an issue or a point.',
      scope: 'project',
      risk: 'navigate',
      windows: [...SPATIAL, 'issues'],
    },
    true,
  ),
  spec(
    'select',
    {
      description:
        'Select an asset, issue, clip, photo, layer or panorama, or clear the selection.',
      scope: 'project',
      risk: 'navigate',
    },
    true,
  ),
  spec('list_issues', {
    description:
      'List issues (findings) with optional filters on status, severity, class, source and text.',
    scope: 'project',
    risk: 'read',
  }),
  spec(
    'create_issue_draft',
    {
      description:
        'Create a draft issue (finding) at an asset, issue or point, or at the current selection. Always a draft for a person to review; the app asks for approval first.',
      scope: 'project',
      risk: 'write',
    },
    true,
  ),
  spec(
    'set_layer_visible',
    {
      description: 'Show or hide a layer.',
      scope: 'window',
      risk: 'navigate',
      windows: SPATIAL,
    },
    true,
  ),
  spec('capture_frame', {
    description:
      'Capture what this window shows now (the current video frame or the 3D view) and send it to you as an image. The app asks for approval because it sends imagery to the AI provider.',
    scope: 'window',
    risk: 'send',
    windows: ['video', 'scene3d', 'pointcloud', 'photo', 'map'],
  }),
  spec('summarize_issues', {
    description:
      'Counts of issues by severity, status and class, plus the most severe ones, for writing a summary.',
    scope: 'project',
    risk: 'read',
  }),
];

const extra = new Map<string, ToolSpec>();

/** Every tool the agent knows, built-in first. */
export const TOOL_SPECS: readonly ToolSpec[] = BUILT_IN;

/**
 * Add a tool from another package. Must run in both processes (main offers it to the model, the
 * renderer runs it via registerRendererTool), so put the call in a module both import.
 */
export function registerToolSpec(s: ToolSpec): void {
  const parsed = ToolMeta.parse(s.meta);
  if (getToolSpec(parsed.name)) throw new Error(`A tool named "${parsed.name}" already exists`);
  extra.set(parsed.name, s);
}

export function allToolSpecs(): ToolSpec[] {
  return [...BUILT_IN, ...extra.values()];
}

export function getToolSpec(name: string): ToolSpec | undefined {
  return BUILT_IN.find((s) => s.meta.name === name) ?? extra.get(name);
}

/** Tools offered to the agent bound to a window. */
export function toolsForWindow(window: WindowKind): ToolSpec[] {
  return allToolSpecs().filter((s) => !s.meta.windows || s.meta.windows.includes(window));
}

export function riskOf(name: string): ToolRisk {
  return getToolSpec(name)?.meta.risk ?? 'write';
}

/** True when the person must approve the call before it runs. Unknown tools always ask. */
export function approvalFor(name: string): boolean {
  return needsApproval(riskOf(name));
}

export function undoable(name: string): boolean {
  return getToolSpec(name)?.undoable === true;
}
