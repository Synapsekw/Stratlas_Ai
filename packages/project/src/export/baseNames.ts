// The volume bases by the base picker's names: the one place that decides which base a side is
// and what a person reads for it. The app's picker, lists and reports name a base through the
// catalogue's `base.*` keys (`apps/desktop/src/renderer/survey/card/baseNames.ts`); the CSVs,
// which cannot read the catalogue from this package, use the English names here. A unit test in
// the desktop app holds the two equal. The engine's own words (a result's stored `fromLabel` and
// `toLabel`) are never changed: this is naming for display only. Pure and renderer safe.
import type { SurfaceRef } from '@aio/schema';

export type BaseId = 'smart' | 'lowest' | 'plane' | 'level' | 'mean' | 'surface' | 'custom';

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

/** The seven bases' names, as the catalogue's `base.*` keys have them. */
export const BASE_NAMES: Readonly<Record<BaseId, string>> = {
  smart: 'Toe surface',
  lowest: 'Lowest point',
  plane: 'Best-fit plane',
  level: 'Fixed level',
  mean: 'Average edge level',
  surface: 'Previous survey or design',
  custom: 'Custom',
};

/** Older files' reference modes the picker no longer offers, by their names. */
export const OLDER_MODE_NAMES: Readonly<Record<string, string>> = {
  'perimeter-max': 'Highest point',
  'interior-max': 'Highest point inside',
  'interior-min': 'Lowest point inside',
};

/**
 * A base's name as the base picker has it ("Toe surface", "Fixed level"); null for a survey or
 * design side, which is named by the survey or design itself.
 */
export function pickerBaseName(ref: SurfaceRef): string | null {
  const id = baseIdOf(ref);
  if (id === 'surface') return null;
  if (id !== null) return BASE_NAMES[id];
  const older = ref.kind === 'reference' ? OLDER_MODE_NAMES[ref.mode] : undefined;
  return older ?? BASE_NAMES.level;
}
