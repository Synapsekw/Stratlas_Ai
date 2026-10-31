// Detect and scan a Flyability Inspector export folder for the inspection picker. Reads only the
// small JSON files (inspection, flight, map, poi, snapshot, asset); never opens a cloud, log or
// video, and never copies the operator e-mail or a flight's launch location into the result.
import { spacesOf, type InspectorScan, type ProjectManifest } from '@aio/schema';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

const REQUIRED = ['flights', 'maps', 'pois', 'snapshots'];

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isExport(p: string): Promise<boolean> {
  for (const name of REQUIRED) if (!(await isDir(join(p, name)))) return false;
  return true;
}

/** The export folder: `path` itself, or one direct child folder that holds the export. */
export async function findInspectorExport(path: string): Promise<string | null> {
  if (await isExport(path)) return path;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isDirectory() && (await isExport(join(path, e.name)))) return join(path, e.name);
  }
  return null;
}

type Json = Record<string, unknown>;
interface Rec {
  data: Json;
  dir: string;
}

async function readJson(path: string): Promise<Json | null> {
  try {
    const v: unknown = JSON.parse(await readFile(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

/** The records `<root>/<kind>/<id>/<file>` (never a `.backup` revision). */
async function records(root: string, kind: string, file: string): Promise<Rec[]> {
  let names: string[];
  try {
    names = await readdir(join(root, kind));
  } catch {
    return [];
  }
  const out: Rec[] = [];
  for (const n of names.sort()) {
    const dir = join(root, kind, n);
    const data = await readJson(join(dir, file));
    if (data) out.push({ data, dir });
  }
  return out;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Whether a file listed under `key` (`point_clouds`, `trajectories`) of a map is on disk. */
async function hasListed(map: Rec, key: string): Promise<boolean> {
  const list = map.data[key];
  if (!Array.isArray(list)) return false;
  for (const item of list) {
    const name = str((item as Json | null)?.file_path);
    if (name && (await isFile(join(map.dir, name)))) return true;
  }
  return false;
}

async function generationOf(flights: Rec[]): Promise<InspectorScan['generation']> {
  const found = new Set<InspectorScan['generation']>();
  for (const f of flights) {
    let names: string[] = [];
    try {
      names = await readdir(f.dir);
    } catch {
      /* no folder */
    }
    for (const n of names) {
      if (/_obcbag\.bag$/i.test(n)) found.add('2024-bag');
      else if (/_obcbag\.mcap$/i.test(n)) found.add('2025-mcap');
    }
  }
  const [only] = [...found];
  return found.size === 1 && only ? only : 'unknown';
}

function alignment(f: Json): 'relocalised' | 'transform' | 'reference' {
  if (f.relocalized === true) return 'relocalised';
  return f.transform != null ? 'transform' : 'reference';
}

export async function scanInspectorExport(
  root: string,
  manifest: ProjectManifest | null,
): Promise<InspectorScan> {
  const [inspections, flights, maps, pois, snapshots, assets] = await Promise.all([
    records(root, 'inspections', 'inspection.json'),
    records(root, 'flights', 'flight.json'),
    records(root, 'maps', 'map.json'),
    records(root, 'pois', 'poi.json'),
    records(root, 'snapshots', 'snapshot.json'),
    records(root, 'assets', 'asset.json'),
  ]);

  const idOf = (r: Rec): string => {
    const id = str(r.data.id);
    return id !== null && id !== '' ? id : basename(r.dir);
  };
  const spaces = manifest ? spacesOf(manifest) : [];
  const assetNames = new Map(assets.map((a) => [idOf(a), str(a.data.name)]));
  const poiIds = new Set(pois.map(idOf));
  const inspIds = inspections.map(idOf);
  const flightInsp = new Map(flights.map((f) => [idOf(f), str(f.data.inspection_id) ?? '']));

  // Same grouping as the import: a snapshot belongs to its flight's inspection, else to the sole
  // inspection, else it is skipped; its key is its POI when that is known, else its own.
  const findings = new Map<string, Set<string>>(inspIds.map((i) => [i, new Set<string>()]));
  for (const s of snapshots) {
    let iid = flightInsp.get(str(s.data.flight_id) ?? '');
    if (iid === undefined || !findings.has(iid)) {
      if (inspIds.length !== 1) continue;
      iid = inspIds[0];
    }
    const poi = str(s.data.poi_id) ?? '';
    findings.get(iid ?? '')?.add(poiIds.has(poi) ? poi : 'orphan:' + idOf(s));
  }

  const mapsOf = (type: string, parent: string): Rec[] =>
    maps.filter((m) => m.data.parent_type === type && str(m.data.parent_id) === parent);
  const stamp = (f: Rec): number =>
    typeof f.data.datetime_utc === 'number' ? f.data.datetime_utc : 0;

  const out: InspectorScan['inspections'] = [];
  for (const insp of inspections) {
    const inspId = idOf(insp);
    const own = flights
      .filter((f) => flightInsp.get(idOf(f)) === inspId)
      .sort(
        (x, y) =>
          stamp(x) - stamp(y) ||
          (str(x.data.name) ?? '').localeCompare(str(y.data.name) ?? '') ||
          idOf(x).localeCompare(idOf(y)),
      );
    let mergedCloud = false;
    for (const m of mapsOf('Inspection', inspId)) {
      if (await hasListed(m, 'point_clouds')) {
        mergedCloud = true;
        break;
      }
    }
    out.push({
      id: inspId,
      name: str(insp.data.name) ?? inspId,
      mergedCloud,
      findings: findings.get(inspId)?.size ?? 0,
      importedAs:
        spaces.find((s) => s.source?.kind === 'flyability' && s.source.inspectionId === inspId)
          ?.id ?? null,
      flights: await Promise.all(
        own.map(async (f) => {
          const fid = idOf(f);
          const map = mapsOf('Flight', fid)[0];
          return {
            id: fid,
            name: str(f.data.name) ?? fid,
            cloud: map ? await hasListed(map, 'point_clouds') : false,
            path: map ? await hasListed(map, 'trajectories') : false,
            aligned: alignment(f.data),
          };
        }),
      ),
    });
  }

  let asset: string | null = null;
  for (const insp of inspections) {
    const name = assetNames.get(str(insp.data.asset_id) ?? '');
    if (name) {
      asset = name;
      break;
    }
  }
  return { root, generation: await generationOf(flights), asset, inspections: out };
}
