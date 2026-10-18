import { z } from 'zod';
import { Assembly, EvidenceRef } from './assemblies';
import { IsoTime, Vec3 } from './common';
import { ProcModelId } from './procmodel';

/** Bounded review instructions; comments are user content, never tool instructions. */
const Comment = z.string().trim().min(1).max(4000);
export const CorrectionFingerprint = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const CorrectionTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('part'), partId: z.string().min(1).max(80) }).strict(),
  z
    .object({
      kind: z.literal('pin'),
      /** Assembly/model-local metres, obtained by inverse-transforming the picked scene point. */
      position: Vec3,
      /** Original project-local scene position, for displaying the pin without guessing a frame. */
      projectPosition: Vec3,
      /** All added geometry must fit in this user-reviewed sphere. */
      radiusM: z.number().min(0.1).max(5),
      sourceLayerId: z.string().min(1).max(128),
    })
    .strict(),
]);
export const CorrectionCamera = z
  .object({
    position: Vec3,
    target: Vec3,
    fovDeg: z.number().positive().max(179).optional(),
  })
  .strict();
export const CorrectionPatch = z
  .array(
    z.discriminatedUnion('op', [
      z.object({ op: z.literal('replace'), assembly: Assembly }).strict(),
      z.object({ op: z.literal('add'), assembly: Assembly }).strict(),
      z.object({ op: z.literal('remove'), id: z.string().min(1).max(80) }).strict(),
    ]),
  )
  .min(1)
  .max(32);
export const CorrectionProposalInput = z
  .object({
    explanation: Comment,
    patch: CorrectionPatch,
  })
  .strict();
export const CorrectionProposal = CorrectionProposalInput.extend({
  createdAt: IsoTime,
  /** Only the affected existing components, never a duplicate full model. */
  before: z.array(Assembly).max(32),
  candidateFingerprint: CorrectionFingerprint,
}).strict();
export const ModelCorrectionInput = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    target: CorrectionTarget,
    comment: Comment,
    camera: CorrectionCamera.optional(),
    evidence: z.array(EvidenceRef).max(24).optional(),
  })
  .strict();
export const ModelCorrection = ModelCorrectionInput.extend({
  modelId: ProcModelId,
  baseFingerprint: CorrectionFingerprint,
  createdAt: IsoTime,
  updatedAt: IsoTime,
  status: z.enum(['open', 'proposed', 'accepted', 'rejected']),
  proposal: CorrectionProposal.optional(),
  replies: z.array(z.object({ comment: Comment, createdAt: IsoTime }).strict()).max(32),
  history: z
    .array(
      z
        .object({
          proposal: CorrectionProposal,
          disposition: z.enum(['rejected', 'superseded']),
          at: IsoTime,
        })
        .strict(),
    )
    .max(8),
})
  .strict()
  .superRefine((request, ctx) => {
    if ((request.status === 'proposed' || request.status === 'accepted') && !request.proposal)
      ctx.addIssue({
        code: 'custom',
        message: 'A proposed or accepted correction needs its proposal.',
        path: ['proposal'],
      });
    if (JSON.stringify(request).length > 256_000)
      ctx.addIssue({
        code: 'custom',
        message: 'A correction record must be at most 256,000 characters, including history.',
      });
  });

export type CorrectionTarget = z.infer<typeof CorrectionTarget>;
export type CorrectionCamera = z.infer<typeof CorrectionCamera>;
export type CorrectionPatch = z.infer<typeof CorrectionPatch>;
export type CorrectionProposalInput = z.infer<typeof CorrectionProposalInput>;
export type CorrectionProposal = z.infer<typeof CorrectionProposal>;
export type ModelCorrectionInput = z.infer<typeof ModelCorrectionInput>;
export type ModelCorrection = z.infer<typeof ModelCorrection>;
