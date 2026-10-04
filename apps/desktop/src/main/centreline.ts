import type { IpcRequest, IpcResponse } from '@aio/schema';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './fsutil';

/** Where a centreline drawn on the map is kept, relative to the project folder. */
export const DRAWN_CENTRELINE = 'road/centreline-drawn.geojson';

/**
 * Save a road centreline drawn on the map (lon/lat) as a GeoJSON LineString the road builder
 * (`road.build`) reads; atomic, with a `.bak` of the previous drawing.
 */
export async function writeCentreline(
  root: string,
  coordinates: IpcRequest<'project:writeCentreline'>['coordinates'],
): Promise<IpcResponse<'project:writeCentreline'>> {
  const distinct = coordinates.filter(
    (c, i) => i === 0 || c[0] !== coordinates[i - 1]?.[0] || c[1] !== coordinates[i - 1]?.[1],
  );
  if (distinct.length < 2)
    return { ok: false, error: 'A centreline needs at least two different points.' };
  const doc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: distinct },
        properties: { kind: 'centreline', source: 'drawn' },
      },
    ],
  };
  const file = join(root, ...DRAWN_CENTRELINE.split('/'));
  try {
    await mkdir(join(root, 'road'), { recursive: true });
    await writeJsonAtomic(file, doc, { backup: true });
  } catch (e) {
    return { ok: false, error: `Could not save ${file}: ${String(e)}` };
  }
  return { ok: true, path: DRAWN_CENTRELINE };
}
