/**
 * The volume bases by their plain names (volumetric parity W3), one module for the base picker,
 * the bulk picker, the volume card and the reports: `baseName` is what a person reads for a side,
 * decided from the side itself (never from a result's stored label). Which base a side is comes
 * from `@aio/project` (`baseIdOf`), where the CSV exports name it with the same words; a test
 * holds the catalogue and those names equal. Pure: no store, so the report page prints the same.
 */
import { baseIdOf, type BaseId } from '@aio/project/export';
import type { SurfaceRef } from '@aio/schema';
import { sideKey, type SideOption } from '@aio/survey';
import type { MessageKey } from '@aio/ui';

// which base a side is: one function, shared with the CSV exports (`@aio/project`)
export { baseIdOf, type BaseId };

/** The seven bases in the picker's order: the default (Toe surface) first. */
export const BASES: readonly { id: BaseId; name: MessageKey; hint: MessageKey }[] = [
  { id: 'smart', name: 'base.smart', hint: 'base.smartHint' },
  { id: 'lowest', name: 'base.lowest', hint: 'base.lowestHint' },
  { id: 'plane', name: 'base.plane', hint: 'base.planeHint' },
  { id: 'level', name: 'base.level', hint: 'base.levelHint' },
  { id: 'mean', name: 'base.mean', hint: 'base.meanHint' },
  { id: 'surface', name: 'base.surface', hint: 'base.surfaceHint' },
  { id: 'custom', name: 'base.custom', hint: 'base.customHint' },
];

/** A surface option as the pickers show it: "Previous survey (01 Sep)". */
export const optionLabel = (o: SideOption): string => (o.note ? `${o.label} (${o.note})` : o.label);

/**
 * Older files' reference modes the picker no longer offers, by their plain names. They stay
 * shown (and ticked) while a comparison uses one.
 */
export const OLDER_MODES: Readonly<Record<string, MessageKey>> = {
  'perimeter-max': 'base.highest',
  'interior-max': 'base.interiorHighest',
  'interior-min': 'base.interiorLowest',
};

/** The old stockpile kit's bases (a carried figure's `carried.base`) by their plain names. */
export const KIT_BASES: Readonly<Record<string, MessageKey>> = {
  tin: 'base.kitTin',
  plane: 'base.plane',
  avg: 'base.mean',
  low: 'base.lowest',
};

/** A kit base's plain name ("Best-fit plane"); an id this build does not know as it is. */
export const kitBaseName = (base: string, t: (k: MessageKey) => string): string => {
  const key = KIT_BASES[base];
  return key ? t(key) : base;
};

/** A survey or design side that is no longer in the project, named by what it was. */
export const missingName = (ref: SurfaceRef, t: (k: MessageKey) => string): string =>
  t(ref.kind === 'design' ? 'vol.card.missingDesign' : 'vol.card.missingSurvey');

/**
 * A side's plain name: the base's, or the survey's or design's from `surfaces` (the pickers'
 * options). `surfaceName` names a survey or design side the options do not hold (the report
 * names it by the side itself); without it that side is "Missing survey" or "Missing design".
 */
export function baseName(
  ref: SurfaceRef,
  surfaces: readonly SideOption[],
  t: (k: MessageKey) => string,
  surfaceName?: (ref: SurfaceRef) => string,
): string {
  const id = baseIdOf(ref);
  if (id === 'surface') {
    const key = sideKey(ref);
    const o = surfaces.find((x) => x.key === key);
    if (o) return optionLabel(o);
    return surfaceName ? surfaceName(ref) : missingName(ref, t);
  }
  const b = BASES.find((x) => x.id === id);
  if (b) return t(b.name);
  const older = ref.kind === 'reference' ? OLDER_MODES[ref.mode] : undefined;
  return t(older ?? 'base.level');
}
