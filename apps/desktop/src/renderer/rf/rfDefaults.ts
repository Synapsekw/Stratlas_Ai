/**
 * What the coverage job assumes when a person leaves a field empty (R9). This mirrors
 * `python/src/aio_pipelines/rf/inputs.py` (`resolve`), so the live preview and the run agree:
 *
 * - AAU power per port: the AAU's `totalPowerDbm` (labelled "AAU total power"); a radio unit
 *   falls back to its `maxPowerDbmPerPort`; neither: the carrier cannot be computed.
 * - E-tilt when none is set: 0 clamped into the port's (or AAU's) range.
 * - Port pick: the carrier's `port`, else the first port whose band range holds the frequency,
 *   else the first port.
 * - Gain: the catalogue port's `gainDbi` (also with a measured MSI pattern; the file's GAIN is not
 *   used). AAU: `ssbGainDbi`.
 * - NR subcarrier spacing: 30 kHz on TDD bands, 15 kHz on FDD.
 *
 * Warnings are codes with a subject (the UI owns the words). Pattern files are not read here.
 */
import {
  bandOfName,
  DEFAULT_AM_DB,
  DEFAULT_H_BEAMWIDTH_DEG,
  getEntry,
  subcarrierCount,
  type Tech,
} from '@aio/rf';
import type {
  CataloguePort,
  EtiltRange,
  RfAntennaSettings,
  RfCarrier,
  RfCatalogueEntry,
} from '@aio/schema';

export type DefaultWarningCode =
  | 'band-unknown'
  | 'scs-defaulted'
  | 'bandwidth-invalid'
  | 'no-ports'
  | 'port-missing'
  | 'port-defaulted'
  | 'etilt-defaulted'
  | 'power-aau-total'
  | 'power-radio-max'
  | 'power-missing';

export interface DefaultWarning {
  code: DefaultWarningCode;
  carrierId: string;
  /** The value involved (a band, a port id, a number), for the UI sentence. */
  detail?: string | number;
}

/** 0 degrees clamped into the range (the job's default when no e-tilt is set). */
export function defaultEtiltDeg(range: EtiltRange | undefined): number {
  return range ? Math.min(Math.max(0, range.minDeg), range.maxDeg) : 0;
}

/** The port a carrier uses on an antenna entry, and how it was found. */
export function pickPort(
  ports: readonly CataloguePort[],
  carrier: Pick<RfCarrier, 'port'>,
  frequencyMhz: number,
): { port: CataloguePort; how: 'named' | 'band' | 'first' } | { port: null; how: 'missing' } {
  if (carrier.port !== undefined) {
    const hit = ports.find((p) => p.id === carrier.port);
    return hit ? { port: hit, how: 'named' } : { port: null, how: 'missing' };
  }
  const byBand = ports.find(
    (p) => p.bandRangeMhz[0] <= frequencyMhz && frequencyMhz <= p.bandRangeMhz[1],
  );
  if (byBand) return { port: byBand, how: 'band' };
  const first = ports[0];
  return first ? { port: first, how: 'first' } : { port: null, how: 'missing' };
}

export type PowerBasis = 'set' | 'aau-total' | 'radio-max';

export interface ResolvedCarrier {
  carrierId: string;
  tech: Tech;
  frequencyMhz: number;
  scsKhz: number | null;
  /** 12 N_RB. */
  subcarriers: number;
  portId: string | null;
  gainDbi: number;
  etiltDeg: number;
  powerDbm: number;
  powerBasis: PowerBasis;
  feederLossDb: number;
  /** Front-to-back as the generic pattern's cap, dB (the job's default for an AAU or a port without one). */
  frontToBackDb: number;
  hBeamwidthDeg: number;
  vBeamwidthDeg: number;
  etiltRange: EtiltRange | null;
}

export interface CarrierResolution {
  /** null when the carrier cannot be computed (the job leaves it out). */
  carrier: ResolvedCarrier | null;
  warnings: DefaultWarning[];
}

const DEFAULT_V_BEAMWIDTH_DEG = 10;

/** One carrier of one unit with every default the job applies. */
export function resolveCarrier(
  settings: Pick<RfAntennaSettings, 'equipment' | 'etiltDeg'>,
  carrier: RfCarrier,
  catalogue: readonly RfCatalogueEntry[],
): CarrierResolution {
  const warnings: DefaultWarning[] = [];
  const left = (): CarrierResolution => ({ carrier: null, warnings });
  const id = carrier.id;
  const eq = settings.equipment;
  if (!eq) return left();
  const entry = getEntry(catalogue, eq.kind === 'aau' ? eq.aau : eq.antenna);
  const want = eq.kind === 'aau' ? 'aau' : 'antenna';
  if (entry?.kind !== want) return left();

  const band = bandOfName(carrier.band);
  const frequencyMhz = carrier.frequencyMhz ?? band?.centreMHz;
  if (frequencyMhz === undefined) {
    warnings.push({ code: 'band-unknown', carrierId: id, detail: carrier.band });
    return left();
  }
  let scsKhz: number | null = carrier.scsKhz ?? null;
  if (carrier.tech === 'nr' && scsKhz === null) {
    scsKhz = band?.duplex === 'TDD' ? 30 : 15;
    warnings.push({ code: 'scs-defaulted', carrierId: id, detail: scsKhz });
  }
  let subcarriers: number;
  try {
    subcarriers = subcarrierCount({
      tech: carrier.tech,
      bandwidthMHz: carrier.bandwidthMhz,
      ...(scsKhz === null ? {} : { scsKHz: scsKhz }),
    });
  } catch {
    warnings.push({ code: 'bandwidth-invalid', carrierId: id, detail: carrier.bandwidthMhz });
    return left();
  }
  const feederLossDb = carrier.feederLossDb;
  const tiltFor = (range: EtiltRange | undefined): number => {
    if (settings.etiltDeg !== undefined) return settings.etiltDeg;
    const t = defaultEtiltDeg(range);
    warnings.push({ code: 'etilt-defaulted', carrierId: id, detail: t });
    return t;
  };

  if (entry.kind === 'aau') {
    const etiltDeg = tiltFor(entry.etilt);
    let powerDbm = carrier.powerDbmPerPort;
    let powerBasis: PowerBasis = 'set';
    if (powerDbm === undefined) {
      powerDbm = entry.totalPowerDbm;
      powerBasis = 'aau-total';
      warnings.push({ code: 'power-aau-total', carrierId: id, detail: powerDbm });
    }
    return {
      warnings,
      carrier: {
        carrierId: id,
        tech: carrier.tech,
        frequencyMhz,
        scsKhz,
        subcarriers,
        portId: null,
        gainDbi: entry.ssbGainDbi,
        etiltDeg,
        powerDbm,
        powerBasis,
        feederLossDb,
        frontToBackDb: DEFAULT_AM_DB,
        hBeamwidthDeg: entry.ssbHBeamwidthDeg || DEFAULT_H_BEAMWIDTH_DEG,
        vBeamwidthDeg: entry.ssbVBeamwidthDeg || DEFAULT_V_BEAMWIDTH_DEG,
        etiltRange: entry.etilt ?? null,
      },
    };
  }
  if (entry.ports.length === 0) {
    warnings.push({ code: 'no-ports', carrierId: id, detail: entry.id });
    return left();
  }
  const pick = pickPort(entry.ports, carrier, frequencyMhz);
  if (pick.port === null) {
    warnings.push({ code: 'port-missing', carrierId: id, detail: carrier.port ?? '' });
    return left();
  }
  if (pick.how === 'first')
    warnings.push({ code: 'port-defaulted', carrierId: id, detail: pick.port.id });
  const port = pick.port;
  const etiltDeg = tiltFor(port.etilt);
  let powerDbm = carrier.powerDbmPerPort;
  let powerBasis: PowerBasis = 'set';
  if (powerDbm === undefined) {
    const radioId = carrier.radioUnit ?? (eq.kind === 'separate' ? eq.radio : undefined);
    const radio = radioId === undefined ? undefined : getEntry(catalogue, radioId);
    if (radio?.kind !== 'radio') {
      warnings.push({ code: 'power-missing', carrierId: id });
      return left();
    }
    powerDbm = radio.maxPowerDbmPerPort;
    powerBasis = 'radio-max';
    warnings.push({ code: 'power-radio-max', carrierId: id, detail: powerDbm });
  }
  return {
    warnings,
    carrier: {
      carrierId: id,
      tech: carrier.tech,
      frequencyMhz,
      scsKhz,
      subcarriers,
      portId: port.id,
      gainDbi: port.gainDbi,
      etiltDeg,
      powerDbm,
      powerBasis,
      feederLossDb,
      frontToBackDb: port.frontToBackDb || DEFAULT_AM_DB,
      hBeamwidthDeg: port.hBeamwidthDeg || DEFAULT_H_BEAMWIDTH_DEG,
      vBeamwidthDeg: port.vBeamwidthDeg || DEFAULT_V_BEAMWIDTH_DEG,
      etiltRange: port.etilt,
    },
  };
}

/** Auto-plan, rules only (C2): an AAU-like face gets this AAU on n78. */
export const AUTOPLAN_AAU = {
  aau: 'generic-aau-64t64r-n78',
  band: 'n78',
  tech: 'nr',
  bandwidthMhz: 100,
} as const;

/** Auto-plan, rules only (C2): any other face gets this panel and radio on B3. */
export const AUTOPLAN_PANEL = {
  antenna: 'generic-panel-65-17',
  radio: 'generic-rru-4t4r-4x40w',
  band: 'B3',
  tech: 'lte',
  bandwidthMhz: 20,
} as const;

/** A face at least this deep and this wide is AAU-like. */
export const AAU_MIN_DEPTH_M = 0.15;
export const AAU_MIN_WIDTH_M = 0.4;
