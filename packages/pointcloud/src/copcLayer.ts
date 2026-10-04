import type { CopcHierarchy, CopcSource } from './copc';
import type { ChunkSeed } from './manager';
import { childKeys, nodeBounds, parseKey } from './octree';

type V3 = readonly [number, number, number];

/**
 * Chunks for the nodes of one COPC hierarchy page. Keys are `<layer>#<D-X-Y-Z>`; nodes whose own
 * entry lives in a page not loaded yet become placeholders (`page` set, no points).
 */
export function copcChunkSeeds(
  layerId: string,
  url: string,
  src: CopcSource,
  hier: CopcHierarchy,
  origin: V3,
): ChunkSeed[] {
  const known = new Set([...Object.keys(hier.nodes), ...Object.keys(hier.pages)]);
  const seeds: ChunkSeed[] = [];
  const make = (key: string): Omit<ChunkSeed, 'source' | 'points'> => {
    const [d] = parseKey(key);
    const box = nodeBounds(key, src.cube, origin);
    return {
      key: `${layerId}#${key}`,
      bounds: box,
      lod: d,
      spacing: src.spacing / 2 ** d,
      children: childKeys(key)
        .filter((k) => known.has(k))
        .map((k) => `${layerId}#${k}`),
    };
  };
  for (const [key, node] of Object.entries(hier.nodes)) {
    if (!node) continue;
    const base = make(key);
    seeds.push({
      ...base,
      points: node.pointCount,
      source: { kind: 'copc', url, node, layout: src.layout, origin, box: base.bounds },
    });
  }
  for (const [key, page] of Object.entries(hier.pages)) {
    if (!page || hier.nodes[key]) continue;
    const base = make(key);
    seeds.push({
      ...base,
      children: [],
      points: 0,
      page,
      source: {
        kind: 'copc',
        url,
        node: { pointCount: 0, pointDataOffset: 0, pointDataLength: 0 },
        layout: src.layout,
        origin,
        box: base.bounds,
      },
    });
  }
  return seeds;
}
