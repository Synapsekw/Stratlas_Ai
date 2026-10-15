import { z } from 'zod';
import { Vec2, Vec3 } from './common';
import { PartOrigin } from './partOrigin';

/**
 * Engineering assemblies of `aio.procmodel/2`: parametric components (shafts, platforms, ladders,
 * lattice sections, antennas) the engineering model run proposes and a person reviews. Lengths are
 * metres in the project local frame (x east, y up, z south). Each kind has its own strict params;
 * the deterministic mesher in `@aio/modelling` turns them into PBR nodes.
 */

const L = z.number().positive().max(1000); // a length in metres
const Y = z.number().min(-500).max(1500);
const Count = (max: number) => z.number().int().min(0).max(max);
const Dir = Vec3.refine((v) => Math.hypot(v[0], v[1], v[2]) > 1e-6, 'A direction cannot be zero.');

export const ModelFamily = z.enum([
  'chimney',
  'flare',
  'telecom-lattice',
  'telecom-monopole',
  'generic',
]);
export const ValueBasis = z.enum(['measured', 'observed', 'inferred', 'user']);
/**
 * How a parameter value is known. A fit residual and its point support describe a measurement, so
 * they are refused on any other basis (an observed or inferred value cannot pose as survey accuracy).
 */
export const ParamQuality = z
  .object({
    basis: ValueBasis,
    residualM: z.number().nonnegative().optional(),
    support: z.number().int().nonnegative().optional(),
    coverage: z.number().min(0).max(1).optional(),
    note: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.basis === 'measured') return;
    for (const key of ['residualM', 'support'] as const)
      if (q[key] !== undefined)
        ctx.addIssue({
          code: 'custom',
          message: `Only a measured value has a ${key === 'residualM' ? 'residual' : 'support'}.`,
          path: [key],
        });
  });
export const EvidenceRef = z
  .object({
    kind: z.enum(['cloud', 'photo', 'mesh', 'user']),
    ref: z.string().min(1).max(200),
    view: z.string().max(120).optional(),
  })
  .strict();
export const Material = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    name: z.string().min(1).max(80),
    baseColor: z.tuple([
      z.number().min(0).max(1),
      z.number().min(0).max(1),
      z.number().min(0).max(1),
      z.number().min(0).max(1),
    ]),
    metallic: z.number().min(0).max(1),
    roughness: z.number().min(0).max(1),
    emissive: z
      .tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])
      .optional(),
    doubleSided: z.boolean().optional(),
  })
  .strict();

const Profile = z
  .array(z.object({ y: Y, r: L }).strict())
  .min(2)
  .max(64)
  .refine(
    (p) => p.every((s, i) => i === 0 || s.y > (p[i - 1]?.y ?? -Infinity)),
    'Profile heights must increase.',
  );
const Section = z.union([
  z.object({ rect: z.tuple([L, L]) }).strict(),
  z.object({ round: L }).strict(),
]);
const Path3 = z.array(Vec3).min(2).max(64);
const Outline = z.union([z.object({ r: L }).strict(), z.array(Vec2).min(3).max(128)]);

export const AssemblyParamsByKind = {
  shaft: z
    .object({
      base: Vec3,
      axis: Dir.optional(),
      profile: Profile,
      wall: L.optional(),
      openTop: z.boolean(),
      joints: z.object({ spacing: L }).strict().optional(),
    })
    .strict(),
  band: z
    .object({ shaft: z.string().min(1).max(80), y0: Y, y1: Y, material: z.string().max(40) })
    .strict()
    .refine((b) => b.y1 > b.y0, 'A band ends above where it starts.'),
  flue: z
    .object({
      centre: Vec3,
      rOuter: L,
      rInner: L,
      height: L,
      rim: z.boolean().optional(),
      flange: z.boolean().optional(),
    })
    .strict()
    .refine((f) => f.rInner < f.rOuter, 'Inner radius must be below outer radius.'),
  flareTip: z
    .object({
      base: Vec3,
      r: L,
      height: L,
      windshield: z.boolean().optional(),
      pilots: Count(8).optional(),
    })
    .strict(),
  deck: z
    .object({
      y: Y,
      outline: Outline,
      thickness: L,
      openings: z.array(z.object({ centre: Vec2, r: L }).strict()).max(16),
    })
    .strict(),
  ringPlatform: z
    .object({
      y: Y,
      rInner: L,
      rOuter: L,
      thickness: L,
      arcDeg: z.number().min(10).max(360).optional(),
    })
    .strict()
    .refine((p) => p.rInner < p.rOuter, 'Inner radius must be below outer radius.'),
  guardrail: z
    .object({
      path: z.union([Path3, z.object({ y: Y, r: L }).strict()]),
      height: L,
      posts: L,
      rails: z.number().int().min(1).max(3),
    })
    .strict(),
  ladder: z
    .object({ bottom: Vec3, top: Vec3, width: L, rungSpacing: L, cage: z.boolean().optional() })
    .strict(),
  hatch: z.object({ centre: Vec3, size: z.tuple([L, L]), open: z.boolean().optional() }).strict(),
  louvre: z
    .object({
      centre: Vec3,
      normal: Dir,
      size: z.tuple([L, L]),
      blades: z.number().int().min(3).max(40),
    })
    .strict(),
  duct: z
    .object({
      path: Path3,
      section: Section,
      transition: z
        .object({ at: z.number().int().min(0), to: Section })
        .strict()
        .optional(),
      flanges: z.boolean().optional(),
    })
    .strict(),
  pipeRun: z
    .object({
      path: Path3,
      diameter: L,
      bendRadius: L.optional(),
      flanges: z.array(z.number().int().min(0)).max(64).optional(),
    })
    .strict(),
  frame: z
    .object({
      kind: z.enum(['portal', 'rack']),
      base: Vec3,
      span: L,
      height: L,
      yawDeg: z.number().min(-360).max(360),
      bays: z.number().int().min(1).max(20),
      braced: z.boolean(),
      member: L,
    })
    .strict(),
  base: z.object({ outline: Outline, y: Y, height: L }).strict(),
  cabinet: z
    .object({ base: Vec3, size: z.tuple([L, L, L]), yawDeg: z.number().min(-360).max(360) })
    .strict(),
  lattice: z
    .object({
      base: Vec3,
      legs: z.union([z.literal(3), z.literal(4)]),
      widthBase: L,
      widthTop: L,
      height: L,
      bays: z
        .array(z.object({ height: L, bracing: z.enum(['X', 'K', 'Z']) }).strict())
        .min(1)
        .max(80),
      legSection: L,
      braceSection: L,
    })
    .strict(),
  monopole: z
    .object({
      base: Vec3,
      profile: Profile,
      sides: z.union([z.literal(0), z.number().int().min(8).max(18)]),
    })
    .strict(),
  antenna: z
    .object({
      kind: z.enum(['panel', 'dish', 'rru', 'omni']),
      centre: Vec3,
      azimuthDeg: z.number().min(0).max(360),
      tiltDeg: z.number().min(-30).max(30),
      size: z.tuple([L, L, L]),
    })
    .strict(),
  antennaMount: z
    .object({
      kind: z.enum(['pipe', 'sector-frame', 'standoff']),
      centre: Vec3,
      azimuthDeg: z.number().min(0).max(360),
      size: z.tuple([L, L, L]),
    })
    .strict(),
  warningLight: z
    .object({
      fixture: z.enum(['single', 'twin', 'canister', 'beacon']),
      centre: Vec3,
      outward: Dir,
      size: L,
    })
    .strict(),
  earthing: z.object({ path: Path3, diameter: L }).strict(),
} as const;

export const AssemblyKind = z.enum(
  Object.keys(AssemblyParamsByKind) as [
    keyof typeof AssemblyParamsByKind,
    ...(keyof typeof AssemblyParamsByKind)[],
  ],
);
export type AssemblyKind = z.infer<typeof AssemblyKind>;
export type AssemblyParams<K extends AssemblyKind> = z.infer<(typeof AssemblyParamsByKind)[K]>;

const assemblyBase = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  parent: z.string().max(80).optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(300),
  category: z.string().min(1).max(60),
  tag: z.string().max(80).optional(),
  type: z.string().max(40).optional(),
  material: z.string().max(40).optional(),
  status: z.enum(['draft', 'accepted', 'rejected']),
  origin: PartOrigin,
  quality: z.record(z.string().max(60), ParamQuality),
  sources: z.array(EvidenceRef).max(64),
  unobserved: z
    .array(z.enum(['back', 'top', 'interior', 'base']))
    .max(4)
    .optional(),
  hidden: z.boolean().optional(),
};

export type Assembly = {
  [K in AssemblyKind]: z.infer<z.ZodObject<typeof assemblyBase>> & {
    kind: K;
    params: AssemblyParams<K>;
  };
}[AssemblyKind];

/**
 * One component, discriminated by `kind`. Built from the per-kind table, so the zod union is cast
 * to the precise `Assembly` type (the generic union would infer a loose record).
 */
export const Assembly = z.discriminatedUnion(
  'kind',
  AssemblyKind.options.map((k) => {
    // quality is keyed by the kind's own parameter names (which also bounds the record)
    const names = new Set(Object.keys(AssemblyParamsByKind[k].shape));
    return z
      .object({ ...assemblyBase, kind: z.literal(k), params: AssemblyParamsByKind[k] })
      .strict()
      .superRefine((a, ctx) => {
        for (const key of Object.keys(a.quality))
          if (!names.has(key))
            ctx.addIssue({
              code: 'custom',
              message: `"${key}" is not a parameter of a ${k}.`,
              path: ['quality', key],
            });
      });
  }) as unknown as [z.ZodObject, ...z.ZodObject[]],
) as unknown as z.ZodType<Assembly>;

export const ScaleRecord = z
  .object({
    status: z.enum(['measured', 'reference', 'provisional']),
    reference: z
      .object({
        what: z.enum(['height', 'diameter', 'other']),
        valueM: L,
        label: z.string().max(80).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((s) => s.status !== 'reference' || s.reference !== undefined, {
    message: 'A scale from a reference names the reference.',
    path: ['reference'],
  });
export const EvidenceInventory = z
  .object({
    supported: z.array(z.string().max(80)).max(400),
    missing: z.array(z.string().max(200)).max(100),
    unresolved: z.array(z.string().max(200)).max(100),
  })
  .strict();

export type Material = z.infer<typeof Material>;
export type ValueBasis = z.infer<typeof ValueBasis>;
export type ParamQuality = z.infer<typeof ParamQuality>;
export type EvidenceRef = z.infer<typeof EvidenceRef>;
export type ScaleRecord = z.infer<typeof ScaleRecord>;
export type EvidenceInventory = z.infer<typeof EvidenceInventory>;
export type ModelFamily = z.infer<typeof ModelFamily>;
