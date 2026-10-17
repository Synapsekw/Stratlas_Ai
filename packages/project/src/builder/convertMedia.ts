import { photoQuatFromHeading } from '@aio/geo';
import type { Layer, PanoRef, PhotoRef, ProjectManifest } from '@aio/schema';
import { captureForDate, uniqueId } from './create';

export type ConvertMediaError = 'stitched' | 'missing' | 'kind';

export interface ConvertMediaRequest {
  layerId: string;
  itemId: string;
  to: 'pano' | 'photo';
}

export type ConvertMediaResult =
  { manifest: ProjectManifest; layerId: string; itemId: string } | { error: ConvertMediaError };

type PhotoLayer = Extract<Layer, { kind: 'photos' }>;
type PanoLayer = Extract<Layer, { kind: 'panoramas' }>;

const DAY = /^\d{4}-\d{2}-\d{2}/;

/**
 * Move one ready-made image between a photos layer and a panoramas layer of its date, keeping its
 * file (`src` is unchanged). The date is the item's own time, else the source layer's capture; the
 * target layer is the one on that capture, `panos-<date>` / `photos-<date>` when missing. Ids are
 * kept unless taken, `pos`, `pin` and the time carry over, a photo's `lens` and `q` do not, and a
 * source layer left empty is removed. A stitched 360 (`stitch` or `cov`) is not a photo. Pure.
 */
export function convertMediaManifest(
  m: ProjectManifest,
  req: ConvertMediaRequest,
): ConvertMediaResult {
  const source = m.layers.find((l) => l.id === req.layerId);
  if (!source) return { error: 'missing' };
  if (source.kind !== (req.to === 'pano' ? 'photos' : 'panoramas')) return { error: 'kind' };
  const item = (source.items as (PhotoRef | PanoRef)[]).find((i) => i.id === req.itemId);
  if (!item) return { error: 'missing' };

  let time: string | undefined;
  if (source.kind === 'photos') time = (item as PhotoRef).takenAt;
  else {
    const p = item as PanoRef;
    if (p.stitch || p.cov) return { error: 'stitched' };
    time = p.capturedAt;
  }

  // the survey date: the item's own day, else the date of the source layer's capture
  const day = time !== undefined ? DAY.exec(time)?.[0] : undefined;
  let next = m;
  let captureId = source.capture;
  let date = day ?? m.captures.find((c) => c.id === source.capture)?.date;
  if (day !== undefined) {
    const c = captureForDate(m, day);
    next = c.manifest;
    captureId = c.captureId;
  }
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = undefined;

  const kind = req.to === 'pano' ? 'panoramas' : 'photos';
  const base = req.to === 'pano' ? 'panos' : 'photos';
  const name = req.to === 'pano' ? 'Panoramas' : 'Photos';
  const existing = next.layers.find(
    (l) => l.kind === kind && l.id !== source.id && (l.capture ?? undefined) === captureId,
  );
  const targetId =
    existing?.id ??
    uniqueId(date !== undefined ? `${base}-${date}` : base, (x) =>
      next.layers.some((l) => l.id === x),
    );
  const taken = (id: string) =>
    existing !== undefined &&
    (existing as { items: { id: string }[] }).items.some((i) => i.id === id);
  const itemId = uniqueId(item.id, taken);

  const moved: PhotoRef | PanoRef =
    req.to === 'pano'
      ? {
          id: itemId,
          src: item.src,
          ...(item.pos ? { pos: item.pos } : {}),
          ...(item.pin ? { pin: item.pin } : {}),
          ...(time !== undefined ? { capturedAt: time } : {}),
          headingDeg: 0,
        }
      : {
          id: itemId,
          src: item.src,
          ...(time !== undefined ? { takenAt: time } : {}),
          ...(item.pos ? { pos: item.pos } : {}),
          // keep the aim as a level camera, so the photo still has a frustum
          ...('headingDeg' in item && item.pos
            ? { q: photoQuatFromHeading(((item.headingDeg % 360) + 360) % 360) }
            : {}),
          ...(item.pin ? { pin: item.pin } : {}),
        };

  const layers: Layer[] = [];
  for (const l of next.layers) {
    if (l.id === source.id && (l.kind === 'photos' || l.kind === 'panoramas')) {
      const rest = (l.items as { id: string }[]).filter((i) => i.id !== req.itemId);
      if (rest.length === 0) continue;
      layers.push({ ...l, items: rest } as Layer);
    } else if (l.id === targetId && existing !== undefined) {
      layers.push({ ...l, items: [...(l as { items: unknown[] }).items, moved] } as Layer);
    } else layers.push(l);
  }
  if (existing === undefined) {
    const created = {
      kind,
      id: targetId,
      name: date !== undefined ? `${name}, ${date}` : name,
      visible: true,
      ...(captureId !== undefined ? { capture: captureId } : {}),
      items: [moved],
    } as PhotoLayer | PanoLayer;
    layers.push(created);
  }
  return { manifest: { ...next, layers }, layerId: targetId, itemId };
}
