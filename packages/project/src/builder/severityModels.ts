import {
  SeverityModel as SeverityModelSchema,
  type ProjectManifest,
  type SeverityModel,
} from '@aio/schema';
import { updateManifestFile } from './manifestFile';

/*
 * A severity scale added after the project was created (`builder:addSeverityModel`). Only
 * `manifest.severityModels` grows by one entry; saved in turn with a backup like `updateClasses`.
 * Existing scales are left as they are.
 */

/** Why `model` cannot be added to the manifest, or null. */
export function addedModelProblem(m: ProjectManifest, model: SeverityModel): string | null {
  const parsed = SeverityModelSchema.safeParse(model);
  if (!parsed.success) {
    return `The severity scale is invalid: ${parsed.error.issues[0]?.message ?? 'unknown error'}`;
  }
  if (m.severityModels.some((s) => s.id === model.id)) {
    return `A severity scale with the id "${model.id}" already exists.`;
  }
  const name = model.name.trim().toLowerCase();
  if (m.severityModels.some((s) => s.name.trim().toLowerCase() === name)) {
    return `A severity scale named ${model.name} already exists.`;
  }
  return null;
}

/** Append one severity scale (validated against the manifest). */
export async function addSeverityModel(
  root: string,
  model: SeverityModel,
): Promise<{ manifest: ProjectManifest; backup: string }> {
  const r = await updateManifestFile(root, (m) => {
    const problem = addedModelProblem(m, model);
    if (problem) throw new Error(problem);
    return {
      manifest: {
        ...m,
        severityModels: [
          ...m.severityModels,
          {
            ...model,
            levels: model.levels.map((l) => ({ ...l })),
            ...(model.uncertain ? { uncertain: { ...model.uncertain } } : {}),
          },
        ],
      },
    };
  });
  return { manifest: r.manifest, backup: r.backup };
}
