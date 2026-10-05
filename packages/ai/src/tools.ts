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

/**
 * Where something is: a named place (fuzzy), an asset, an issue, a photo, panorama or clip (its
 * camera), or a coordinate in WGS84, the project CRS or the local frame (metres, Y up, X east,
 * Z south).
 */
export const Target = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('place'),
    name: z
      .string()
      .min(1)
      .describe(
        'A name or id from find_places ("tank 3", "jetty", "asset:20-T-0003", "km 12.4") or a coordinate written as text ("29.07N 48.08E")',
      ),
  }),
  z.object({
    kind: z.literal('asset'),
    id: z.string().min(1).describe('Asset tag or name, e.g. 20-T-0002; matched fuzzily'),
  }),
  z.object({
    kind: z.literal('issue'),
    id: z.string().min(1).describe('Issue code or id, e.g. F05'),
  }),
  z.object({ kind: z.literal('photo'), id: z.string().min(1).describe('Photo id') }),
  z.object({ kind: z.literal('pano'), id: z.string().min(1).describe('Panorama id') }),
  z.object({
    kind: z.literal('clip'),
    id: z.string().min(1).optional().describe('Clip id or name; default the clip flying at `at`'),
    at: z
      .string()
      .min(1)
      .optional()
      .describe('Time: HH:MM or HH:MM:SS site time (as in clip names), or ISO 8601 UTC'),
    atSeconds: z.number().nonnegative().optional().describe('Seconds into the clip'),
  }),
  z.object({
    kind: z.literal('latlon'),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    h: z.number().optional().describe('Height in the project datum; default the ground'),
  }),
  z.object({
    kind: z.literal('en'),
    e: z.number().describe('Easting in the project CRS'),
    n: z.number().describe('Northing in the project CRS'),
    h: z.number().optional().describe('Elevation in the project datum; default the ground'),
  }),
  z.object({
    kind: z.literal('point'),
    p: Vec3.describe('[x, y, z] in metres, local frame; only from a tool result, never guessed'),
  }),
]);
export type Target = z.infer<typeof Target>;

const PlaceKindInput = z.enum([
  'asset',
  'group',
  'layer',
  'issue',
  'photo',
  'pano',
  'clip',
  'pile',
  'chainage',
]);
export const ViewDirection = z.enum(['top', 'north', 'south', 'east', 'west', 'oblique']);
export type ViewDirection = z.infer<typeof ViewDirection>;

const Status = z.enum(['draft', 'reviewed', 'approved', 'closed']);
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
  find_places: z
    .object({
      query: z
        .string()
        .max(200)
        .default('')
        .describe('Words to match: tag, name, area, issue code, photo id, "km 12.4"'),
      kinds: z.array(PlaceKindInput).optional().describe('Only these kinds of place'),
      near: Target.optional().describe('Sort by distance from this place'),
      radiusM: z.number().positive().max(20000).optional().describe('With near: only this close'),
      limit: z.number().int().positive().max(50).default(10),
    })
    .strict(),
  fly_to: z
    .object({
      target: Target,
      view: ViewDirection.optional().describe(
        'Side the camera looks from: top (straight down), north (camera north of the target), south, east, west, oblique (from the current side, 35 degrees down). Default: the current side; eye for photos, panoramas and clips',
      ),
      distanceM: z
        .number()
        .positive()
        .max(20000)
        .optional()
        .describe('Camera distance from the target; default: fit the target'),
      open3d: z
        .boolean()
        .optional()
        .describe('Switch a Map-only stage to the 3D view; default false (the map pans)'),
    })
    .strict(),
  set_view: z
    .object({
      view: z
        .enum(['home', 'top', 'north', 'south', 'east', 'west', 'front', 'side', 'iso'])
        .describe('home: the start view. front is from the south, side from the east'),
      target: Target.optional().describe('Look at this place; default the whole site'),
    })
    .strict(),
  orbit: z
    .object({
      yawDeg: z
        .number()
        .min(-360)
        .max(360)
        .default(0)
        .describe('Turn around the target; positive turns the camera clockwise seen from above'),
      pitchDeg: z
        .number()
        .min(-90)
        .max(90)
        .default(0)
        .describe('Raise (positive) or lower the camera around the target'),
      target: Target.optional().describe('Orbit around this place; default the current target'),
    })
    .strict(),
  zoom: z
    .object({
      factor: z
        .number()
        .positive()
        .max(100)
        .optional()
        .describe('Above 1 zooms in (2 halves the distance), below 1 zooms out'),
      distanceM: z.number().positive().max(20000).optional().describe('Distance to the target'),
    })
    .strict()
    .refine(
      (v) => (v.factor === undefined) !== (v.distanceM === undefined),
      'Give factor or distanceM',
    ),
  look_at: z.object({ target: Target }).strict(),
  frame_all: z.object({}).strict(),
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
  compare_captures: z
    .object({
      from: z.string().min(1).optional().describe('Capture id, label or date; default the first'),
      to: z.string().min(1).optional().describe('Capture id, label or date; default the last'),
      base: z
        .enum(['tin', 'plane', 'avg', 'low'])
        .optional()
        .describe('Stockpile base for volumes; default the survey default'),
    })
    .strict(),
  measure_distance: z.object({ from: Target, to: Target }).strict(),
  export_issues: z
    .object({
      status: Status.optional(),
      classId: z.string().min(1).optional(),
      severityMin: z.number().int().min(0).max(9).optional(),
    })
    .strict(),
  summarize_by_zone: z
    .object({
      status: Status.optional(),
      kmBin: z
        .number()
        .positive()
        .max(100)
        .default(1)
        .describe('Chainage bin in km for road projects'),
    })
    .strict(),
  summarize_by_class: z.object({ status: Status.optional() }).strict(),
  find_issues_near: z
    .object({
      target: Target,
      radiusM: z.number().positive().max(5000).default(25),
      limit: z.number().int().positive().max(200).default(50),
    })
    .strict(),
  open_original_review: z
    .object({
      layerId: z.string().min(1).optional().describe('Legacy layer id; default the first'),
    })
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
  spec('find_places', {
    description:
      'Search what the camera can fly to: tagged assets and component groups (areas), layers, issues, photos, panoramas, clips, stockpiles and road chainage. Fuzzy and case-insensitive. Returns ids, names, kind, position (local, easting and northing, latitude and longitude) and size. Use it before fly_to when you do not have an exact id.',
    scope: 'project',
    risk: 'read',
  }),
  spec(
    'fly_to',
    {
      description:
        'Fly the camera to a place: a name or id from find_places, an asset, an issue, a photo, panorama or clip (to the camera that took it), or a coordinate (latitude and longitude, easting and northing). Frames the place, optionally from a side or at a distance. Works in the 3D view and on the map (the map pans). Returns where the camera is now.',
      scope: 'project',
      risk: 'navigate',
    },
    true,
  ),
  spec(
    'set_view',
    {
      description:
        'Standard views: home, top (plan), north, south, east, west, front, side, iso; of the whole site or of a place.',
      scope: 'project',
      risk: 'navigate',
    },
    true,
  ),
  spec(
    'orbit',
    {
      description:
        'Turn the 3D camera around its target (or a place) by yaw and pitch degrees, keeping the distance.',
      scope: 'project',
      risk: 'navigate',
    },
    true,
  ),
  spec(
    'zoom',
    {
      description:
        'Move the camera closer to or further from its target: by a factor or to a distance in metres.',
      scope: 'project',
      risk: 'navigate',
    },
    true,
  ),
  spec(
    'look_at',
    {
      description: 'Keep the camera where it is and turn it to look at a place.',
      scope: 'project',
      risk: 'navigate',
    },
    true,
  ),
  spec(
    'frame_all',
    {
      description: 'Zoom out to show the whole site (everything visible).',
      scope: 'project',
      risk: 'navigate',
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
  spec('compare_captures', {
    description:
      'Compare two capture dates. For stockpile surveys: volume per pile and in total at each date and the change, from the survey volumes. Otherwise: issue counts at each date and the issues added between them.',
    scope: 'project',
    risk: 'read',
  }),
  spec('measure_distance', {
    description:
      'Distance in metres between two assets, issues or points: straight line, horizontal and height difference.',
    scope: 'project',
    risk: 'read',
  }),
  spec('export_issues', {
    description:
      'Export issues (optionally filtered) to a CSV file the person chooses. Writes a file, so the app asks for approval first.',
    scope: 'project',
    risk: 'write',
  }),
  spec('summarize_by_zone', {
    description:
      'Issue counts per zone (area of the asset, or chainage bin on roads), with severity and the worst issues in each.',
    scope: 'project',
    risk: 'read',
  }),
  spec('summarize_by_class', {
    description:
      'Issue counts per issue class with severity and status breakdown and the worst issues in each class.',
    scope: 'project',
    risk: 'read',
  }),
  spec('find_issues_near', {
    description:
      'Find issues within radiusM metres of an asset, an issue or a point, closest first, with their distance.',
    scope: 'project',
    risk: 'read',
  }),
  spec('open_original_review', {
    description:
      "Open the project's original offline review (the delivered viewer) full screen in the app.",
    scope: 'app',
    risk: 'navigate',
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
