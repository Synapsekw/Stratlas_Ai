import type { ChangeItem, DetectionsFile, Layer, ProjectManifest } from '@aio/schema';
import type { DateIndex } from './pairs';

/**
 * Detection change between two dates (FUS-12): accepted detections counted per class and zone
 * (the detection's `component`, else the whole site) on each date, dates from the photos layer
 * (or video layer) the pass looked at. Photo-pose pairing of single detections comes with C4's
 * `pairsFor`; until then the method is `zone`.
 */

type DetectionItem = Extract<ChangeItem, { kind: 'detection' }>;

export interface DetectionPass {
  name: string;
  file: DetectionsFile;
}

export interface DetectionChangeInput {
  manifest: Pick<ProjectManifest, 'layers'>;
  index: Pick<DateIndex, 'of'>;
  passes: readonly DetectionPass[];
  from: string;
  to: string;
}

/** Zone label of detections with no component. */
export const SITE_ZONE = 'site';

function photoLayers(layers: readonly Layer[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of layers)
    if (l.kind === 'photos') for (const p of l.items) if (!out.has(p.id)) out.set(p.id, l.id);
  return out;
}

interface Bucket {
  classId: string;
  zone: string;
  from: string[];
  to: string[];
}

/** Detection change items of a date pair, by class then zone. */
export function detectionChanges(input: DetectionChangeInput): DetectionItem[] {
  const { index, from, to } = input;
  const photoLayer = photoLayers(input.manifest.layers);
  const buckets = new Map<string, Bucket>();
  /** Dates a pass of each date looked at (a pass with no detections still looked). */
  const looked = new Set<string>();
  for (const { name, file } of input.passes) {
    file.detections.forEach((d, i) => {
      const layer = d.frame?.layer ?? file.layer ?? (d.photo ? photoLayer.get(d.photo) : undefined);
      const date = layer ? index.of[layer] : undefined;
      if (date) looked.add(date);
      if (date !== from && date !== to) return;
      const status = d.status ?? 'accepted';
      if (status !== 'accepted') return;
      const zone = d.component ?? SITE_ZONE;
      const key = `${d.class}\u0000${zone}`;
      const b = buckets.get(key) ?? { classId: d.class, zone, from: [], to: [] };
      (date === from ? b.from : b.to).push(`${name}#${d.id ?? String(i)}`);
      buckets.set(key, b);
    });
    // a pass names its photos layer: that date looked even when nothing was found
    const date = file.layer ? index.of[file.layer] : undefined;
    if (date) looked.add(date);
  }
  const sorted = [...buckets.values()].sort((a, b) =>
    a.classId === b.classId ? a.zone.localeCompare(b.zone) : a.classId.localeCompare(b.classId),
  );
  return sorted.map((b) => {
    const nf = b.from.length;
    const nt = b.to.length;
    const verdict: DetectionItem['verdict'] =
      nf === 0
        ? 'new'
        : nt === 0
          ? looked.has(to)
            ? 'resolved'
            : 'not-seen'
          : nt > nf
            ? 'grown'
            : nt < nf
              ? 'shrunk'
              : 'unchanged';
    return {
      kind: 'detection',
      id: `detection:${b.classId}:${b.zone}`,
      verdict,
      label: `${b.classId} in ${b.zone}: ${String(nf)} to ${String(nt)}`,
      classId: b.classId,
      zone: b.zone,
      count: { from: nf, to: nt },
      method: 'zone',
      ...(b.from.length ? { fromIds: b.from } : {}),
      ...(b.to.length ? { toIds: b.to } : {}),
    };
  });
}
