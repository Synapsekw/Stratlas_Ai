/**
 * The volume bases by their plain names (volumetric parity W3), one module for the base picker,
 * the volume card and the report: which of the seven bases a side is and what it is called. Pure:
 * no store, so the report page prints the same names.
 */
import type { SurfaceRef } from '@aio/schema';
import { sideKey, type SideOption } from '@aio/survey';
import type { MessageKey } from '@aio/ui';

export type BaseId = 'smart' | 'lowest' | 'plane' | 'level' | 'mean' | 'surface' | 'custom';

/** The seven bases in the picker's order: the default (Triangulated toe) first. */
export const BASES: readonly { id: BaseId; name: MessageKey; hint: MessageKey }[] = [
  { id: 'smart', name: 'base.smart', hint: 'base.smartHint' },
  { id: 'lowest', name: 'base.lowest', hint: 'base.lowestHint' },
  { id: 'plane', name: 'base.plane', hint: 'base.planeHint' },
  { id: 'level', name: 'base.level', hint: 'base.levelHint' },
  { id: 'mean', name: 'base.mean', hint: 'base.meanHint' },
  { id: 'surface', name: 'base.surface', hint: 'base.surfaceHint' },
  { id: 'custom', name: 'base.custom', hint: 'base.customHint' },
];

/**
 * Which of the seven bases a side is. Lowest point and Fixed level are reference bases (the
 * lowest point on the perimeter, a typed level); a survey or design side is "surface". Null for a
 * reference mode the picker does not offer (an older file's highest point, say).
 */
export function baseIdOf(ref: SurfaceRef): BaseId | null {
  switch (ref.kind) {
    case 'smart':
      return 'smart';
    case 'fit-plane':
      return 'plane';
    case 'perimeter-mean':
      return 'mean';
    case 'custom':
      return 'custom';
    case 'reference':
      return ref.mode === 'perimeter-min' ? 'lowest' : ref.mode === 'level' ? 'level' : null;
    default:
      return 'surface';
  }
}

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
