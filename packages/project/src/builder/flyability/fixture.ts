// A JSON-only Flyability Inspector export for TS tests. Same folder layout and links as the Python
// synthetic export (python/tests/flyability_synth.py); cloud and trajectory files are empty
// placeholders because the scan never opens them.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FIXTURE_EMAIL = 'operator@example.invalid';

export interface FixtureIds {
  inspectionId: string;
  assetId: string;
  /** [flight A (relocalised), flight B (a `transform` unless turned off)] */
  flightIds: string[];
  poiIds: string[];
  snapshotIds: string[];
  /** Maps by parent: each flight's, the merged inspection cloud and the Asset decoy. */
  mapIds: { flights: string[]; inspection: string; asset: string };
}

export interface FixtureOptions {
  generation?: '2024' | '2025';
  /** Flight B carries a non-null `transform` (default true). */
  transform?: boolean;
}

const MS = 1732684613000;
const audit = { created_by: FIXTURE_EMAIL, last_updated_by: FIXTURE_EMAIL, created_date: 1 };

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** The JSON plus two `.json.<ms>.backup` revisions whose content differs. */
async function writeJson(
  path: string,
  data: Record<string, unknown>,
  stale: Record<string, unknown>,
): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2));
  for (const delta of [1000, 6000]) {
    await writeFile(`${path}.${MS + delta}.backup`, JSON.stringify({ ...data, ...stale }, null, 2));
  }
}

async function folder(root: string, kind: string, folderId: string): Promise<string> {
  const d = join(root, kind, folderId);
  await mkdir(d, { recursive: true });
  return d;
}

export async function writeInspectorFixture(
  dir: string,
  opts: FixtureOptions = {},
): Promise<FixtureIds> {
  const generation = opts.generation ?? '2025';
  const withTransform = opts.transform ?? true;
  const ext = generation === '2024' ? 'bag' : 'mcap';
  const ids: FixtureIds = {
    inspectionId: id(1),
    assetId: id(2),
    flightIds: [id(10), id(11)],
    poiIds: [id(20), id(21), id(22)],
    snapshotIds: [id(30), id(31), id(32), id(33)],
    mapIds: { flights: [id(40), id(41)], inspection: id(42), asset: id(43) },
  };
  await mkdir(join(dir, 'orgs'), { recursive: true });

  await writeJson(
    join(await folder(dir, 'assets', ids.assetId), 'asset.json'),
    { id: ids.assetId, name: 'Synthetic chamber', audit },
    { name: 'Old asset' },
  );
  await writeJson(
    join(await folder(dir, 'inspections', ids.inspectionId), 'inspection.json'),
    { id: ids.inspectionId, name: 'Synthetic room', asset_id: ids.assetId, audit },
    { name: 'Old name' },
  );

  for (const [i, poi] of ids.poiIds.entries()) {
    await writeJson(
      join(await folder(dir, 'pois', poi), 'poi.json'),
      { id: poi, name: `POI-${i + 1}`, asset_id: ids.assetId, tags: [], audit },
      { name: 'Old POI' },
    );
  }
  // P1 on flight B, P2 twice and P3 on flight A.
  const snaps: [number, number][] = [
    [0, 1],
    [1, 0],
    [1, 0],
    [2, 0],
  ];
  for (const [i, snap] of ids.snapshotIds.entries()) {
    const [poi = 0, flight = 0] = snaps[i] ?? [];
    await writeJson(
      join(await folder(dir, 'snapshots', snap), 'snapshot.json'),
      {
        id: snap,
        flight_id: ids.flightIds[flight],
        poi_id: ids.poiIds[poi],
        criticality: null,
        audit,
      },
      { criticality: 'Low' },
    );
  }

  for (const [fi, fid] of ids.flightIds.entries()) {
    const identifier = `SYNTH_${fi + 1}_flight`;
    const fdir = await folder(dir, 'flights', fid);
    await writeFile(join(fdir, `${identifier}_obcbag.${ext}`), '');
    await writeJson(
      join(fdir, 'flight.json'),
      {
        id: fid,
        name: `Flight #${fi + 1}`,
        identifier,
        inspection_id: ids.inspectionId,
        relocalized: fi === 0,
        transform:
          fi === 1 && withTransform
            ? { v: [0.94, -0.34, 0, 0.4, 0.34, 0.94, 0, -0.3, 0, 0, 1, 0.05, 0, 0, 0, 1] }
            : null,
        location: { latitude: 12.3456789, longitude: 45.6789012, altitude: 321.5 },
        audit,
      },
      { inspection_id: id(99), transform: null, name: 'Old flight' },
    );
    const mid = id(40 + fi);
    const mdir = await folder(dir, 'maps', mid);
    await writeFile(join(mdir, `${identifier}_livemap.las`), '');
    await writeFile(join(mdir, `${identifier}_livetraj.csv`), '');
    await writeJson(
      join(mdir, 'map.json'),
      {
        id: mid,
        parent_type: 'Flight',
        parent_id: fid,
        point_clouds: [{ file_path: `${identifier}_livemap.las` }],
        trajectories: [{ file_path: `${identifier}_livetraj.csv` }],
        audit,
      },
      { parent_type: 'Asset', parent_id: ids.assetId },
    );
  }

  const merged = generation === '2024' ? 'inspection_map1.las' : 'inspection_map2.las';
  const idir = await folder(dir, 'maps', ids.mapIds.inspection);
  await writeFile(join(idir, merged), '');
  await writeJson(
    join(idir, 'map.json'),
    {
      id: ids.mapIds.inspection,
      parent_type: 'Inspection',
      parent_id: ids.inspectionId,
      point_clouds: [{ file_path: merged }],
      trajectories: [],
      audit,
    },
    { parent_type: 'Asset', parent_id: ids.assetId },
  );
  // The Asset relocalisation map: readers ignore it.
  const adir = await folder(dir, 'maps', ids.mapIds.asset);
  await writeFile(join(adir, 'asset_map.las'), '');
  await writeJson(
    join(adir, 'map.json'),
    {
      id: ids.mapIds.asset,
      parent_type: 'Asset',
      parent_id: ids.assetId,
      point_clouds: [{ file_path: 'asset_map.las' }],
      trajectories: [],
      audit,
    },
    { parent_type: 'Inspection', parent_id: ids.inspectionId },
  );
  return ids;
}
