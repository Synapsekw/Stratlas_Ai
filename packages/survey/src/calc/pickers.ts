import type {
  BaseSpec,
  ComparisonItem,
  DesignEntry,
  HeightTiles,
  SitePoint,
  SurfaceRef,
} from '@aio/schema';

/**
 * The From and To pickers of a comparison item (M11 G4, PRD SRV-1 and SRV-2): what a side can be,
 * how `current` and `previous` resolve on a project, and the small edits the panel makes (swap,
 * change one side, Set to highest or lowest). Pure, so the panel, the bulk editor and the tests
 * agree. The resolution of `current` and `previous` is the engine's (`projectResolver`): among the
 * captures that have a prepared surface, in date order, the one the measurement is viewed on (or
 * the latest) and the one before it.
 */

/** A picker option: its key (stable, for a `<select>`), label, group and the side it makes. */
export interface SideOption {
  key: string;
  label: string;
  group: 'Surveys' | 'Designs' | 'Bases';
  /** A note shown next to the option ("not prepared", "resolves to 12 Mar"). */
  note?: string;
  /** The side; for a base the panel fills in its parameters (`baseFor`). */
  ref: SurfaceRef;
}

const RANK: Record<string, number> = { derived: 0, dsm: 1, cloud: 2, dtm: 3, design: 4 };

/** The prepared surface the engine uses for a capture (cleaned first, then DSM, cloud, DTM). */
export function surfaceOfCapture(
  surfaces: readonly HeightTiles[],
  capture: string,
): HeightTiles | null {
  let best: HeightTiles | null = null;
  let bestRank = Infinity;
  for (const s of surfaces) {
    if (s.capture !== capture) continue;
    const r = RANK[s.source.kind] ?? 9;
    if (!best || r < bestRank || (r === bestRank && s.id < best.id)) {
      best = s;
      bestRank = r;
    }
  }
  return best;
}

export interface Resolution {
  capture: string;
  surface: HeightTiles;
}

/**
 * What `current` and `previous` resolve to: `captures` in date order, `capture` the survey the
 * measurement is viewed on (absent: the latest with a prepared surface).
 */
export function resolveCurrentPrevious(
  surfaces: readonly HeightTiles[],
  captures: readonly string[],
  capture?: string,
): { current: Resolution | null; previous: Resolution | null } {
  const caps = captures.filter((c) => surfaceOfCapture(surfaces, c));
  const cur = capture !== undefined ? (caps.includes(capture) ? capture : undefined) : caps.at(-1);
  const k = cur === undefined ? -1 : caps.indexOf(cur);
  const prev = k > 0 ? caps[k - 1] : undefined;
  const of = (c: string | undefined): Resolution | null => {
    if (c === undefined) return null;
    const s = surfaceOfCapture(surfaces, c);
    return s ? { capture: c, surface: s } : null;
  };
  return { current: of(cur), previous: of(prev) };
}

/** A stable key for a side (the base's parameters are not part of it). */
export function sideKey(ref: SurfaceRef): string {
  switch (ref.kind) {
    case 'survey':
      return `survey:${ref.surface}`;
    case 'design':
      return `design:${ref.design}/${ref.layer}`;
    default:
      return ref.kind;
  }
}

export interface PickerInput {
  surfaces: readonly HeightTiles[];
  /** Capture ids in date order, with their labels. */
  captures: readonly { id: string; label: string }[];
  /** The survey the measurement is viewed on. */
  capture?: string;
  designs?: readonly DesignEntry[];
}

/** Every option a From or To picker offers, in display order. */
export function sideOptions(inp: PickerInput): SideOption[] {
  const label = (c: string) => inp.captures.find((x) => x.id === c)?.label ?? c;
  const { current, previous } = resolveCurrentPrevious(
    inp.surfaces,
    inp.captures.map((c) => c.id),
    inp.capture,
  );
  const out: SideOption[] = [
    {
      key: 'current',
      label: 'Current survey',
      group: 'Surveys',
      note: current ? label(current.capture) : 'no prepared surface',
      ref: { kind: 'current' },
    },
    {
      key: 'previous',
      label: 'Previous survey',
      group: 'Surveys',
      note: previous ? label(previous.capture) : 'no earlier prepared surface',
      ref: { kind: 'previous' },
    },
  ];
  for (const s of inp.surfaces) {
    if (s.source.kind === 'design') continue;
    const opt: SideOption = {
      key: `survey:${s.id}`,
      label: s.capture ? `${label(s.capture)}: ${s.name}` : s.name,
      group: 'Surveys',
      ref: { kind: 'survey', surface: s.id },
    };
    out.push(opt);
  }
  for (const d of inp.designs ?? [])
    for (const l of d.layers) {
      if (l.kind !== 'surface' || l.archived) continue;
      out.push({
        key: `design:${d.id}/${l.id}`,
        label: `${d.name}, ${l.name}`,
        group: 'Designs',
        ...(l.verticalOffsetM !== 0 ? { note: `offset ${String(l.verticalOffsetM)} m` } : {}),
        ref: { kind: 'design', design: d.id, layer: l.id },
      });
    }
  out.push(
    {
      key: 'reference',
      label: 'Reference level',
      group: 'Bases',
      ref: { kind: 'reference', mode: 'perimeter-min' },
    },
    {
      key: 'smart',
      label: 'Smart (triangulated perimeter)',
      group: 'Bases',
      ref: { kind: 'smart' },
    },
    { key: 'fit-plane', label: 'Best-fit plane', group: 'Bases', ref: { kind: 'fit-plane' } },
    {
      key: 'perimeter-mean',
      label: 'Mean perimeter level',
      group: 'Bases',
      ref: { kind: 'perimeter-mean' },
    },
    { key: 'custom', label: 'Custom base (edit vertices)', group: 'Bases', ref: customBase([]) },
  );
  return out;
}

/** True for a side that is a survey (`survey`, `current`, `previous`): it reads the terrain. */
export const isTerrain = (ref: SurfaceRef): boolean =>
  ref.kind === 'survey' || ref.kind === 'current' || ref.kind === 'previous';

/** True for a base (the side sampled on the other one). */
export const isBase = (ref: SurfaceRef): ref is BaseSpec =>
  ref.kind === 'reference' ||
  ref.kind === 'smart' ||
  ref.kind === 'fit-plane' ||
  ref.kind === 'perimeter-mean' ||
  ref.kind === 'custom';

/** The panel's warning when neither side reads a survey, or null. */
export function terrainWarning(item: Pick<ComparisonItem, 'from' | 'to'>): string | null {
  return isTerrain(item.from) || isTerrain(item.to) ? null : 'No reference to current terrain';
}

/** Why an item cannot be computed as it stands, or null. */
export function itemProblem(item: Pick<ComparisonItem, 'from' | 'to'>): string | null {
  if (isBase(item.from) && isBase(item.to))
    return 'At least one side must be a surface: a base is sampled on the other side.';
  return null;
}

/** A custom base on the polygon's vertices, each at its own elevation. */
export function customBase(points: readonly SitePoint[]): BaseSpec {
  const vertices = points.map((p) => ({ e: p[0], n: p[1], z: p[2] }));
  // the contract needs three or more; the panel replaces this with the polygon's vertices
  while (vertices.length < 3) vertices.push({ e: vertices.length, n: 0, z: 0 });
  return { kind: 'custom', vertices };
}

/**
 * The side a picker option makes for a polygon: bases get their parameters (a typed level starts
 * at the mean vertex height, a custom base at the polygon's vertices); the current side is kept
 * when the option is the same kind (so a level or a custom base is not lost).
 */
export function sideFor(option: SideOption, points: readonly SitePoint[], current?: SurfaceRef) {
  if (current && sideKey(current) === option.key) return current;
  const ref = option.ref;
  if (ref.kind === 'custom') return customBase(points);
  if (ref.kind === 'reference') {
    const zs = points.map((p) => p[2]).filter(Number.isFinite);
    const mean = zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : 0;
    return { kind: 'reference', mode: 'level', levelM: Math.round(mean * 1000) / 1000 } as const;
  }
  return ref;
}

/** The item with From and To swapped (dz changes sign: cut and fill swap). */
export function swapItem<T extends Pick<ComparisonItem, 'from' | 'to'>>(item: T): T {
  return { ...item, from: item.to, to: item.from };
}

/** Set a reference side to the highest or lowest point of the surface along the perimeter. */
export function setReferenceMode(
  ref: SurfaceRef,
  mode: 'perimeter-max' | 'perimeter-min' | 'interior-max' | 'interior-min',
): SurfaceRef {
  if (ref.kind !== 'reference') return ref;
  return { kind: 'reference', mode };
}

/** A typed reference level, metres. */
export function setReferenceLevel(ref: SurfaceRef, levelM: number): SurfaceRef {
  if (ref.kind !== 'reference' || !Number.isFinite(levelM)) return ref;
  return { kind: 'reference', mode: 'level', levelM };
}

let seq = 0;
/** A new item id, unique within a measurement. */
export function newItemId(taken: readonly { id: string }[]): string {
  const ids = new Set(taken.map((t) => t.id));
  for (;;) {
    seq = (seq + 1) % 100_000;
    const id = `c${Date.now().toString(36)}${seq.toString(36)}`;
    if (!ids.has(id)) return id;
  }
}

/** The usual first comparison of a polygon: the change from the previous survey to the current. */
export function defaultItem(taken: readonly { id: string }[], deadbandM?: number): ComparisonItem {
  return {
    id: newItemId(taken),
    from: { kind: 'previous' },
    to: { kind: 'current' },
    useDeadband: false,
    ...(deadbandM !== undefined && deadbandM > 0 ? { deadbandM } : {}),
  };
}
