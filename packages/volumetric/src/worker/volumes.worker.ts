/** Volume worker: decodes the kit grids and computes volumes, bodies, sections and rasters. */
import type { PortLike } from './protocol';
import { serveVolumes } from './serve';

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${String(r.status)} ${r.statusText}`);
  return r.text();
}

serveVolumes(self as unknown as PortLike, fetchText);
