import type { Issue, Sighting } from '@aio/schema';

/**
 * Findings placed on a model (plan 2026-10-15-findings-on-model). A 3D sighting that was
 * projected from one of the issue's image or video sightings names it in `from` (its index):
 * the automatic crossview pin (a mesh `spoint`) and the placed areas (a mesh `spolygon`, a cloud
 * `polygon3` and its `selection`). Indices move when sightings are removed, moved or merged;
 * these helpers keep every `from` naming the same sighting. Pure.
 */

interface From {
  sighting: number;
}

const fromOf = (s: Sighting): From | undefined =>
  s.on === 'mesh' || s.on === 'pointcloud' ? s.from : undefined;

function withFrom(s: Sighting, from: From | null): Sighting {
  if (s.on !== 'mesh' && s.on !== 'pointcloud') return s;
  if (from) return { ...s, from };
  const copy = { ...s };
  delete copy.from;
  return copy;
}

/** The pin the deriver back-projected from a photo or frame shape. */
export function isAutoPin(s: Sighting): boolean {
  return s.on === 'mesh' && s.geom.type === 'spoint' && s.from !== undefined;
}

/** An area placed on a model from a photo or frame shape (outline, prism or its selection). */
export function isPlacedArea(s: Sighting): boolean {
  if (s.on === 'mesh') return s.from !== undefined && s.geom.type === 'spolygon';
  if (s.on === 'pointcloud')
    return s.from !== undefined && (s.geom.type === 'polygon3' || s.geom.type === 'selection');
  return false;
}

export function hasPlacedArea(issue: Pick<Issue, 'sightings'>): boolean {
  return issue.sightings.some(isPlacedArea);
}

/** The image or video sighting the first placed area came from; null when none (or stale). */
export function placedFrom(issue: Pick<Issue, 'sightings'>): number | null {
  for (const s of issue.sightings) {
    if (!isPlacedArea(s)) continue;
    const at = fromOf(s)?.sighting;
    const src = at === undefined ? undefined : issue.sightings[at];
    if (at !== undefined && (src?.on === 'image' || src?.on === 'video')) return at;
  }
  return null;
}

/**
 * The sightings `keep` says yes to, with every `from` pointing at the same sighting in the new
 * order; a `from` whose sighting went is dropped.
 */
export function keepSightings(
  sightings: readonly Sighting[],
  keep: (s: Sighting, i: number) => boolean,
): Sighting[] {
  const moved = new Map<number, number>();
  const kept: Sighting[] = [];
  sightings.forEach((s, i) => {
    if (!keep(s, i)) return;
    moved.set(i, kept.length);
    kept.push(s);
  });
  return kept.map((s) => {
    const f = fromOf(s);
    if (!f) return s;
    const to = moved.get(f.sighting);
    return withFrom(s, to === undefined ? null : { sighting: to });
  });
}

/** Sightings placed after `offset` others (a merge): their `from` moves with them. */
export function shiftFrom(sightings: readonly Sighting[], offset: number): Sighting[] {
  return sightings.map((s) => {
    const f = fromOf(s);
    return f ? withFrom(s, { sighting: f.sighting + offset }) : s;
  });
}

/** A sighting leaving its issue (linked to another): its `from` no longer means anything. */
export function dropFrom(s: Sighting): Sighting {
  return withFrom(s, null);
}

/**
 * The issue with `added` placed on `layer`: that layer's automatic pin and any earlier placed
 * area go (placing again replaces), `added` joins at the end. The `from` of `added` counts in
 * the issue as it was; every `from` still names the same sighting afterwards.
 */
export function withPlacedArea(
  issue: Issue,
  layer: string,
  added: readonly Sighting[],
  now: string,
): Issue {
  const n = issue.sightings.length;
  const sightings = keepSightings(
    [...issue.sightings, ...added],
    (s, i) => i >= n || s.layer !== layer || !(isAutoPin(s) || isPlacedArea(s)),
  );
  return { ...issue, sightings, updatedAt: now };
}
