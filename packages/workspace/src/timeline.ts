import type { Layer, ProjectManifest } from '@aio/schema';
import { captureIndex, counterpart, type CaptureIndex } from './captures';

/** Saved per project: the focused survey date and how each date was left. */
export interface DatePref {
  focus?: string;
  /** Per survey date, the layers hidden when that date was last focused. */
  remembered?: Record<string, string[]>;
  /** Visible layers of dates other than the focused one. */
  extras?: string[];
}

export interface VisibilityChange {
  show: string[];
  hide: string[];
}

type Hidden = Readonly<Record<string, true>>;

function known(index: CaptureIndex, id: string | null | undefined): id is string {
  return !!id && index.captures.some((c) => c.id === id);
}

export function initialFocus(index: CaptureIndex, saved: string | undefined): string | null {
  if (known(index, saved)) return saved;
  return index.captures.at(-1)?.id ?? null;
}

/**
 * Visibility when a project opens: the focused date minus its remembered hides, plus saved
 * extras. Every date layers (absent from `index.of`) are left alone. Without a remembered entry
 * the focused date keeps whatever is already hidden (the manifest's `visible: false`).
 */
export function openChange(
  index: CaptureIndex,
  hidden: Hidden,
  focus: string | null,
  pref: DatePref,
): VisibilityChange {
  const saved = focus ? pref.remembered?.[focus] : undefined;
  const off = new Set(
    saved ?? (focus ? (index.layers[focus] ?? []).filter((id) => hidden[id]) : []),
  );
  const extras = new Set(pref.extras ?? []);
  const change: VisibilityChange = { show: [], hide: [] };
  for (const [layer, capture] of Object.entries(index.of)) {
    const on = capture === focus ? !off.has(layer) : extras.has(layer);
    (on ? change.show : change.hide).push(layer);
  }
  return change;
}

/** Jump from `prev` to `next`: swap the focused date's layers, keep extras. */
export function swapChange(
  index: CaptureIndex,
  hidden: Hidden,
  prev: string | null,
  next: string,
  remembered: Readonly<Record<string, string[]>>,
): { change: VisibilityChange; remembered: Record<string, string[]> } {
  const out: Record<string, string[]> = { ...remembered };
  const change: VisibilityChange = { show: [], hide: [] };
  if (prev === next) return { change, remembered: out };
  if (prev) {
    const left = index.layers[prev] ?? [];
    out[prev] = left.filter((id) => hidden[id]);
    for (const id of left) if (!hidden[id]) change.hide.push(id);
  }
  const keepOff = new Set(out[next] ?? []);
  for (const id of index.layers[next] ?? []) {
    if (hidden[id] && !keepOff.has(id)) change.show.push(id);
  }
  return { change, remembered: out };
}

export function extrasOf(index: CaptureIndex, hidden: Hidden, focus: string | null): string[] {
  return Object.entries(index.of)
    .filter(([id, capture]) => capture !== focus && !hidden[id])
    .map(([id]) => id);
}

export function visibleIn(index: CaptureIndex, hidden: Hidden, capture: string): number {
  return (index.layers[capture] ?? []).filter((id) => !hidden[id]).length;
}

/** What to save for a project now: unknown dates dropped, focused date's hides recorded. */
export function snapshotPref(
  index: CaptureIndex,
  hidden: Hidden,
  focus: string | null,
  remembered: Readonly<Record<string, string[]>>,
): DatePref {
  const kept: Record<string, string[]> = {};
  for (const [capture, ids] of Object.entries(remembered)) {
    if (known(index, capture)) kept[capture] = ids;
  }
  if (focus) kept[focus] = (index.layers[focus] ?? []).filter((id) => hidden[id]);
  return { ...(focus ? { focus } : {}), remembered: kept, extras: extrasOf(index, hidden, focus) };
}

/** The previous or next survey in date order; null past either end. No focus starts at the latest. */
export function stepCapture(
  index: CaptureIndex,
  focus: string | null,
  step: -1 | 1,
): string | null {
  const ids = index.captures.map((c) => c.id);
  if (ids.length === 0) return null;
  const at = focus ? ids.indexOf(focus) : -1;
  if (at < 0) return ids.at(-1) ?? null;
  return ids[at + step] ?? null;
}

/** The layer a pane should show on `next`: counterpart, else first of the same kind. */
export function followLayer(
  index: CaptureIndex,
  layers: readonly Pick<Layer, 'id' | 'kind'>[],
  layerId: string,
  next: string,
): string | undefined {
  if (!(layerId in index.of)) return layerId;
  const twin = counterpart(index, layerId, next);
  if (twin) return twin;
  const kindOf = (id: string) => layers.find((l) => l.id === id)?.kind;
  const kind = kindOf(layerId);
  return (index.layers[next] ?? []).find((id) => kindOf(id) === kind);
}

/** ISO date of the survey a layer belongs to, if any. */
export function layerDate(
  manifest: Pick<ProjectManifest, 'captures' | 'layers'>,
  layerId: string,
): string | undefined {
  const index = captureIndex(manifest);
  const capture = index.of[layerId];
  return index.captures.find((c) => c.id === capture)?.date;
}
