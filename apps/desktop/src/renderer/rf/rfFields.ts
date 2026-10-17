/**
 * The RF tab's field rules, pure: the e-tilt range a unit's slider may use (the port's, or the
 * AAU's), clamping and snapping a tilt into it, the carrier bandwidths a band offers, and a
 * sector's bearing for its chip.
 */
import { bandOfName, getEntry, meanBearingDeg, trueAzimuthDeg } from '@aio/rf';
import type {
  AntennaUnit,
  EtiltRange,
  RfAntennaSettings,
  RfCarrier,
  RfCatalogueEntry,
  RfTech,
} from '@aio/schema';
import { defaultEtiltDeg, pickPort } from './rfDefaults';

/** The e-tilt range of the port (or AAU) the unit's first carrier uses; null without equipment. */
export function etiltRangeFor(
  s: Pick<RfAntennaSettings, 'equipment' | 'carriers'> | null,
  catalogue: readonly RfCatalogueEntry[],
): EtiltRange | null {
  const eq = s?.equipment;
  if (!s || !eq) return null;
  if (eq.kind === 'aau') {
    const e = getEntry(catalogue, eq.aau);
    return e?.kind === 'aau' ? (e.etilt ?? null) : null;
  }
  const e = getEntry(catalogue, eq.antenna);
  if (e?.kind !== 'antenna') return null;
  const c = s.carriers[0];
  const freq = c ? (c.frequencyMhz ?? bandOfName(c.band)?.centreMHz) : undefined;
  if (c && freq !== undefined) {
    const p = pickPort(e.ports, c, freq);
    if (p.port) return p.port.etilt;
  }
  return e.ports[0]?.etilt ?? null;
}

/** A tilt clamped into the range and snapped to its step (from the range's low end). */
export function clampEtilt(deg: number, r: EtiltRange): number {
  const inside = Math.min(Math.max(deg, r.minDeg), r.maxDeg);
  const steps = Math.round((inside - r.minDeg) / r.stepDeg);
  const snapped = r.minDeg + steps * r.stepDeg;
  const out = snapped > r.maxDeg + 1e-9 ? snapped - r.stepDeg : snapped;
  return Math.round(out * 1000) / 1000;
}

/** The tilt the slider shows: the person's (clamped into the range), else the job's default. */
export function shownEtilt(s: Pick<RfAntennaSettings, 'etiltDeg'> | null, r: EtiltRange): number {
  return s?.etiltDeg === undefined ? defaultEtiltDeg(r) : clampEtilt(s.etiltDeg, r);
}

const LTE_BW = [5, 10, 15, 20] as const;
const NR_BW_FDD = [5, 10, 15, 20, 25, 30, 40, 50] as const;
const NR_BW_TDD = [10, 20, 30, 40, 50, 60, 80, 90, 100] as const;

/** Standard channel bandwidths for the tech on the band (NR TDD at 30 kHz, FDD at 15 kHz). */
export function bandwidthChoices(tech: RfTech, band: string | undefined): readonly number[] {
  if (tech === 'lte') return LTE_BW;
  return bandOfName(band ?? '')?.duplex === 'TDD' ? NR_BW_TDD : NR_BW_FDD;
}

/** The default bandwidth for a new carrier. */
export function defaultBandwidth(tech: RfTech, band: string | undefined): number {
  const c = bandwidthChoices(tech, band);
  return c[c.length - 1] ?? 20;
}

/** The short band name of a carrier for its technology (B3 for LTE, n78 for NR). */
export function carrierBandName(c: Pick<RfCarrier, 'band' | 'tech'>): string {
  const b = bandOfName(c.band);
  if (!b) return c.band;
  const lte = b.lteBands[0];
  if (c.tech === 'nr' || lte === undefined) return b.nrBand ?? c.band;
  return `B${String(lte)}`;
}

/** True azimuth of a unit (grid plus convergence, `@aio/rf`); null without azimuth or CRS. */
export function trueAzimuth(
  u: Pick<AntennaUnit, 'azimuthGridDeg' | 'convergenceDeg'>,
): number | null {
  const grid = u.azimuthGridDeg?.value;
  if (grid === undefined || u.convergenceDeg === null) return null;
  return trueAzimuthDeg(grid, u.convergenceDeg);
}

/** A sector's bearing for its chip: the mean true azimuth of its units, null when none has one. */
export function sectorBearing(
  ids: readonly string[],
  units: readonly Pick<AntennaUnit, 'id' | 'azimuthGridDeg' | 'convergenceDeg'>[],
): number | null {
  const azs = ids.flatMap((id) => {
    const u = units.find((x) => x.id === id);
    const a = u ? trueAzimuth(u) : null;
    return a === null ? [] : [a];
  });
  return azs.length === 0 ? null : meanBearingDeg(azs);
}

/** The settings' e-tilt clamped into the range of the port (or AAU) they now use; unchanged without one. */
export function clampSettingsEtilt(
  s: RfAntennaSettings,
  catalogue: readonly RfCatalogueEntry[],
): RfAntennaSettings {
  if (s.etiltDeg === undefined) return s;
  const r = etiltRangeFor(s, catalogue);
  if (!r) return s;
  const etiltDeg = clampEtilt(s.etiltDeg, r);
  return etiltDeg === s.etiltDeg ? s : { ...s, etiltDeg };
}

/**
 * The one rule for changing a unit's equipment (the tab's picker and the CSV import): an AAU
 * replaces the antenna and radio and its carriers name neither a radio nor a port; a new antenna
 * keeps the radio and drops carrier ports it does not have; a radio needs a separate antenna
 * (null when there is none). The e-tilt is clamped into the new range.
 */
export function withEquipment(
  s: RfAntennaSettings,
  entry: RfCatalogueEntry,
  catalogue: readonly RfCatalogueEntry[],
): RfAntennaSettings | null {
  const all = catalogue.some((e) => e.id === entry.id) ? catalogue : [...catalogue, entry];
  const eq = s.equipment;
  let next: RfAntennaSettings;
  if (entry.kind === 'aau') {
    next = {
      ...s,
      equipment: { kind: 'aau', aau: entry.id },
      carriers: s.carriers.map((c) => {
        const n = { ...c };
        delete n.radioUnit;
        delete n.port;
        return n;
      }),
    };
  } else if (entry.kind === 'antenna') {
    const radio = eq?.kind === 'separate' ? eq.radio : undefined;
    next = {
      ...s,
      equipment: { kind: 'separate', antenna: entry.id, ...(radio ? { radio } : {}) },
      carriers: s.carriers.map((c) => {
        if (c.port === undefined || entry.ports.some((p) => p.id === c.port)) return c;
        const n = { ...c };
        delete n.port;
        return n;
      }),
    };
  } else {
    if (eq?.kind !== 'separate') return null;
    next = { ...s, equipment: { ...eq, radio: entry.id } };
  }
  return clampSettingsEtilt(next, all);
}
