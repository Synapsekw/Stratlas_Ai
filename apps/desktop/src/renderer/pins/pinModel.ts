import { eyePos } from '@aio/geo';
import type { PanoRef, PhotoRef, ProjectManifest, Vec3 } from '@aio/schema';
import type { MediaPick } from '@aio/ui';
import { toDraw } from './pinFrame';

/* Pinned media as the views draw it: the key of a photo or 360, its item in the manifest, and the
 * pins of the shown layers in the drawn frame. */

/** One photo or 360 (keyed so ground video can join later). */
export type MediaKey = MediaPick;

export function keyString(k: MediaKey): string {
  return `${k.kind}:${k.layerId}:${k.itemId}`;
}

/** The photo or 360 `k` names, or null when its layer or item is gone (or of the other kind). */
export function mediaItem(m: ProjectManifest, k: MediaKey): PhotoRef | PanoRef | null {
  const want = k.kind === 'photo' ? 'photos' : 'panoramas';
  for (const l of m.layers) {
    if (l.id !== k.layerId) continue;
    if (l.kind !== want) return null;
    if (l.kind === 'photos') return l.items.find((i) => i.id === k.itemId) ?? null;
    return l.items.find((i) => i.id === k.itemId) ?? null;
  }
  return null;
}

/** Whether the item has a place on the site (GPS or a pin). */
export function isPlaced(item: PhotoRef | PanoRef): boolean {
  return item.pos !== undefined;
}

export interface DrawnPin {
  key: MediaKey;
  name: string;
  /** The clicked ground point, drawn frame. */
  ground: Vec3;
  /** `ground` lifted by the eye height, drawn frame. */
  eye: Vec3;
  /** The pinned heading; undefined until the pin was aimed or lined up. */
  headingDeg: number | undefined;
  linedUp: boolean;
}

const fileName = (item: PhotoRef | PanoRef): string => {
  const path = 'path' in item.src ? item.src.path : '';
  const base = path.split(/[\\/]/).pop() ?? '';
  return base === '' ? item.id : base;
};

/** The pins of visible photos and panoramas layers not in `hidden`, in the drawn frame. */
export function drawnPins(m: ProjectManifest, hidden: ReadonlySet<string>): DrawnPin[] {
  const out: DrawnPin[] = [];
  for (const l of m.layers) {
    if (!l.visible || hidden.has(l.id)) continue;
    if (l.kind !== 'photos' && l.kind !== 'panoramas') continue;
    const kind = l.kind === 'photos' ? 'photo' : 'pano';
    const items: readonly (PhotoRef | PanoRef)[] = l.items;
    for (const item of items) {
      const pin = item.pin;
      if (!pin) continue;
      const ground = toDraw(pin.ground, m, l.id);
      const name = 'name' in item && item.name ? item.name : fileName(item);
      out.push({
        key: { kind, layerId: l.id, itemId: item.id },
        name,
        ground,
        eye: eyePos(ground, pin.eyeM),
        headingDeg: pin.headingDeg,
        linedUp: pin.headingDeg !== undefined,
      });
    }
  }
  return out;
}

/** The pin nearest to screen point `(x, y)` within `radiusPx` (14 px), or null. */
export function pinsAt(
  points: readonly { key: MediaKey; x: number; y: number }[],
  x: number,
  y: number,
  radiusPx = 14,
): MediaKey | null {
  let best: MediaKey | null = null;
  let bestD = radiusPx;
  for (const p of points) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= bestD) {
      best = p.key;
      bestD = d;
    }
  }
  return best;
}
