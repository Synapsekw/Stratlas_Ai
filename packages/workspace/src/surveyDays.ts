import type { Layer, ProjectManifest } from '@aio/schema';
import type { CaptureIndex } from './captures';

/**
 * The days layers were recorded on, for filing a project's undated datasets under survey dates.
 * Generic: nothing here knows a project.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The most frequent day; a tie goes to the earlier day. Null for none. */
function majority(days: readonly string[]): string | null {
  const count = new Map<string, number>();
  for (const d of days) count.set(d, (count.get(d) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [d, c] of count) {
    if (c > n || (c === n && best !== null && d < best)) {
      best = d;
      n = c;
    }
  }
  return best;
}

/** The days a photos layer's dated items were taken on, one entry per item. */
function photoDays(layer: Extract<Layer, { kind: 'photos' }>): string[] {
  return layer.items
    .map((i) => i.takenAt?.slice(0, 10))
    .filter((d): d is string => d !== undefined && DAY.test(d));
}

/** The local day a layer was recorded on: photos by most items' `takenAt`, video by flight start. */
export function recordingDay(layer: Layer, utcOffsetMin: number): string | null {
  if (layer.kind === 'photos') return majority(photoDays(layer));
  if (layer.kind === 'video') {
    const ms = layer.flight.startUtcMs + utcOffsetMin * 60_000;
    if (!Number.isFinite(ms)) return null;
    const day = new Date(ms).toISOString().slice(0, 10);
    return DAY.test(day) ? day : null;
  }
  return null;
}

export interface FilingGroup {
  day: string; // YYYY-MM-DD
  captureId: string | null; // existing date of that day, null when it must be added
  layerIds: string[];
}

export interface FilingPlan {
  groups: FilingGroup[];
  /** Layers in Every date that hold photos from several days: left out, to be moved by hand. */
  mixed: string[];
}

/**
 * Layers in Every date that carry a recording day, grouped by day, oldest day first. A photos
 * layer whose items were taken on more than one day is never filed under one of them: it goes to
 * `mixed`. A video layer is one flight with one start, so it always has a single day.
 */
export function planFiling(
  manifest: Pick<ProjectManifest, 'captures' | 'layers'>,
  index: CaptureIndex,
  utcOffsetMin: number,
): FilingPlan {
  const groups = new Map<string, string[]>();
  const mixed: string[] = [];
  for (const l of manifest.layers) {
    if (index.of[l.id] !== undefined) continue;
    if (l.kind !== 'photos' && l.kind !== 'video') continue;
    if (l.kind === 'photos' && new Set(photoDays(l)).size > 1) {
      mixed.push(l.id);
      continue;
    }
    const day = recordingDay(l, utcOffsetMin);
    if (day === null) continue;
    groups.set(day, [...(groups.get(day) ?? []), l.id]);
  }
  return {
    groups: [...groups.keys()].sort().map((day) => ({
      day,
      captureId: manifest.captures.find((c) => c.date === day)?.id ?? null,
      layerIds: groups.get(day) ?? [],
    })),
    mixed,
  };
}
