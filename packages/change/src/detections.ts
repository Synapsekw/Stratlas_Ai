import type {
  ChangeItem,
  Detection,
  DetectionsFile,
  Layer,
  ProjectManifest,
  Vec3,
} from '@aio/schema';
import { groundPoint } from '@aio/video/ground';
import type { DateIndex } from './pairs';

/**
 * Detection change between two dates (FUS-12): accepted detections counted per class and zone on
 * each date, dates from the photos layer (or video layer) the pass looked at. The zone is the
 * detection's `component`; else, when `locate` can place it (a posed photo: the box centre's ray
 * on the ground plane), the place on the ground it shows, joined across both dates within
 * `PLACE_RADIUS_M` (method `place`), so the same thing seen from several photos counts once per
 * photo in one item; else the whole site (method `zone`).
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
  /** Where on the ground (local frame) a detection lies, or null when it cannot be placed. */
  locate?: (d: Detection, layer: string) => Vec3 | null;
}

type PhotoItem = Extract<Layer, { kind: 'photos' }>['items'][number];

/**
 * A `locate` for `detectionChanges`: the ray through a photo detection's box centre from the
 * photo's pose, on the ground plane `y = 0` (the project origin height). Boxes in photo file
 * pixels (`preview`, the default) need the photo's size, read once per photo through `size`;
 * `normalized` boxes do not. Detections on unposed photos, video frames and other pixel spaces
 * are not placed.
 */
export async function photoDetectionLocator(
  manifest: Pick<ProjectManifest, 'layers'>,
  passes: readonly DetectionPass[],
  size: (layer: string, photo: PhotoItem) => Promise<readonly [number, number] | null>,
): Promise<(d: Detection, layer: string) => Vec3 | null> {
  const photos = new Map<string, PhotoItem>();
  for (const l of manifest.layers)
    if (l.kind === 'photos') for (const p of l.items) photos.set(`${l.id}/${p.id}`, p);
  const sizes = new Map<string, readonly [number, number] | null>();
  for (const { file } of passes)
    for (const d of file.detections) {
      const layer =
        file.layer ??
        manifest.layers.find((l) => l.kind === 'photos' && l.items.some((p) => p.id === d.photo))
          ?.id;
      const key = `${layer ?? ''}/${d.photo ?? ''}`;
      const item = photos.get(key);
      if (!layer || !item || sizes.has(key) || (d.space ?? 'preview') !== 'preview') continue;
      sizes.set(key, await size(layer, item).catch(() => null));
    }
  return (d, layer) => {
    const item = d.photo ? photos.get(`${layer}/${d.photo}`) : undefined;
    if (!item?.pos || !item.q || !item.lens || d.frame) return null;
    const space = d.space ?? 'preview';
    const wh: readonly [number, number] | null | undefined =
      space === 'normalized'
        ? [1, 1]
        : space === 'preview'
          ? sizes.get(`${layer}/${item.id}`)
          : null;
    if (!wh) return null;
    const [x0, y0, x1, y1] = d.bbox;
    return groundPoint(
      { pos: item.pos, q: item.q, lens: item.lens },
      (x0 + x1) / 2 / wh[0],
      (y0 + y1) / 2 / wh[1],
    );
  };
}

/** Detections closer than this on the ground (metres, x and z) show the same place. */
export const PLACE_RADIUS_M = 3;

interface Place {
  sum: [number, number, number];
  n: number;
}

const centre = (p: Place): Vec3 => [p.sum[0] / p.n, p.sum[1] / p.n, p.sum[2] / p.n];

/** "place at x 21 m, z -2 m": stable for the same detections. */
const placeName = (p: Place) => {
  const [x, , z] = centre(p);
  return `place at x ${String(Math.round(x))} m, z ${String(Math.round(z))} m`;
};

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
  place?: Place;
}

/** Detection change items of a date pair, by class then zone. */
export function detectionChanges(input: DetectionChangeInput): DetectionItem[] {
  const { index, from, to } = input;
  const photoLayer = photoLayers(input.manifest.layers);
  /** By class and zone, or by place (one place object per item). */
  const buckets = new Map<string | Place, Bucket>();
  /** Places on the ground per class, joined across both dates. */
  const places = new Map<string, Place[]>();
  const placeFor = (classId: string, p: Vec3): Place => {
    const list = places.get(classId) ?? [];
    places.set(classId, list);
    const near = list
      .map((q) => ({ q, d: Math.hypot(centre(q)[0] - p[0], centre(q)[2] - p[2]) }))
      .filter((x) => x.d <= PLACE_RADIUS_M)
      .sort((a, b) => a.d - b.d)[0]?.q;
    const place = near ?? { sum: [0, 0, 0], n: 0 };
    if (!near) list.push(place);
    place.sum = [place.sum[0] + p[0], place.sum[1] + p[1], place.sum[2] + p[2]];
    place.n += 1;
    return place;
  };
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
      const at = !d.component && layer && input.locate ? input.locate(d, layer) : null;
      const place = at ? placeFor(d.class, at) : undefined;
      const zone = d.component ?? SITE_ZONE;
      const key = place ?? `${d.class}\u0000${zone}`;
      const b = buckets.get(key) ?? {
        classId: d.class,
        zone,
        from: [],
        to: [],
        ...(place ? { place } : {}),
      };
      (date === from ? b.from : b.to).push(`${name}#${d.id ?? String(i)}`);
      buckets.set(key, b);
    });
    // a pass names its photos layer: that date looked even when nothing was found
    const date = file.layer ? index.of[file.layer] : undefined;
    if (date) looked.add(date);
  }
  // a place is named once every detection joined it
  for (const b of buckets.values()) if (b.place) b.zone = placeName(b.place);
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
      method: b.place ? 'place' : 'zone',
      ...(b.place ? { at: centre(b.place).map((v) => Math.round(v * 100) / 100) as Vec3 } : {}),
      ...(b.from.length ? { fromIds: b.from } : {}),
      ...(b.to.length ? { toIds: b.to } : {}),
    };
  });
}
