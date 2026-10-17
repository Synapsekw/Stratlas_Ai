/**
 * The live preview's input (spec D15, D16), built from the store the way the job builds its
 * sources (python `rf/inputs.py` `resolve`, `rf/pipeline.py`): every sector member that takes part
 * (`row.excluded === null`), one source per resolved carrier (`rfDefaults.ts`, the job's
 * defaults), a measured pattern when the catalogue port (or AAU) has a pattern file for the
 * frequency and e-tilt and it could be read, else the generic 38.901 pattern. A carrier whose
 * propagation setup is refused is left out, as the job leaves it out. The grid is the job's study
 * grid around the mean antenna position.
 *
 * Pure: the pattern files are passed in (`patterns`, read by the caller), and the plan names the
 * files it would use (`patternFiles`) so the caller can read them and plan again.
 */
import {
  DEFAULT_AM_DB,
  getEntry,
  margins,
  pathLossRefusal,
  pickNearestPattern,
  studyGrid,
  type AntennaPattern,
  type PathLossSetup,
  type PreviewGrid,
  type PreviewRequest,
  type PreviewSourceSettings,
  type TwoCutPattern,
} from '@aio/rf';
import type { AntennasFile, RfCatalogueEntry, RfSectorsFile } from '@aio/schema';
import type { RfUnitRow } from './rfModel';

/** A pattern file to read: project path (under `rf/`) and the front-to-back cap it is read with. */
export interface PatternFile {
  path: string;
  capDb: number;
}
export const patternKey = (f: PatternFile): string => `${f.path}|${String(f.capDb)}`;

export interface PathLossJob {
  key: string;
  antenna: { east: number; north: number };
  setup: PathLossSetup;
}

export interface PreviewPlan {
  grid: PreviewGrid;
  radiusM: number;
  request: PreviewRequest;
  pathLoss: PathLossJob[];
  /** Pattern files the plan would use; those missing from `patterns` were planned as generic. */
  patternFiles: PatternFile[];
  /** Antenna centres that take part (project CRS), for the boresight arrows. */
  sources: { antennaId: string; sectorId: string }[];
}

export interface PlanInput {
  rows: readonly RfUnitRow[];
  sectors: RfSectorsFile;
  antennas: AntennasFile | null;
  catalogue: readonly RfCatalogueEntry[];
}

/** The measured pattern refs of the equipment a carrier uses, and the cap they are read with. */
function patternRefs(
  entry: RfCatalogueEntry | undefined,
  portId: string | null,
): { refs: { frequencyMhz: number; etiltDeg: number; file: string }[]; capDb: number } {
  if (entry?.kind === 'aau') return { refs: entry.patterns ?? [], capDb: DEFAULT_AM_DB };
  if (entry?.kind === 'antenna') {
    const port = entry.ports.find((p) => p.id === portId);
    if (port) return { refs: port.patterns, capDb: port.frontToBackDb || DEFAULT_AM_DB };
  }
  return { refs: [], capDb: DEFAULT_AM_DB };
}

/** The preview plan, or null when nothing takes part. */
export function previewPlan(
  i: PlanInput,
  patterns: ReadonlyMap<string, TwoCutPattern>,
): PreviewPlan | null {
  if (!i.antennas) return null;
  const units = new Map(i.antennas.units.map((u) => [u.id, u]));
  const rows = new Map(i.rows.map((r) => [r.id, r]));
  const study = i.sectors.study;
  const ue = study.ueHeightM;

  interface Draft {
    sectorId: string;
    antennaId: string;
    east: number;
    north: number;
    settings: Omit<PreviewSourceSettings, 'pathLossKey'>;
    setup: PathLossSetup;
  }
  const drafts: Draft[] = [];
  const files = new Map<string, PatternFile>();
  for (const sec of i.sectors.sectors) {
    for (const id of sec.antennaIds) {
      const row = rows.get(id);
      const u = units.get(id);
      if (!row || !u || row.excluded !== null || row.height.heightM === null) continue;
      const az = u.azimuthGridDeg?.value;
      if (az === undefined) continue;
      const eq = row.settings?.equipment;
      const entry = eq ? getEntry(i.catalogue, eq.kind === 'aau' ? eq.aau : eq.antenna) : undefined;
      const [east, north] = u.box.centre;
      for (const c of row.carriers) {
        const setup: PathLossSetup = {
          model: study.model,
          environment: study.environment,
          frequencyMHz: c.frequencyMhz,
          hBsM: row.height.heightM,
          hUtM: ue,
        };
        if (pathLossRefusal(setup)) continue;
        const { refs, capDb } = patternRefs(entry, c.portId);
        const pick = pickNearestPattern(refs, c.frequencyMhz, c.etiltDeg);
        let pattern: AntennaPattern = {
          kind: 'parametric',
          hBeamwidthDeg: c.hBeamwidthDeg,
          vBeamwidthDeg: c.vBeamwidthDeg,
          eTiltDeg: c.etiltDeg,
          amDb: c.frontToBackDb,
        };
        if (pick) {
          const f: PatternFile = { path: `rf/${pick.ref.file}`, capDb };
          files.set(patternKey(f), f);
          const measured = patterns.get(patternKey(f));
          if (measured) pattern = measured;
        }
        drafts.push({
          sectorId: sec.id,
          antennaId: id,
          east,
          north,
          setup,
          settings: {
            east,
            north,
            heightM: row.height.heightM,
            azimuthGridDeg: az,
            convergenceDeg: u.convergenceDeg,
            mechanicalDowntiltDeg: u.downtiltDeg?.value ?? 0,
            pattern,
            portPowerDbm: c.powerDbm,
            subcarriers: c.subcarriers,
            feederLossDb: c.feederLossDb,
            antennaGainDbi: c.gainDbi,
          },
        });
      }
    }
  }
  if (drafts.length === 0) return null;

  const centres = new Map(drafts.map((d) => [d.antennaId, [d.east, d.north] as const]));
  let ce = 0;
  let cn = 0;
  for (const [e, n] of centres.values()) {
    ce += e;
    cn += n;
  }
  ce /= centres.size;
  cn /= centres.size;
  const radiusM = study.radiusM;
  const grid = studyGrid(ce, cn, radiusM, study.gridResolutionM);

  const pathLoss = new Map<string, PathLossJob>();
  const bySector = new Map<string, PreviewSourceSettings[]>();
  for (const d of drafts) {
    const s = d.setup;
    const key = [
      s.model,
      s.environment,
      s.frequencyMHz,
      s.hBsM,
      s.hUtM,
      d.east,
      d.north,
      grid.originEast,
      grid.originNorth,
      grid.width,
      grid.height,
      grid.resolutionM,
      radiusM,
    ].join('|');
    if (!pathLoss.has(key))
      pathLoss.set(key, { key, antenna: { east: d.east, north: d.north }, setup: s });
    const list = bySector.get(d.sectorId) ?? [];
    list.push({ ...d.settings, pathLossKey: key });
    bySector.set(d.sectorId, list);
  }
  const m = margins({
    marginPreset: study.marginPreset,
    bodyLossDb: study.bodyLossDb,
    edgeProbability: study.edgeProbability,
    shadowSigmaDb: study.shadowSigmaDb,
  });
  return {
    grid,
    radiusM,
    request: {
      grid,
      ueHeightM: ue,
      marginDb: m.totalDb,
      sectors: [...bySector].map(([id, sources]) => ({ id, sources })),
    },
    pathLoss: [...pathLoss.values()],
    patternFiles: [...files.values()],
    sources: drafts.map((d) => ({ antennaId: d.antennaId, sectorId: d.sectorId })),
  };
}
