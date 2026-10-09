import type { SiteMaterial } from '@aio/schema';

/**
 * Calculators (M11 G4, PRD SRV-6, data-conventions section 27). They work on a stored volume at
 * display time and never change it: the measurement keeps its bank (in situ) cubic metres, and
 * what a person reads here is derived from that number and the material.
 *
 * - Shrink and swell: loose = bank x `swell.loose`, compacted = bank x `swell.compacted`.
 * - Density: tonnes = volume x `densityTPerM3`.
 * - Weight: achieved density = tonnage / volume (the landfill compaction figure: 63,000 t over
 *   70,104 m3 is 0.899 t/m3).
 *
 * Everything is SI: cubic metres, tonnes and tonnes per cubic metre. Units are a display choice.
 */

/** The swell factors of a material: volume relative to bank, 1 is no change. */
export interface SwellFactors {
  loose: number;
  compacted: number;
}

/** A volume as bank, loose and compacted cubic metres. */
export interface SwellVolumes {
  bankM3: number;
  looseM3: number;
  compactedM3: number;
}

const finite = (name: string, v: number) => {
  if (!Number.isFinite(v)) throw new RangeError(`${name} must be a number (got ${String(v)}).`);
};
const positive = (name: string, v: number) => {
  finite(name, v);
  if (v <= 0) throw new RangeError(`${name} must be above zero (got ${String(v)}).`);
};

/** Bank cubic metres as loose and compacted cubic metres. */
export function swellVolumes(bankM3: number, swell: SwellFactors): SwellVolumes {
  finite('The volume', bankM3);
  positive('The loose factor', swell.loose);
  positive('The compacted factor', swell.compacted);
  return { bankM3, looseM3: bankM3 * swell.loose, compactedM3: bankM3 * swell.compacted };
}

/** A volume in one state back to bank cubic metres. */
export function toBank(volumeM3: number, state: keyof SwellVolumes, swell: SwellFactors): number {
  finite('The volume', volumeM3);
  if (state === 'bankM3') return volumeM3;
  const f = state === 'looseM3' ? swell.loose : swell.compacted;
  positive('The factor', f);
  return volumeM3 / f;
}

/** Tonnes from a volume and a density in tonnes per cubic metre. */
export function tonnesFrom(volumeM3: number, densityTPerM3: number): number {
  finite('The volume', volumeM3);
  positive('The density', densityTPerM3);
  return volumeM3 * densityTPerM3;
}

/**
 * The density a tonnage achieved in a volume (tonnes per cubic metre), or null when the volume
 * is zero (no density can be read from it).
 */
export function achievedDensity(tonnes: number, volumeM3: number): number | null {
  finite('The tonnage', tonnes);
  finite('The volume', volumeM3);
  if (volumeM3 === 0) return null;
  return tonnes / volumeM3;
}

/** What the calculators show for one volume and a material, all derived, never stored. */
export interface MaterialReadout {
  bankM3: number;
  looseM3: number | null;
  compactedM3: number | null;
  tonnes: number | null;
  /** From a tonnage a person typed (the weight calculator). */
  achievedTPerM3: number | null;
}

/**
 * The calculator rows for a stored volume (`bankM3`), its material (optional) and a typed tonnage
 * (optional). A material without swell factors gives no loose or compacted rows; without a
 * density, no tonnes.
 */
export function materialReadout(
  bankM3: number,
  material: Pick<SiteMaterial, 'densityTPerM3' | 'swell'> | null | undefined,
  typedTonnes?: number | null,
): MaterialReadout {
  finite('The volume', bankM3);
  const swell = material?.swell ? swellVolumes(bankM3, material.swell) : null;
  const density = material?.densityTPerM3;
  return {
    bankM3,
    looseM3: swell ? swell.looseM3 : null,
    compactedM3: swell ? swell.compactedM3 : null,
    tonnes: density !== undefined ? tonnesFrom(bankM3, density) : null,
    achievedTPerM3:
      typedTonnes !== null && typedTonnes !== undefined && Number.isFinite(typedTonnes)
        ? achievedDensity(typedTonnes, bankM3)
        : null,
  };
}

/** Decimal places a density is shown with (0.899 t/m3). */
export const DENSITY_DECIMALS = 3;
