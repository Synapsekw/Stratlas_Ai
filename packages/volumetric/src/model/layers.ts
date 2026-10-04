import type { Layer, VolumeCapture } from '@aio/schema';

export interface SurveyLayers {
  /** Mesh layer that holds the pile nodes of the survey. */
  terrain: string | null;
  /** Every layer that shows the survey (terrain, ortho). */
  layers: string[];
}

/**
 * The manifest layers of each survey (data-conventions section 10): from `captures[].layers`,
 * else the mesh whose tags name `<pile>_<epoch>` nodes and the rasters whose id or name holds
 * the survey date or label.
 */
export function surveyLayers(
  layers: readonly Layer[],
  captures: readonly VolumeCapture[],
): Record<string, SurveyLayers> {
  const out: Record<string, SurveyLayers> = {};
  for (const c of captures) {
    const suffix = `_${c.epoch}`;
    const isTerrain = (l: Layer) =>
      l.kind === 'mesh' && (l.tags ?? []).some((t) => t.node.endsWith(suffix));
    if (c.layers) {
      const named = layers.filter((l) => c.layers?.includes(l.id));
      out[c.epoch] = { terrain: named.find(isTerrain)?.id ?? null, layers: named.map((l) => l.id) };
      continue;
    }
    const terrain = layers.find(isTerrain)?.id ?? null;
    const rasters = layers
      .filter(
        (l) =>
          l.kind === 'raster' &&
          [l.id, l.name].some((s) => s.includes(c.date) || s.includes(c.label)),
      )
      .map((l) => l.id);
    out[c.epoch] = { terrain, layers: [...(terrain ? [terrain] : []), ...rasters] };
  }
  return out;
}

/** GLB node of a pile on a survey: `volumes.json` `node`, else the importer's `<pile>_<epoch>`. */
export function pileNode(
  pile: string,
  epoch: string,
  ep: { node?: string | undefined } | undefined,
): string {
  return ep?.node ?? `${pile}_${epoch}`;
}
