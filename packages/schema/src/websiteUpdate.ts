import { z } from 'zod';

export const WebsiteVersion = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  .max(48);
export const WebsiteAppRange = z
  .string()
  .regex(/^>=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*) <(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  .max(100);
export const WebsiteArtifact = z
  .object({
    releaseId: z.uuid(),
    artifactId: z.uuid(),
    version: WebsiteVersion,
    platform: z.literal('win-x64'),
    filename: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    notes: z.string().max(200_000),
  })
  .strict();
export type WebsiteArtifact = z.infer<typeof WebsiteArtifact>;
export const WebsitePipelineArtifact = WebsiteArtifact.extend({ appRange: WebsiteAppRange });
export type WebsitePipelineArtifact = z.infer<typeof WebsitePipelineArtifact>;
export const WebsiteUpdateCheck = z
  .object({
    schema: z.literal('quadrion.updates/1'),
    targetAppVersion: WebsiteVersion,
    app: WebsiteArtifact.nullable(),
    pipeline: WebsitePipelineArtifact.nullable(),
  })
  .strict();
export type WebsiteUpdateCheck = z.infer<typeof WebsiteUpdateCheck>;
export const WebsiteUpdateComponent = z
  .object({
    version: WebsiteVersion,
    notes: z.string().max(200_000),
    received: z.number().nonnegative(),
    total: z.number().positive(),
    verified: z.boolean(),
  })
  .strict();
export const WebsiteUpdateStatus = z
  .object({
    accountEmail: z.email().nullable(),
    phase: z.enum([
      'signed-out',
      'idle',
      'checking',
      'downloading',
      'verifying',
      'ready',
      'applying',
      'error',
      'paused',
      'unsupported',
    ]),
    currentAppVersion: z.string(),
    currentPipelineVersion: z.string().nullable(),
    app: WebsiteUpdateComponent.nullable(),
    pipeline: WebsiteUpdateComponent.nullable(),
    error: z.string().nullable(),
    restartAvailable: z.boolean(),
    restartReason: z.string().nullable(),
    recoveryAvailable: z.boolean(),
    unsupportedReason: z.string().nullable(),
  })
  .strict();
export type WebsiteUpdateStatus = z.infer<typeof WebsiteUpdateStatus>;
export const WebsiteUpdateResult = z
  .object({ ok: z.boolean(), error: z.string().optional() })
  .strict();
