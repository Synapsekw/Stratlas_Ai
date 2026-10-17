import { eyePos, photoQuatFromHeading } from '@aio/geo';
import type { Layer, MediaPinInput, PanoRef, PhotoRef, Quat, Vec3 } from '@aio/schema';

interface Gps {
  pos: Vec3;
  q?: Quat | undefined;
}

/** The pin a patch carries: `gps` is the writer's to set, never the caller's. */
export interface MediaPinPatch {
  itemId: string;
  pin: MediaPinInput | null;
}

function copyGps(g: Gps): Gps {
  return { pos: [...g.pos], ...(g.q ? { q: [...g.q] as Quat } : {}) };
}

/** The GPS place an item has before this write: kept from an earlier pin, else its own place. */
function gpsBefore(item: PhotoRef | PanoRef): Gps | undefined {
  if (item.pin) return item.pin.gps ? copyGps(item.pin.gps) : undefined;
  if (!item.pos) return undefined;
  const q = 'q' in item ? item.q : undefined;
  return copyGps({ pos: item.pos, q });
}

function pinRecord(pin: MediaPinInput, gps: Gps | undefined): NonNullable<PhotoRef['pin']> {
  return {
    ground: [...pin.ground],
    eyeM: pin.eyeM ?? 1.6,
    ...(pin.headingDeg !== undefined ? { headingDeg: pin.headingDeg } : {}),
    ...(gps ? { gps } : {}),
  };
}

function pinPhoto(p: PhotoRef, pin: MediaPinInput): PhotoRef {
  const gps = gpsBefore(p);
  const next: PhotoRef = { ...p, pos: eyePos(pin.ground, pin.eyeM ?? 1.6) };
  // a heading gives a level camera; without one the photo keeps the GPS aim it had, if any
  if (pin.headingDeg !== undefined) next.q = photoQuatFromHeading(pin.headingDeg);
  else if (gps?.q) next.q = [...gps.q] as Quat;
  else delete next.q;
  next.pin = pinRecord(pin, gps);
  return next;
}

function pinPano(p: PanoRef, pin: MediaPinInput): PanoRef {
  return {
    ...p,
    pos: eyePos(pin.ground, pin.eyeM ?? 1.6),
    // no heading in the pin: the stored heading stays
    ...(pin.headingDeg !== undefined ? { headingDeg: pin.headingDeg } : {}),
    pin: pinRecord(pin, gpsBefore(p)),
  };
}

function unpin<T extends PhotoRef | PanoRef>(item: T): T {
  if (!item.pin) return item;
  const next = { ...item };
  const gps = item.pin.gps;
  delete next.pin;
  if (gps) next.pos = [...gps.pos];
  else delete next.pos;
  // a photo's aim goes with its place; a 360 keeps its heading
  if ('q' in next) {
    if (gps?.q) next.q = [...gps.q] as Quat;
    else delete next.q;
  }
  return next;
}

/**
 * Pin one photo or 360 on the site (`pin`), or take its pin off (`null`). A pin writes `pos`
 * (ground plus eye height), a photo's `q` or a 360's `headingDeg`, and keeps the GPS place it
 * replaced in `pin.gps`; removing it puts that place back, or leaves the item unplaced.
 */
export function applyMediaPin(layer: Layer, patch: MediaPinPatch): Layer {
  if (layer.kind !== 'photos' && layer.kind !== 'panoramas')
    throw new Error(`"${layer.name}" is not photos or panoramas; only those can be pinned.`);
  if (!layer.items.some((i) => i.id === patch.itemId))
    throw new Error(`"${patch.itemId}" is not in "${layer.name}".`);
  if (layer.kind === 'photos') {
    return {
      ...layer,
      items: layer.items.map((i) =>
        i.id !== patch.itemId ? i : patch.pin ? pinPhoto(i, patch.pin) : unpin(i),
      ),
    };
  }
  return {
    ...layer,
    items: layer.items.map((i) =>
      i.id !== patch.itemId ? i : patch.pin ? pinPano(i, patch.pin) : unpin(i),
    ),
  };
}
