import {
  Issue,
  parseManifest,
  validateIssueAgainstModel,
  type ProjectManifest,
  type ProjectManifestInput,
} from '@aio/schema';

export const ISSUES_SCHEMA = 'aio.issues/1';

/**
 * Validate a manifest and its issues together: the manifest must parse, every issue must parse,
 * name a severity model of the manifest and use a severity level of that model, and every
 * sighting must point at a layer (and photo) that exists.
 */
export function validatePackage(
  input: ProjectManifestInput,
  issues: readonly unknown[],
): { manifest: ProjectManifest; issues: Issue[] } {
  const m = parseManifest(input);
  if (!m.ok) throw new Error(m.error);
  const manifest = m.value;
  const layers = new Map(manifest.layers.map((l) => [l.id, l]));
  const out: Issue[] = [];
  for (const raw of issues) {
    const parsed = Issue.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid issue: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    }
    const issue = parsed.data;
    const model = manifest.severityModels.find((s) => s.id === issue.severityModelId);
    if (!model)
      throw new Error(`Issue ${issue.code}: unknown severity model ${issue.severityModelId}`);
    const v = validateIssueAgainstModel(issue, model);
    if (!v.ok) throw new Error(v.error);
    for (const s of issue.sightings) {
      const layer = layers.get(s.layer);
      if (!layer) throw new Error(`Issue ${issue.code}: sighting on unknown layer ${s.layer}`);
      if (s.on === 'image') {
        if (layer.kind !== 'photos' || !layer.items.some((p) => p.id === s.photo)) {
          throw new Error(`Issue ${issue.code}: photo ${s.photo} not in layer ${s.layer}`);
        }
      }
    }
    out.push(issue);
  }
  return { manifest, issues: out };
}
