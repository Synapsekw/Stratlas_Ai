/**
 * Agent tools of maps from photos (M10 integration follow-up): specs only, shared by the main
 * process (offered to the model) and the renderer. Executors: `photo-tools.ts`; the host work
 * goes through `AppHooks.processPhotos` and `AppHooks.photoRuns`.
 */
import { PhotoPreset, PhotoProduct } from '@aio/schema';
import { z } from 'zod';
import type { ToolSpec } from './tools';

export const photoToolInputs = {
  process_photos: z
    .object({
      layer: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Photos layer id or name from list_layers; default the project's only photos layer",
        ),
      preset: PhotoPreset.default('standard').describe(
        'Quality: fast (quick look), standard, high (slowest, most detail)',
      ),
      gnss: z
        .enum(['auto', 'rtk', 'standard', 'ignore'])
        .default('auto')
        .describe('How far to trust the camera positions: auto reads the photos'),
      products: z
        .array(PhotoProduct)
        .min(1)
        .optional()
        .describe(
          'What to make: ortho, dsm, dtm, cloud, mesh, tiles; default the usual set for the quality',
        ),
      groundControlFirst: z
        .boolean()
        .default(false)
        .describe('True: stop after alignment so a person marks ground control points first'),
    })
    .strict(),
  accuracy_summary: z
    .object({
      run: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe('Run id; default the newest run that has an accuracy report'),
    })
    .strict(),
} as const;

export type PhotoToolName = keyof typeof photoToolInputs;

export const PHOTO_TOOL_SPECS: readonly ToolSpec[] = [
  {
    meta: {
      name: 'process_photos',
      description:
        'Create maps from a photos layer of the open project, as Create maps from photos does: align the photos with a quality preset, then build the maps (orthophoto, surface models, point cloud, 3D model) as layers when the alignment finishes. Runs for minutes to hours as a job; the app asks for approval first. Answers the run id and the time estimate.',
      scope: 'project',
      risk: 'write',
    },
    input: photoToolInputs.process_photos,
  },
  {
    meta: {
      name: 'accuracy_summary',
      description:
        'How accurate a photo run is: checkpoint and control point RMSE (horizontal and vertical, metres), reprojection error, ground sample distance, the ground control table (points, roles, residuals, marks) and the warnings of its accuracy report.',
      scope: 'project',
      risk: 'read',
    },
    input: photoToolInputs.accuracy_summary,
  },
];
