import { z } from 'zod';
import { HexColor, Id } from './common';

export const SeverityLevel = z.object({
  value: z.number().int().min(0).max(9),
  label: z.string().min(1),
  color: HexColor,
  criteria: z.string(),
  action: z.string().optional(),
});

export const SeverityModel = z
  .object({
    id: Id,
    name: z.string().min(1),
    levels: z.array(SeverityLevel).min(1),
    uncertain: z.object({ label: z.string().min(1), color: HexColor }).optional(),
  })
  .superRefine((m, ctx) => {
    for (let i = 1; i < m.levels.length; i++) {
      const prev = m.levels[i - 1];
      const cur = m.levels[i];
      if (prev && cur && cur.value <= prev.value) {
        ctx.addIssue({
          code: 'custom',
          message: `Severity levels in "${m.name}" must have unique values in ascending order`,
          path: ['levels', i, 'value'],
        });
      }
    }
  });

export const IssueClass = z.object({
  id: Id,
  label: z.string().min(1),
  color: HexColor,
  hotkey: z.string().length(1).optional(),
  severityModel: Id,
});

export const ClassCatalogue = z.object({
  id: Id,
  name: z.string().min(1),
  assetType: z.string().min(1),
  classes: z.array(IssueClass),
});

/**
 * A class kept in the class library on this computer (`userData/class-library.json`,
 * `aio.classLibrary/1`). New projects offer these; `severityLevels` are the level names of the
 * model it was saved from, shown for orientation only (a class takes the new project's model).
 */
export const LibraryClass = z.object({
  label: z.string().trim().min(1).max(80),
  color: HexColor,
  hotkey: z.string().length(1).optional(),
  severityLevels: z.array(z.string().min(1)).optional(),
});

export type LibraryClass = z.infer<typeof LibraryClass>;

export type SeverityLevel = z.infer<typeof SeverityLevel>;
export type SeverityModel = z.infer<typeof SeverityModel>;
export type IssueClass = z.infer<typeof IssueClass>;
export type ClassCatalogue = z.infer<typeof ClassCatalogue>;
