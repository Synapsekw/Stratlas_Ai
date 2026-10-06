/**
 * Agent tools for the model builder (M8 stream C5, BLD-11): list, propose, fit, edit and build
 * procedural model parts, and look at an imported plan. Every result is a draft part a person
 * accepts in the Model builder; every change asks for approval (risk `write`). Plan images and
 * drawing content reach a cloud model only when the project allows it (`aiCloudDrawings`,
 * founder decision 5): `view_plan` is a `send` tool, so the send preview applies as well.
 * Executors run in the desktop renderer (`apps/desktop/src/renderer/modeller/agentTools.ts`).
 */
import {
  PartStatus,
  ProcModelId,
  ProcPart,
  ProcPartKind,
  Vec3,
  type WindowKind,
} from '@aio/schema';
import { z } from 'zod';
import type { ToolSpec } from './tools';

const WINDOWS: WindowKind[] = ['scene3d', 'map', 'pointcloud'];

const OMIT = { id: true, status: true, origin: true } as const;

/** A part the agent works out itself: a procedural part without id, status or origin. */
const [extrusion, cylinder, box, pipe, sphere] = ProcPart.options;
export const AgentPart = z.discriminatedUnion('kind', [
  extrusion.omit(OMIT),
  cylinder.omit(OMIT),
  box.omit(OMIT),
  pipe.omit(OMIT),
  sphere.omit(OMIT),
]);

const ModelRef = ProcModelId.optional().describe(
  'Procedural model id; default the model open in the Model builder',
);

const LocalBox = z.object({ min: Vec3, max: Vec3 }).strict();

export const modellingToolInputs = {
  list_model_parts: z
    .object({
      model: ModelRef,
      status: PartStatus.optional().describe('Only parts with this status'),
    })
    .strict(),
  propose_model_parts: z
    .object({
      model: ModelRef,
      from: z
        .enum(['drawing', 'agent'])
        .describe(
          'drawing: copy the parts read from an imported DXF (tanks, buildings, skids, pipes) as drafts, on this computer; agent: the parts you give in `parts`',
        ),
      drawing: z
        .string()
        .min(1)
        .optional()
        .describe('Imported drawing name; default the newest one'),
      tags: z
        .array(z.string().min(1).max(80))
        .max(200)
        .optional()
        .describe('From a drawing: only parts with these plant tags, e.g. ["T-102"]'),
      classes: z
        .array(z.string().min(1).max(40))
        .max(20)
        .optional()
        .describe('From a drawing: only these classes, e.g. ["tank", "building"]'),
      parts: z
        .array(AgentPart)
        .min(1)
        .max(50)
        .optional()
        .describe('From agent: parts in the local frame, metres (x east, y up, z south)'),
    })
    .strict()
    .refine((v) => v.from === 'drawing' || (v.parts?.length ?? 0) > 0, {
      message: 'Give `parts` when `from` is agent.',
    }),
  fit_primitives: z
    .object({
      layer: z.string().min(1).describe('Point cloud layer id or name'),
      kinds: z.array(ProcPartKind).min(1).optional().describe('Only fit these kinds'),
      region: LocalBox.optional().describe('Only inside this box, local frame metres'),
      model: ModelRef,
    })
    .strict(),
  edit_model_part: z
    .object({
      model: ModelRef,
      part: z.string().min(1).describe('Part id, tag or name'),
      status: PartStatus.optional().describe('accepted, rejected or draft'),
      set: z
        .object({
          tag: z.string().min(1).max(80).optional(),
          name: z.string().min(1).max(200).optional(),
          class: z.string().min(1).max(40).optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          z: z.number().optional(),
          radius: z.number().positive().optional(),
          height: z.number().positive().optional(),
          roofHeight: z.number().nonnegative().optional(),
          length: z.number().positive().optional(),
          width: z.number().positive().optional(),
          yawDeg: z.number().min(-180).max(180).optional(),
          diameter: z.number().positive().optional(),
        })
        .strict()
        .optional()
        .describe('New values; positions and sizes in metres'),
    })
    .strict()
    .refine((v) => v.status !== undefined || (v.set && Object.keys(v.set).length > 0), {
      message: 'Give a status or something to set.',
    }),
  build_model: z
    .object({
      model: ModelRef,
      draft: z
        .boolean()
        .optional()
        .describe('true: a preview of every part not rejected; default: the accepted parts'),
    })
    .strict(),
  view_plan: z
    .object({
      drawing: z.string().min(1).optional().describe('Imported drawing name; default the newest'),
    })
    .strict(),
};

export type ModellingToolName = keyof typeof modellingToolInputs;
export type ModellingToolInput<N extends ModellingToolName> = z.infer<
  (typeof modellingToolInputs)[N]
>;

const spec = (
  name: ModellingToolName,
  description: string,
  risk: ToolSpec['meta']['risk'],
): ToolSpec => ({
  meta: { name, description, scope: 'project', risk, windows: WINDOWS },
  input: modellingToolInputs[name],
});

/** The model builder's tools, in the order the agent sees them. */
export const MODELLING_TOOL_SPECS: readonly ToolSpec[] = [
  spec(
    'list_model_parts',
    'List the parts of a procedural model (the Model builder): id, tag, kind, class, status, fit quality and size.',
    'read',
  ),
  spec(
    'propose_model_parts',
    'Add draft parts to a procedural model: copy the tanks, buildings, skids and pipes read from an imported DXF drawing (optionally only some tags or classes), or parts you work out yourself. Drafts wait for a person to accept them; the app asks for approval first.',
    'write',
  ),
  spec(
    'fit_primitives',
    'Fit tanks, boxes, buildings and pipes to a point cloud layer (optionally inside a box) as draft parts. Starts a pipeline job; the app asks for approval first.',
    'write',
  ),
  spec(
    'edit_model_part',
    'Change one part of a procedural model: accept or reject it, or set its tag, name, class, position or size. The app asks for approval first.',
    'write',
  ),
  spec(
    'build_model',
    'Build the accepted parts of a procedural model into a 3D model layer with tagged parts (or a draft preview of every part). The app asks for approval first.',
    'write',
  ),
  spec(
    'view_plan',
    'Send the picture of an imported plan to you, to read it. Only when the project allows drawings to go to a cloud model, or the model runs on this computer; the app asks first.',
    'send',
  ),
];
