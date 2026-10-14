import { z } from 'zod';
import { IsoTime } from './common';

/** `processing.odm.gpu`: `auto` uses an NVIDIA card when ODM can, `off` keeps ODM on the CPU. */
export const OdmGpuSetting = z.enum(['auto', 'off']);
export type OdmGpuSetting = z.infer<typeof OdmGpuSetting>;

/** Settings, Processing: the photogrammetry engine's options. Absent: `auto`. */
export const ProcessingSettings = z
  .object({ odm: z.object({ gpu: OdmGpuSetting.optional() }).strict().optional() })
  .strict();
export type ProcessingSettings = z.infer<typeof ProcessingSettings>;

export const OdmState = z.enum([
  'unsupported',
  'not-installed',
  'installing',
  'installed',
  'update-available',
  'broken',
]);
export type OdmState = z.infer<typeof OdmState>;

/** `<dataRoot>/runtime/odm.json` (`aio.odm-install/1`): the ODM this app installed. */
export const OdmInstallRecord = z.looseObject({
  schema: z.literal('aio.odm-install/1'),
  version: z.string().min(1).max(40),
  dir: z.string().min(1).max(2048),
  installedAt: IsoTime,
});
export type OdmInstallRecord = z.infer<typeof OdmInstallRecord>;

/** What Settings, Processing tools shows about ODM (`odm:status`). */
export const OdmStatus = z.object({
  state: OdmState,
  /** The version this build installs, and its sizes (download and on disk). */
  pinned: z.object({
    version: z.string(),
    downloadBytes: z.number().int().nonnegative(),
    installedBytes: z.number().int().nonnegative(),
  }),
  version: z.string().max(40).optional(),
  dir: z.string().max(2048).optional(),
  installedAt: IsoTime.optional(),
  /** Why ODM is broken or unsupported, in words for the person. */
  problem: z.string().max(500).optional(),
  /** Another ODM on this computer that ODM's setup would replace (an uninstall entry or C:\ODM). */
  other: z.object({ dir: z.string().max(2048), version: z.string().max(40).optional() }).nullable(),
  gpu: z.object({
    setting: OdmGpuSetting,
    /** The NVIDIA card's name when one is found, else null. */
    nvidia: z.string().max(200).nullable(),
    /** NVIDIA's CUDA driver (nvcuda.dll) is present: ODM can use the card. */
    cuda: z.boolean(),
  }),
  /** ODM comes from QUADRION_ODM_DIR (development and tests): install and remove are off. */
  dev: z.boolean(),
  /** The setup may ask once for Windows administrator rights (Microsoft's C++ runtime). */
  mayAskAdmin: z.boolean(),
  installing: z.boolean(),
});
export type OdmStatus = z.infer<typeof OdmStatus>;

export const OdmInstallProgress = z.object({
  phase: z.enum(['download', 'verify', 'install', 'check', 'done', 'failed', 'cancelled']),
  bytesDone: z.number().nonnegative(),
  bytesTotal: z.number().nonnegative(),
  error: z.string().max(1000).optional(),
});
export type OdmInstallProgress = z.infer<typeof OdmInstallProgress>;

export const OdmInstallResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), status: OdmStatus }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    code: z
      .enum([
        'other-install',
        'busy',
        'cancelled',
        'unsupported',
        'offline-only',
        'disk',
        'dev',
        'failed',
      ])
      .optional(),
  }),
]);
export type OdmInstallResult = z.infer<typeof OdmInstallResult>;
