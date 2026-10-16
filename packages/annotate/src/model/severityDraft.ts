import type { SeverityLevel, SeverityModel } from '@aio/schema';
import { classSlug } from './catalogueOps';

/**
 * A severity scale made in the sighting picker. `3` and `5` are the two grades an inspector can
 * start from; names and criteria can be edited before the scale is saved.
 */
export type ScalePreset = '3' | '5';

const UNCERTAIN = { label: 'Uncertain', color: '#878d93' };

const PRESETS: Record<ScalePreset, readonly SeverityLevel[]> = {
  '3': [
    { value: 1, label: 'Minor', color: '#78b3d6', criteria: 'Cosmetic or early stage. Monitor.' },
    {
      value: 2,
      label: 'Moderate',
      color: '#ebc751',
      criteria: 'Visible deterioration. Plan maintenance.',
    },
    {
      value: 3,
      label: 'Severe',
      color: '#f05653',
      criteria: 'Loss of function or safety risk. Act now.',
    },
  ],
  '5': [
    { value: 1, label: 'Trace', color: '#8a94a6', criteria: 'Barely visible. Note it.' },
    { value: 2, label: 'Minor', color: '#5b9bd5', criteria: 'Early stage. Monitor.' },
    { value: 3, label: 'Moderate', color: '#e8c547', criteria: 'Clear deterioration. Plan work.' },
    {
      value: 4,
      label: 'Major',
      color: '#f08a3e',
      criteria: 'Function or safety affected. Repair soon.',
    },
    {
      value: 5,
      label: 'Severe',
      color: '#e5484d',
      criteria: 'Loss of function or immediate risk. Act now.',
    },
  ],
};

/** The name a generated scale starts with when the person has not typed one. */
export function scalePresetName(preset: ScalePreset): string {
  return preset === '3' ? 'Inspection 1 to 3' : 'Inspection 1 to 5';
}

/** A copy of the preset's grades, so a form can edit them without changing the preset. */
export function presetLevels(preset: ScalePreset): SeverityLevel[] {
  return PRESETS[preset].map((l) => ({ ...l }));
}

/**
 * A new severity model from a name and a preset. The id is a slug of the name, with `-2`, `-3`
 * when `takenIds` already has it. An empty name uses the preset's own name.
 */
export function generateSeverityModel(
  name: string,
  preset: ScalePreset,
  takenIds: ReadonlySet<string> = new Set(),
): SeverityModel {
  const clean = name.trim().replace(/\s+/g, ' ') || scalePresetName(preset);
  const base = classSlug(clean);
  let id = base;
  for (let n = 2; takenIds.has(id); n++) id = `${base}-${String(n)}`;
  return {
    id,
    name: clean,
    levels: presetLevels(preset),
    uncertain: { ...UNCERTAIN },
  };
}
