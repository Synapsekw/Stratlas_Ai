import { z } from 'zod';
import { IsoTime, ProjectPath, Vec2, Vec3 } from './common';
import { readVersioned, type VersionedRead } from './versions';

/*
 * RF coverage prediction (spec docs/superpowers/specs/2026-10-17-rf-coverage-design.md):
 *
 * - `rf/sectors.json` (`aio.rf-sectors/1`, D8): sectors, per-antenna RF settings and the study
 *   settings, keyed by the antenna-detection unit id. RF settings never go into `antennas.json`.
 * - `rf/catalogue.json` and userData `rf-catalogue/` (`aio.rf-catalogue/1`, D10): antenna, radio and
 *   AAU records. The project copy holds the entries a project uses.
 * - `rf/runs/<runId>/run.json` (`aio.rf-run/1`, D12): a coverage run's inputs snapshot and outputs.
 *
 * Nothing here imports `jobs.ts` or `ipc.ts` (they import this file). RF reads antenna geometry
 * through the antenna-detection file only and never imports `antennas.ts`, so the antenna id rule is repeated
 * here and must follow that schema.
 */

export const RF_SECTORS_SCHEMA = 'aio.rf-sectors/1';
export const RF_CATALOGUE_SCHEMA = 'aio.rf-catalogue/1';
export const RF_RUN_SCHEMA = 'aio.rf-run/1';

/** Project-relative homes of the RF files. */
export const RF_SECTORS_PATH = 'rf/sectors.json';
export const RF_CATALOGUE_PATH = 'rf/catalogue.json';
export const RF_RUNS_DIR = 'rf/runs';

// ---- ids ---------------------------------------------------------------------------------------

/** An antenna-detection unit id (antenna-detection `AntennaUnit.id`): the same rule, repeated. */
export const AntennaId = z.string().regex(/^ant-[a-z0-9-]{1,60}$/, 'Not an antenna id');
/** A sector id inside `rf/sectors.json`. */
export const SectorId = z.string().regex(/^sec-[a-z0-9-]{1,60}$/, 'Not a sector id');
/** A catalogue entry id: file-name safe, stable across catalogue versions. */
export const CatalogueId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/, 'Not a catalogue id');
/** A coverage run id; the run folder is `rf/runs/<runId>/`. */
export const RfRunId = z.string().regex(/^rf-[a-z0-9-]{1,60}$/, 'Not an RF run id');

const Label = z.string().trim().min(1).max(120);
const CarrierId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Not a carrier id');
const PortId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/, 'Not a port id');

// ---- catalogue (D10, D11) ----------------------------------------------------------------------

/** Lowest and highest frequency, MHz. */
const BandRangeMhz = z
  .tuple([z.number().positive().max(100_000), z.number().positive().max(100_000)])
  .refine(([lo, hi]) => lo < hi, 'The band range must run from low to high');

/** Electrical tilt range and step of a port, degrees. */
export const EtiltRange = z
  .object({
    minDeg: z.number().min(-20).max(40),
    maxDeg: z.number().min(-20).max(40),
    stepDeg: z.number().positive().max(10),
  })
  .strict()
  .refine((r) => r.minDeg <= r.maxDeg, 'The e-tilt range must run from low to high');
export type EtiltRange = z.infer<typeof EtiltRange>;

/** A measured pattern (MSI / Planet file) for one frequency and one e-tilt step. */
export const PatternRef = z
  .object({
    frequencyMhz: z.number().positive().max(100_000),
    etiltDeg: z.number().min(-20).max(40),
    /** Relative to the catalogue folder (built in or user) or to the project `rf/` folder. */
    file: ProjectPath,
  })
  .strict();

export const CataloguePort = z
  .object({
    id: PortId,
    bandRangeMhz: BandRangeMhz,
    gainDbi: z.number().min(-10).max(50),
    hBeamwidthDeg: z.number().positive().max(360),
    vBeamwidthDeg: z.number().positive().max(180),
    /** Front-to-back ratio, dB (a positive number of dB below the peak). */
    frontToBackDb: z.number().min(0).max(80),
    etilt: EtiltRange,
    patterns: z.array(PatternRef).max(400),
  })
  .strict();
export type CataloguePort = z.infer<typeof CataloguePort>;

const EntryBase = {
  id: CatalogueId,
  vendor: Label,
  model: Label,
  /** A datasheet URL, a vendor pack name or "user". */
  source: z.string().trim().min(1).max(500),
  /** False until checked against the unit's own datasheet; the UI shows "check the datasheet". */
  verified: z.boolean(),
};

export const CatalogueAntenna = z
  .object({
    kind: z.literal('antenna'),
    ...EntryBase,
    ports: z.array(CataloguePort).min(1).max(32),
  })
  .strict()
  .refine((a) => new Set(a.ports.map((p) => p.id)).size === a.ports.length, {
    message: 'Port ids must be unique',
    path: ['ports'],
  });

export const CatalogueRadio = z
  .object({
    kind: z.literal('radio'),
    ...EntryBase,
    bandRangeMhz: BandRangeMhz,
    txPorts: z.number().int().min(1).max(64),
    rxPorts: z.number().int().min(1).max(64),
    maxPowerDbmPerPort: z.number().min(0).max(70),
    maxBandwidthMhz: z.number().positive().max(1000),
    mounting: z.enum(['tower', 'pole', 'wall', 'ground', 'indoor']),
  })
  .strict();

/** An integrated antenna and radio. Gain and pattern are the SSB or broadcast beam's (D13). */
export const CatalogueAau = z
  .object({
    kind: z.literal('aau'),
    ...EntryBase,
    bandRangeMhz: BandRangeMhz,
    ports: z.number().int().min(1).max(512),
    totalPowerDbm: z.number().min(0).max(80),
    ssbGainDbi: z.number().min(-10).max(50),
    ssbHBeamwidthDeg: z.number().positive().max(360),
    ssbVBeamwidthDeg: z.number().positive().max(180),
    etilt: EtiltRange.optional(),
    patterns: z.array(PatternRef).max(400).optional(),
  })
  .strict();

export const RfCatalogueEntry = z.discriminatedUnion('kind', [
  CatalogueAntenna,
  CatalogueRadio,
  CatalogueAau,
]);
export type RfCatalogueEntry = z.infer<typeof RfCatalogueEntry>;

export const RfCatalogue = z
  .object({
    schema: z.literal(RF_CATALOGUE_SCHEMA),
    entries: z.array(RfCatalogueEntry).max(5000),
  })
  .strict()
  .refine((c) => new Set(c.entries.map((e) => e.id)).size === c.entries.length, {
    message: 'Catalogue ids must be unique',
    path: ['entries'],
  });
export type RfCatalogue = z.infer<typeof RfCatalogue>;

/** Where a listed catalogue entry comes from. */
export const CatalogueOrigin = z.enum(['builtin', 'user', 'project']);
export type CatalogueOrigin = z.infer<typeof CatalogueOrigin>;

// ---- study settings (D8, D13, D14, D17) --------------------------------------------------------

export const PropagationModel = z.enum(['tr38901', 'okumura-hata', 'cost231-hata', 'free-space']);
export type PropagationModel = z.infer<typeof PropagationModel>;
export const RfEnvironment = z.enum(['uma', 'umi', 'rma']);
export type RfEnvironment = z.infer<typeof RfEnvironment>;
export const MarginPreset = z.enum(['outdoor', 'in-car', 'indoor', 'deep-indoor']);
export type MarginPreset = z.infer<typeof MarginPreset>;

/** Penetration margin per preset, dB (D13). */
export const MARGIN_PRESET_DB = {
  outdoor: 0,
  'in-car': 7,
  indoor: 15,
  'deep-indoor': 20,
} as const satisfies Record<MarginPreset, number>;

/** Class floors, dBm: Excellent above the first, then Good, Fair, Poor; No service below the last. */
export const RfThresholds = z
  .object({
    excellentDbm: z.number().min(-160).max(0),
    goodDbm: z.number().min(-160).max(0),
    fairDbm: z.number().min(-160).max(0),
    poorDbm: z.number().min(-160).max(0),
  })
  .strict()
  .refine((t) => t.excellentDbm > t.goodDbm && t.goodDbm > t.fairDbm && t.fairDbm > t.poorDbm, {
    message: 'Thresholds must fall from Excellent to Poor',
  });
export type RfThresholds = z.infer<typeof RfThresholds>;

export const DEFAULT_RF_THRESHOLDS: RfThresholds = {
  excellentDbm: -80,
  goodDbm: -95,
  fairDbm: -105,
  poorDbm: -115,
};

export const RfStudy = z
  .object({
    model: PropagationModel.default('tr38901'),
    environment: RfEnvironment.default('uma'),
    /** Above the tower base ground (D17). */
    ueHeightM: z.number().min(0.5).max(30).default(1.5),
    marginPreset: MarginPreset.default('outdoor'),
    bodyLossDb: z.number().min(0).max(15).default(3),
    /** Cell-edge probability for the log-normal fade margin (90 % gives 1.28 sigma). */
    edgeProbability: z.number().min(0.5).max(0.999).default(0.9),
    shadowSigmaDb: z.number().min(0).max(20).default(8),
    thresholds: RfThresholds.default(DEFAULT_RF_THRESHOLDS),
    /** Pixel size, 5 to 50 m (D17). */
    gridResolutionM: z.number().min(5).max(50).default(10),
    /** Study radius around the site, up to 15 km (D17). */
    radiusM: z.number().min(100).max(15_000).default(3000),
  })
  .strict();
export type RfStudy = z.infer<typeof RfStudy>;

export const DEFAULT_RF_STUDY: RfStudy = RfStudy.parse({});

// ---- sectors file (D5, D7, D8) -----------------------------------------------------------------

export const RfTech = z.enum(['lte', 'nr']);
export type RfTech = z.infer<typeof RfTech>;
/** NR subcarrier spacing, kHz; LTE is always 15. */
export const ScsKhz = z.union([z.literal(15), z.literal(30), z.literal(60), z.literal(120)]);

/** One carrier on one radio port. */
export const RfCarrier = z
  .object({
    id: CarrierId,
    /** Catalogue radio id; absent for an AAU (its radio is built in). */
    radioUnit: CatalogueId.optional(),
    /** Catalogue antenna port id; absent for an AAU. */
    port: PortId.optional(),
    tech: RfTech,
    /** Band name, e.g. `B3` or `n78` (the band table lives in `packages/rf`). */
    band: z.string().regex(/^[A-Za-z0-9-]{1,12}$/, 'Not a band name'),
    /** Centre frequency when the band default is not right, MHz. */
    frequencyMhz: z.number().positive().max(100_000).optional(),
    bandwidthMhz: z.number().positive().max(1000),
    scsKhz: ScsKhz.optional(),
    /** Power per port, dBm. Absent: the radio's maximum (flagged in the tab). */
    powerDbmPerPort: z.number().min(0).max(80).optional(),
    /** Feeder or jumper loss, dB. */
    feederLossDb: z.number().min(0).max(30).default(0),
  })
  .strict();
export type RfCarrier = z.infer<typeof RfCarrier>;

/** An AAU replaces the antenna and the radio, so it excludes both (D10). */
export const RfEquipment = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('separate'), antenna: CatalogueId, radio: CatalogueId.optional() })
    .strict(),
  z.object({ kind: z.literal('aau'), aau: CatalogueId }).strict(),
]);
export type RfEquipment = z.infer<typeof RfEquipment>;

/** RF settings of one detected antenna unit. */
export const RfAntennaSettings = z
  .object({
    antennaId: AntennaId,
    equipment: RfEquipment.optional(),
    /** Height above ground, metres, when the person overrides the detected one (basis user). */
    heightOverrideM: z.number().min(0).max(1000).optional(),
    /** Electrical tilt, degrees; checked against the catalogue port by `etiltProblems`. */
    etiltDeg: z.number().min(-20).max(40).optional(),
    /** The RF active flag (D5). */
    active: z.boolean().default(true),
    carriers: z.array(RfCarrier).max(16).default([]),
  })
  .strict()
  .refine((a) => new Set(a.carriers.map((c) => c.id)).size === a.carriers.length, {
    message: 'Carrier ids must be unique',
    path: ['carriers'],
  });
export type RfAntennaSettings = z.infer<typeof RfAntennaSettings>;

export const RfSector = z
  .object({ id: SectorId, name: Label, antennaIds: z.array(AntennaId).max(64) })
  .strict();
export type RfSector = z.infer<typeof RfSector>;

export const RfSectorsFile = z
  .object({
    schema: z.literal(RF_SECTORS_SCHEMA),
    sectors: z.array(RfSector).max(64),
    /** Keyed by `AntennaUnit.id`; orphans stay here until a person removes or reassigns them (D9). */
    antennas: z.array(RfAntennaSettings).max(512),
    study: RfStudy,
  })
  .strict()
  .superRefine((f, ctx) => {
    const ids = f.sectors.map((s) => s.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Sector ids must be unique', path: ['sectors'] });
    const members = f.sectors.flatMap((s) => s.antennaIds);
    if (new Set(members).size !== members.length)
      ctx.addIssue({
        code: 'custom',
        message: 'An antenna can belong to one sector only',
        path: ['sectors'],
      });
    const settings = f.antennas.map((a) => a.antennaId);
    if (new Set(settings).size !== settings.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Each antenna can have one settings entry',
        path: ['antennas'],
      });
  });
export type RfSectorsFile = z.infer<typeof RfSectorsFile>;

// ---- coverage run (D12) ------------------------------------------------------------------------

export const RfRunStatus = z.enum(['done', 'failed']);

/** The geometry of one unit as the run used it (read from `antennas.json`, never written back). */
export const RfRunAntenna = z
  .object({
    id: AntennaId,
    /** Box centre in the project CRS (east, north, z). */
    centre: Vec3,
    groundZ: z.number().nullable().optional(),
    heightM: z.number().optional(),
    azimuthGridDeg: z.number().optional(),
    convergenceDeg: z.number().nullable().optional(),
    downtiltDeg: z.number().optional(),
    status: z.string().max(40).optional(),
  })
  .strict();

export const RfRunGrid = z
  .object({
    crs: z.string().min(1).max(64),
    resolutionM: z.number().min(5).max(50),
    radiusM: z.number().min(100).max(15_000),
    /** Top left corner of the grid in the project CRS. */
    origin: Vec2,
    width: z.number().int().min(1).max(20_000),
    height: z.number().int().min(1).max(20_000),
    nodata: z.number(),
  })
  .strict();

export const RfRun = z
  .object({
    schema: z.literal(RF_RUN_SCHEMA),
    runId: RfRunId,
    createdAt: IsoTime,
    status: RfRunStatus,
    /** Everything the result depends on, so a later edit never changes an old run silently. */
    inputs: z.object({ sectors: RfSectorsFile, antennas: z.array(RfRunAntenna).max(512) }).strict(),
    catalogue: z
      .array(
        z
          .object({
            id: CatalogueId,
            kind: z.enum(['antenna', 'radio', 'aau']),
            verified: z.boolean(),
          })
          .strict(),
      )
      .max(1000),
    model: z.object({ model: PropagationModel, environment: RfEnvironment }).strict(),
    grid: RfRunGrid,
    timings: z.object({ totalMs: z.number().min(0) }).catchall(z.number().min(0)),
    warnings: z.array(z.string().max(500)).max(200),
    /** True when a draft (unreviewed) antenna took part (D3). */
    usedUnreviewed: z.boolean(),
    /** Per antenna: a measured pattern or the generic 38.901 fallback (labelled in the UI). */
    patterns: z
      .array(z.object({ antennaId: AntennaId, source: z.enum(['msi', 'generic']) }).strict())
      .max(512),
    /** Grid files, relative to the run folder. */
    outputs: z
      .object({
        rsrp: ProjectPath,
        bestServer: ProjectPath,
        overlap: ProjectPath,
        pathLossDir: ProjectPath.optional(),
      })
      .strict(),
  })
  .strict();
export type RfRun = z.infer<typeof RfRun>;

// ---- readers -----------------------------------------------------------------------------------

type Reader<T> = (raw: unknown, appName?: string) => VersionedRead<T>;

function reader<T>(family: string, what: string, schema: z.ZodType<T>): Reader<T> {
  return (raw, appName) =>
    readVersioned(raw, { family, schema, what, ...(appName === undefined ? {} : { appName }) });
}

/** Read `rf/sectors.json`: a newer version is refused with the update message, nothing changed. */
export const parseRfSectors = reader('aio.rf-sectors', 'rf/sectors.json', RfSectorsFile);
/** Read a catalogue file (built in, userData or project). */
export const parseRfCatalogue = reader('aio.rf-catalogue', 'The RF catalogue', RfCatalogue);
/** Read `rf/runs/<runId>/run.json`. */
export const parseRfRun = reader('aio.rf-run', 'The coverage run', RfRun);

// ---- e-tilt against the catalogue (D5, D10) ----------------------------------------------------

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

function tiltFits(r: EtiltRange, deg: number): boolean {
  if (deg < r.minDeg - 1e-9 || deg > r.maxDeg + 1e-9) return false;
  const steps = (deg - r.minDeg) / r.stepDeg;
  return near(steps, Math.round(steps));
}

const rangeText = (r: EtiltRange): string => `${String(r.minDeg)} to ${String(r.maxDeg)}`;

/**
 * Why the settings' electrical tilt does not fit the catalogue, in plain words; empty when it fits
 * or when there is no tilt to check. The tilt must lie inside the range of every port a carrier
 * uses (of any port when no carrier names one) and on that port's step. The sectors file alone
 * cannot say this, because the range lives in the catalogue.
 */
export function etiltProblems(
  s: RfAntennaSettings,
  catalogue: readonly RfCatalogueEntry[],
): string[] {
  const tilt = s.etiltDeg;
  const eq = s.equipment;
  if (tilt === undefined || eq === undefined) return [];
  if (eq.kind === 'aau') {
    const aau = catalogue.find((e) => e.id === eq.aau);
    if (aau?.kind !== 'aau') return [`AAU ${eq.aau} is not in the catalogue.`];
    if (!aau.etilt) return [];
    return tiltFits(aau.etilt, tilt)
      ? []
      : [`E-tilt ${String(tilt)} is outside ${rangeText(aau.etilt)} degrees for ${aau.id}.`];
  }
  const ant = catalogue.find((e) => e.id === eq.antenna);
  if (ant?.kind !== 'antenna') return [`Antenna ${eq.antenna} is not in the catalogue.`];
  const named = [...new Set(s.carriers.flatMap((c) => (c.port === undefined ? [] : [c.port])))];
  const problems: string[] = [];
  if (named.length > 0) {
    for (const id of named) {
      const port = ant.ports.find((p) => p.id === id);
      if (!port) problems.push(`Port ${id} is not a port of ${ant.id}.`);
      else if (!tiltFits(port.etilt, tilt))
        problems.push(
          `E-tilt ${String(tilt)} is outside ${rangeText(port.etilt)} degrees for port ${id} of ${ant.id}.`,
        );
    }
    return problems;
  }
  if (ant.ports.some((p) => tiltFits(p.etilt, tilt))) return [];
  return [
    `E-tilt ${String(tilt)} fits no port of ${ant.id} (${ant.ports.map((p) => rangeText(p.etilt)).join(', ')} degrees).`,
  ];
}
