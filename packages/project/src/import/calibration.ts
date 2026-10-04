import type { Layer } from '@aio/schema';

/**
 * Video calibration a re-import keeps (BLD-3, M6 stream A1): a video layer's `orientation` bias
 * and `positionOffsetM` saved in the app live only in `manifest.json`, which an importer writes
 * again from the source. They are read from the previous manifest as plain JSON (the fields are
 * optional on the video layer) and put back on the layer with the same id:
 *
 * - `orientation` unchanged (a camera-frame bias, independent of the logged heights);
 * - `positionOffsetM` minus the change of the logged heights (`deltaY`, new minus old, metres
 *   in the local frame), so the calibrated camera stays where it was. An offset that only
 *   compensated a wrong altitude datum comes out as zero and is dropped (within `dropBelowM`).
 */
export function carryVideoCalibration(
  previous: unknown,
  layers: readonly Layer[],
  deltaY: ReadonlyMap<string, number>,
  dropBelowM = 0.05,
): { layers: Record<string, unknown>[]; notes: string[] } {
  const old = new Map<string, Record<string, unknown>>();
  const prevLayers = isRecord(previous) && Array.isArray(previous.layers) ? previous.layers : [];
  for (const l of prevLayers as unknown[])
    if (isRecord(l) && l.kind === 'video' && typeof l.id === 'string') old.set(l.id, l);
  const notes: string[] = [];
  const out = layers.map((layer) => {
    const l: Record<string, unknown> = { ...layer };
    const o = layer.kind === 'video' ? old.get(layer.id) : undefined;
    if (!o) return l;
    if (isRecord(o.orientation)) {
      l.orientation = o.orientation;
      notes.push(`${layer.id}: orientation bias kept.`);
    }
    const p = o.positionOffsetM;
    if (Array.isArray(p) && p.length === 3 && p.every((v) => typeof v === 'number')) {
      const [x, y, z] = p as [number, number, number];
      const d = deltaY.get(layer.id) ?? 0;
      const next: [number, number, number] = [x, y - d, z].map(
        (v) => Math.round(v * 1000) / 1000,
      ) as [number, number, number];
      const fmt = (v: readonly number[]) => `[${v.map((n) => n.toFixed(2)).join(', ')}]`;
      if (next.every((v) => Math.abs(v) < dropBelowM)) {
        notes.push(
          `${layer.id}: position offset ${fmt([x, y, z])} m dropped; the logged heights moved by ${d.toFixed(2)} m, which it compensated.`,
        );
      } else {
        l.positionOffsetM = next;
        notes.push(
          d === 0
            ? `${layer.id}: position offset ${fmt(next)} m kept.`
            : `${layer.id}: position offset ${fmt([x, y, z])} m rebased to ${fmt(next)} m; the logged heights moved by ${d.toFixed(2)} m.`,
        );
      }
    }
    return l;
  });
  return { layers: out, notes };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
