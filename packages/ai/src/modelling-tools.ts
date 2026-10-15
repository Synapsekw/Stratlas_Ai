/**
 * Agent tools for the model builder (M8 stream C5, BLD-11): list, propose, fit, edit and build
 * procedural model parts, and look at an imported plan. Every result is a draft part a person
 * accepts in the Model builder; every change asks for approval (risk `write`). Plan images and
 * drawing content reach a cloud model only when the project allows it (`aiCloudDrawings`,
 * founder decision 5): `view_plan` is a `send` tool, so the send preview applies as well.
 * Executors run in the desktop renderer (`apps/desktop/src/renderer/modeller/agentTools.ts`).
 */
import {
  AssemblyKind,
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

/** A component of the engineering model: its id (`flue-2`) or its role (`flue`, `light-l1`). */
const Component = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,79}$/)
  .describe('Component id such as flue-2, or a role such as flue or light-l1 (all of them)');
const Role = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/)
  .describe('Component role, such as flue, ladder, light-l1');
const ParamName = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/);
/** A correction is a scalar: geometry comes from the assembler, never from the agent. */
const ParamValue = z.union([
  z.number().min(-100_000).max(100_000),
  z.string().max(80),
  z.boolean(),
]);
/** A new component's parameters: scalars, points and short lists, all bounded. */
const AddValue = z.union([
  ParamValue,
  z.array(z.number().min(-100_000).max(100_000)).max(64),
  z.array(z.array(z.number().min(-100_000).max(100_000)).max(4)).max(64),
  z.array(z.record(z.string().max(20), z.number().min(-100_000).max(100_000))).max(64),
]);

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

  // ---------------------------------------------------------------- engineering model corrections
  list_components: z
    .object({
      kind: AssemblyKind.optional().describe('Only components of this kind'),
      status: PartStatus.optional().describe('Only components with this status'),
    })
    .strict(),
  edit_component: z
    .object({
      component: Component,
      set: z
        .record(ParamName, ParamValue)
        .refine((s) => Object.keys(s).length >= 1 && Object.keys(s).length <= 12, {
          message: 'Set 1 to 12 parameters.',
        })
        .optional()
        .describe(
          'Parameter values by name (numbers in metres or degrees, words, true or false), e.g. {"rOuter": 0.6}',
        ),
      status: PartStatus.optional().describe('accepted, rejected or draft'),
    })
    .strict()
    .refine((v) => v.status !== undefined || v.set !== undefined, {
      message: 'Give a status or parameters to set.',
    }),
  set_count: z
    .object({
      role: Role,
      count: z.number().int().min(0).max(64).describe('How many there are'),
    })
    .strict(),
  set_levels: z
    .object({
      role: Role.describe(
        'light: every intermediate warning light level; light-l1: one level; platform, band, antenna',
      ),
      levels: z
        .array(z.number().min(0).max(2000))
        .max(16)
        .describe('Heights in metres above the asset base'),
    })
    .strict(),
  add_component: z
    .object({
      kind: AssemblyKind,
      role: Role,
      name: z.string().min(1).max(200).optional(),
      params: z
        .record(ParamName, AddValue)
        .refine((p) => Object.keys(p).length <= 24, 'At most 24 parameters.')
        .describe('The parameters of that kind, in the local frame, metres'),
    })
    .strict(),
  remove_component: z
    .object({
      component: Component,
      confirm: z
        .boolean()
        .optional()
        .describe('true to remove a component a person accepted (ask them first)'),
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
  spec(
    'list_components',
    'List the components of the engineering model open in the Model builder (chimney, flare or telecom tower): id, role, kind, status, parameters and how each value is known (measured, observed, inferred or the person).',
    'read',
  ),
  spec(
    'edit_component',
    'Correct an engineering model component (by id) or every component of a role: set parameter values or accept, reject or reopen it. The model is assembled again; ids stay, accepted components are kept. The app asks for approval first.',
    'write',
  ),
  spec(
    'set_count',
    'Correct how many components of a role there are ("there are four flues, not three"). Only that role is assembled again; the others and every accepted component stay. The app asks for approval first.',
    'write',
  ),
  spec(
    'set_levels',
    'Set the heights of a role in metres above the asset base: `light` for every intermediate warning light level, `light-l1` to move one level, or platform, band, antenna. The app asks for approval first.',
    'write',
  ),
  spec(
    'add_component',
    'Add a component the evidence missed, with its kind, role and parameters. It is kept as given (a draft for a person to accept). The app asks for approval first.',
    'write',
  ),
  spec(
    'remove_component',
    'Leave a component (by id) or a role out of the engineering model. A component a person accepted needs confirm: true, after you asked them. The app asks for approval first.',
    'write',
  ),
];
