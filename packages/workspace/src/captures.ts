import type { Capture, Layer, ProjectManifest } from '@aio/schema';
import type { StoreApi } from 'zustand/vanilla';
import type { Selection, Workspace } from './index';

/**
 * Captures (survey dates) and the layers that show each one, for comparing two dates side by side
 * (data-conventions section 13). Generic over captures: nothing here knows a project.
 */

/** Layer kinds that can belong to one survey date. Basemaps and legacy viewers never do. */
const DATED_KINDS: ReadonlySet<Layer['kind']> = new Set([
  'mesh',
  'pointcloud',
  'raster',
  'photos',
  'panoramas',
  'video',
  'vector',
]);

export interface CaptureIndex {
  /** The project's captures, oldest first. */
  captures: Capture[];
  /** Layer ids of each capture (dated layers only), by capture id. */
  layers: Record<string, string[]>;
  /** The capture each dated layer belongs to; layers absent here are common to every date. */
  of: Record<string, string>;
  /** Short survey key per capture id (volumetric `epoch`): pile nodes are named `<pile>_<epoch>`. */
  epochs: Record<string, string>;
  /** What a dated layer is, with its date taken out: layers with the same slot are counterparts. */
  slot: Record<string, string>;
}

export interface CaptureHints {
  /** Explicit layers per capture id (volumes.json `captures[].layers`). */
  layers?: Readonly<Record<string, readonly string[]>>;
  /** Survey key per capture id (volumes.json `captures[].epoch`). */
  epochs?: Readonly<Record<string, string>>;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** Ways a layer id or name writes a capture's ISO date, lower case, longest first. */
export function dateSpellings(iso: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return [iso.toLowerCase()];
  const [, y = '', mo = '', d = ''] = m;
  const month = MONTHS[Number(mo) - 1] ?? '';
  const mon = month.slice(0, 3);
  const day = String(Number(d));
  const out = new Set<string>([
    iso,
    `${y}${mo}${d}`,
    `${y}_${mo}_${d}`,
    `${y}.${mo}.${d}`,
    `${d}.${mo}.${y}`,
    `${d}/${mo}/${y}`,
    `${day} ${month} ${y}`,
    `${d} ${month} ${y}`,
    `${day} ${mon} ${y}`,
    `${d} ${mon} ${y}`,
    `${month} ${day}, ${y}`,
    `${mon} ${day}, ${y}`,
    `${month} ${day} ${y}`,
    `${mon} ${day} ${y}`,
  ]);
  return [...out].sort((a, b) => b.length - a.length);
}

/** `needle` inside `hay` and not glued to more letters or digits on either side. */
function containsToken(hay: string, needle: string): boolean {
  if (!needle) return false;
  let at = hay.indexOf(needle);
  while (at >= 0) {
    const before = hay[at - 1] ?? ' ';
    const after = hay[at + needle.length] ?? ' ';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    at = hay.indexOf(needle, at + 1);
  }
  return false;
}

/** The text of `s` without any of `tokens` (dates, capture ids), folded to a comparable key. */
function strip(s: string, tokens: readonly string[]): string {
  let out = s.toLowerCase();
  for (const t of tokens) out = out.split(t).join(' ');
  return out
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function matches(layer: Layer, capture: Capture, epoch: string | undefined): boolean {
  if (
    epoch &&
    layer.kind === 'mesh' &&
    (layer.tags ?? []).some((t) => t.node.endsWith(`_${epoch}`))
  )
    return true;
  const texts = [layer.id.toLowerCase(), layer.name.toLowerCase()];
  const id = capture.id.toLowerCase();
  if (texts.some((t) => t === id || containsToken(t, id))) return true;
  const dates = dateSpellings(capture.date);
  return texts.some((t) => dates.some((d) => containsToken(t, d)));
}

/**
 * Which layers show which capture: the explicit lists when given (volumetric projects), else a
 * layer belongs to the one capture whose id or date its id or name carries (or, for a mesh, whose
 * survey key ends its tagged node names). A layer that names no capture, or several, is common.
 */
export function captureIndex(
  manifest: Pick<ProjectManifest, 'captures' | 'layers'>,
  hints: CaptureHints = {},
): CaptureIndex {
  const captures = [...manifest.captures].sort((a, b) =>
    a.date === b.date ? 0 : a.date < b.date ? -1 : 1,
  );
  const layers: Record<string, string[]> = {};
  const of: Record<string, string> = {};
  const epochs: Record<string, string> = { ...hints.epochs };
  for (const c of captures) layers[c.id] = [];
  const known = new Set(manifest.layers.map((l) => l.id));
  const explicit = new Set<string>();
  for (const c of captures) {
    for (const id of hints.layers?.[c.id] ?? []) {
      if (!known.has(id) || explicit.has(id)) continue;
      explicit.add(id);
      of[id] = c.id;
      layers[c.id]?.push(id);
    }
  }
  if (captures.length > 1) {
    for (const l of manifest.layers) {
      if (explicit.has(l.id) || !DATED_KINDS.has(l.kind)) continue;
      const hits = captures.filter((c) => matches(l, c, epochs[c.id]));
      const only = hits.length === 1 ? hits[0] : undefined;
      if (!only) continue;
      of[l.id] = only.id;
      layers[only.id]?.push(l.id);
    }
  }
  // survey keys from the models: every tagged node of a date's meshes ends in the same `_<key>`
  for (const c of captures) {
    if (epochs[c.id]) continue;
    const nodes = manifest.layers
      .filter((l) => of[l.id] === c.id && l.kind === 'mesh')
      .flatMap((l) => (l.kind === 'mesh' ? (l.tags ?? []).map((t) => t.node) : []));
    const keys = new Set(nodes.map((n) => /_([A-Za-z0-9]+)$/.exec(n)?.[1] ?? ''));
    const [key] = keys;
    if (nodes.length > 0 && keys.size === 1 && key) epochs[c.id] = key;
  }
  const taken = Object.values(epochs);
  if (new Set(taken).size !== taken.length)
    for (const c of captures) if (!hints.epochs?.[c.id]) Reflect.deleteProperty(epochs, c.id);
  const slot: Record<string, string> = {};
  for (const l of manifest.layers) {
    const c = of[l.id];
    if (!c) continue;
    const capture = captures.find((x) => x.id === c);
    const tokens = capture
      ? [
          ...dateSpellings(capture.date),
          capture.id.toLowerCase(),
          ...(epochs[c] ? [epochs[c]] : []),
        ]
      : [];
    const role = l.kind === 'raster' ? `:${l.role}` : '';
    slot[l.id] = `${l.kind}${role}:${strip(l.name, tokens)}`;
  }
  return { captures, layers, of, epochs, slot };
}

/** Two dates to compare: at least two captures, each with a layer of its own. */
export function canCompare(index: CaptureIndex): boolean {
  return index.captures.filter((c) => (index.layers[c.id]?.length ?? 0) > 0).length >= 2;
}

/** A capture id the index knows, else the fallback (first or last date). */
export function knownCapture(
  index: CaptureIndex,
  id: string | undefined,
  fallback: 'first' | 'last',
): string | undefined {
  if (id && index.captures.some((c) => c.id === id)) return id;
  return (fallback === 'first' ? index.captures[0] : index.captures.at(-1))?.id;
}

/**
 * The layer of `capture` that stands for `layerId` (the same slot on another date); the layer
 * itself when it is common or already of that capture; undefined when that date has none.
 */
export function counterpart(
  index: CaptureIndex,
  layerId: string,
  capture: string,
): string | undefined {
  const from = index.of[layerId];
  if (!from || from === capture) return layerId;
  const want = index.slot[layerId];
  const same = (index.layers[capture] ?? []).filter((id) => index.slot[id] === want);
  if (same[0]) return same[0];
  // same kind (and raster role) when the names differ more than by their date
  const kindOf = (id: string) => (index.slot[id] ?? '').split(':').slice(0, -1).join(':');
  const k = kindOf(layerId);
  const loose = (index.layers[capture] ?? []).filter((id) => kindOf(id) === k);
  return loose.length === 1 ? loose[0] : undefined;
}

/**
 * Visibility of the layers in a view of one capture: common layers as the layer tree says; a
 * layer of another date hidden; a layer of this date shown when any date's layer of its slot is
 * shown (the volumetric workspace shows one survey at a time through the same switches).
 */
export function captureHidden(
  index: CaptureIndex,
  capture: string,
  layers: readonly Pick<Layer, 'id'>[],
  hidden: Readonly<Record<string, true>>,
): Record<string, true> {
  const shownSlots = new Set<string>();
  for (const l of layers) {
    const s = index.slot[l.id];
    if (s && index.of[l.id] && !hidden[l.id]) shownSlots.add(s);
  }
  const out: Record<string, true> = {};
  for (const l of layers) {
    const c = index.of[l.id];
    if (!c) {
      if (hidden[l.id]) out[l.id] = true;
      continue;
    }
    const s = index.slot[l.id];
    if (c !== capture || !s || !shownSlots.has(s)) out[l.id] = true;
  }
  return out;
}

/**
 * The selection as a view of `capture` shows it: a component picked on another date's model maps
 * to the same component on this date's model (`P01_e2` on the 10 Jan terrain is `P01_e1` on the
 * 31 Dec one). Anything else is unchanged.
 */
export function captureSelection(
  index: CaptureIndex,
  capture: string,
  sel: Selection | null,
): Selection | null {
  if (sel?.kind !== 'asset' || !sel.layer) return sel;
  const from = index.of[sel.layer];
  if (!from || from === capture) return sel;
  const layer = counterpart(index, sel.layer, capture);
  if (!layer) return sel;
  const a = index.epochs[from];
  const b = index.epochs[capture];
  const id = a && b && sel.id.endsWith(`_${a}`) ? `${sel.id.slice(0, -a.length)}${b}` : sel.id;
  return { ...sel, id, layer };
}

/* ----------------------------------------------------------------------- scoped store */

/** How a view sees the workspace: one capture's layers, its own selection, maybe no camera. */
export interface StoreScope {
  /** The capture the view shows. */
  capture: string;
  index: CaptureIndex;
  /**
   * `hide`: every layer stays loaded, other dates' layers are hidden (the main 3D view, so leaving
   * the comparison is instant). `drop`: other dates' layers and the kinds a second view does not
   * draw are left out, so they never load there.
   */
  mode: 'hide' | 'drop';
  /** Layer kinds a `drop` view leaves out even when common (the video plays in one view only). */
  dropKinds?: readonly Layer['kind'][];
  /** Pass camera requests (fly to) to the view; false while its camera follows a linked view. */
  camera: boolean;
}

export interface ScopedStore extends StoreApi<Workspace> {
  readonly scope: StoreScope | null;
  /** Change what the view sees; subscribers hear it as one state change. */
  setScope(scope: StoreScope | null): void;
}

/** Memo of one value derived from one input, invalidated by the scope version. */
function memo<I, O>(fn: (input: I) => O) {
  let last: { input: I; v: number; out: O } | null = null;
  return (input: I, v: number): O => {
    if (last?.input === input && last.v === v) return last.out;
    const out = fn(input);
    last = { input, v, out };
    return out;
  };
}

/**
 * A view of the workspace for one capture: the same store (actions write to it) with the layer
 * list, the visibility and the selection seen through `scope`. Derived values keep their identity
 * while their inputs do, so a clock tick does not look like a layer change. Null scope: the
 * workspace as it is.
 */
export function scopedStore(
  base: StoreApi<Workspace>,
  initial: StoreScope | null = null,
): ScopedStore {
  let scope = initial;
  let version = 0;
  const cache = new WeakMap<Workspace, { v: number; d: Workspace }>();
  const listeners = new Set<(s: Workspace, prev: Workspace) => void>();

  const dropped = (l: Layer, sc: StoreScope) =>
    sc.mode === 'drop' &&
    ((sc.index.of[l.id] !== undefined && sc.index.of[l.id] !== sc.capture) ||
      (sc.dropKinds ?? []).includes(l.kind));

  const project = memo((p: Workspace['project']) => {
    const sc = scope;
    if (!p || sc?.mode !== 'drop') return p;
    const layers = p.manifest.layers.filter((l) => !dropped(l, sc));
    return { ...p, manifest: { ...p.manifest, layers } };
  });
  const hidden = memo((s: Pick<Workspace, 'hidden' | 'project'>) => {
    const sc = scope;
    if (!sc || !s.project) return s.hidden;
    return captureHidden(sc.index, sc.capture, s.project.manifest.layers, s.hidden);
  });
  // keyed on both inputs: the visibility depends on the layers and the switches
  let hiddenKey: { hidden: Workspace['hidden']; project: Workspace['project'] } | null = null;
  const selection = memo((sel: Selection | null) =>
    scope ? captureSelection(scope.index, scope.capture, sel) : sel,
  );

  const derive = (s: Workspace): Workspace => {
    if (!scope) return s;
    const hit = cache.get(s);
    if (hit?.v === version) return hit.d;
    if (hiddenKey?.hidden !== s.hidden || hiddenKey.project !== s.project)
      hiddenKey = { hidden: s.hidden, project: s.project };
    const d: Workspace = {
      ...s,
      project: project(s.project, version),
      hidden: hidden(hiddenKey, version),
      selection: selection(s.selection, version),
      camera: scope.camera ? s.camera : null,
    };
    cache.set(s, { v: version, d });
    return d;
  };

  let unsub: (() => void) | null = null;
  const ensure = () => {
    unsub ??= base.subscribe((s, prev) => {
      const a = derive(s);
      const b = derive(prev);
      for (const l of [...listeners]) l(a, b);
    });
  };

  return {
    get scope() {
      return scope;
    },
    setScope(next) {
      const before = derive(base.getState());
      scope = next;
      version += 1;
      const after = derive(base.getState());
      if (after !== before) for (const l of [...listeners]) l(after, before);
    },
    getState: () => derive(base.getState()),
    getInitialState: () => derive(base.getInitialState()),
    setState: base.setState,
    subscribe(listener) {
      listeners.add(listener);
      ensure();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsub?.();
          unsub = null;
        }
      };
    },
  };
}
