/** COPC files through copc.js: header, hierarchy pages and node point data by byte range. */
import { Copc, Hierarchy } from 'copc';
import {
  decodeLasRecords,
  decompressChunk,
  type DecodedCopcNode,
  type LasLayout,
  type LazPerfLike,
} from './copcDecode';

type V3 = readonly [number, number, number];

/** Reads bytes [begin, end) of the file. */
export type Getter = (begin: number, end: number) => Promise<Uint8Array>;

export interface CopcPage {
  pageOffset: number;
  pageLength: number;
}

export interface CopcNodeInfo {
  pointCount: number;
  pointDataOffset: number;
  pointDataLength: number;
}

export interface CopcSource {
  layout: LasLayout;
  /** Octree cube in the file CRS (x east, y north, z up). */
  cube: { min: [number, number, number]; max: [number, number, number] };
  /** Point spacing of the root node, CRS units. */
  spacing: number;
  pointCount: number;
  /** Horizontal EPSG code read from the WKT, when it carries one. */
  epsg?: number;
  rootPage: CopcPage;
}

export interface CopcHierarchy {
  nodes: Record<string, CopcNodeInfo | undefined>;
  pages: Record<string, CopcPage | undefined>;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

/** A Getter over HTTP Range requests (the aio:// protocol answers 206 with Content-Range). */
export function rangeGetter(url: string, fetchFn: FetchLike = (u, i) => fetch(u, i)): Getter {
  return async (begin, end) => {
    if (begin < 0 || end < begin) throw new Error(`Invalid byte range ${begin}..${end}`);
    if (end === begin) return new Uint8Array(0);
    const r = await fetchFn(url, { headers: { Range: `bytes=${begin}-${end - 1}` } });
    if (!r.ok) throw new Error(`Could not read ${url} (${r.status})`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    // a server that ignores Range answers the whole file with 200
    return r.status === 206 ? bytes : bytes.slice(begin, end);
  };
}

/** The horizontal EPSG code of a WKT (the last AUTHORITY of its PROJCS or GEOGCS). */
export function epsgFromWkt(wkt: string | undefined): number | undefined {
  if (!wkt) return undefined;
  const horiz =
    /PROJCS\[(?:[^[\]]|\[(?:[^[\]]|\[(?:[^[\]]|\[[^[\]]*\])*\])*\])*\]/.exec(wkt)?.[0] ?? wkt;
  const all = [...horiz.matchAll(/AUTHORITY\["EPSG",\s*"(\d+)"\]/g)];
  const last = all[all.length - 1]?.[1];
  return last ? Number(last) : undefined;
}

export async function readCopcSource(get: Getter): Promise<CopcSource> {
  const c = await Copc.create(get);
  const [x0, y0, z0, x1, y1, z1] = c.info.cube;
  const src: CopcSource = {
    layout: {
      pointDataRecordFormat: c.header.pointDataRecordFormat,
      pointDataRecordLength: c.header.pointDataRecordLength,
      scale: c.header.scale,
      offset: c.header.offset,
    },
    cube: { min: [x0, y0, z0], max: [x1, y1, z1] },
    spacing: c.info.spacing,
    pointCount: c.header.pointCount,
    rootPage: c.info.rootHierarchyPage,
  };
  const epsg = epsgFromWkt(c.wkt);
  if (epsg !== undefined) src.epsg = epsg;
  return src;
}

export async function readCopcPage(get: Getter, page: CopcPage): Promise<CopcHierarchy> {
  const sub = await Hierarchy.load(get, page);
  return { nodes: sub.nodes, pages: sub.pages };
}

/** Fetch, decompress and decode one node into the local frame (see decodeLasRecords). */
export async function loadCopcNode(
  get: Getter,
  node: CopcNodeInfo,
  layout: LasLayout,
  laz: LazPerfLike,
  origin: V3,
  box: { min: V3; max: V3 },
): Promise<DecodedCopcNode> {
  const compressed = await get(node.pointDataOffset, node.pointDataOffset + node.pointDataLength);
  const records = decompressChunk(compressed, layout, node.pointCount, laz);
  return decodeLasRecords(records, layout, node.pointCount, origin, box);
}
