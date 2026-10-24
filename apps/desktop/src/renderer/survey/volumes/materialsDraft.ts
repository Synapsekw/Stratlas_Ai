/**
 * The Materials pane's draft (volumetrics redesign, spec section 6, board 5): edits to the site
 * materials and to which pile has which material, held until Save or Cancel. A density is edited
 * "from" a survey date (`withDensityFrom`): that date and every later one take it, earlier dates
 * keep the tonnes they had. Save writes `settings.materials` and each reassigned pile's material.
 *
 * Also the Volumes tab's pane choice (`volumesPane`), so the Measure tab's Site materials entry can
 * open the Materials pane (`openMaterialsPane`).
 */
import { SiteMaterial as SiteMaterialSchema } from '@aio/schema';
import type { SiteMaterial, SurveyMeasurement } from '@aio/schema';
import {
  densityOn,
  figureOn,
  inventoryByMaterial,
  materialColour,
  materialIdFrom,
  materialsFromCsv,
  MAX_MATERIALS,
  mergeMaterials,
  withDensityFrom,
  type CaptureDateOf,
} from '@aio/survey';
import { workspace } from '@aio/workspace';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { showBench } from '../../workspace/workbench/followTool';
import { workbench, type WorkbenchState } from '../../workspace/workbench/workbenchStore';
import { measureStore, replaceMeasurements, saveSiteSettings } from '../measureStore';
import { volumesPane } from './volumesPane';

// ------------------------------------------------------------------ the Volumes tab's pane

// the one store for it (volumesPane.ts), which the stage's Show control and the sidebar read too
export { volumesPane, type VolumesPane, type VolumesPaneState } from './volumesPane';

/** Bring the Volumes tab forward on its Materials pane (the Measure tab's Site materials). */
export function openMaterialsPane(bench: StoreApi<WorkbenchState> = workbench): void {
  volumesPane.getState().setPane('materials');
  showBench('volumes', bench);
}

// ------------------------------------------------------------------ dates

/** A capture and its ISO date ('' or absent: no date). */
export interface DatedCapture {
  id: string;
  date?: string;
}

/** A capture's date as milliseconds, null for an undated or unknown capture. */
export function captureDateOf(captures: readonly DatedCapture[]): CaptureDateOf {
  const at = new Map<string, number>();
  for (const c of captures) {
    if (!c.date) continue;
    const t = Date.parse(c.date.slice(0, 10));
    if (Number.isFinite(t)) at.set(c.id, t);
  }
  return (capture) => at.get(capture) ?? null;
}

/** The dated captures, oldest first (undated ones left out). */
export function datedCaptures(captures: readonly DatedCapture[]): DatedCapture[] {
  const dateOf = captureDateOf(captures);
  return captures
    .filter((c) => dateOf(c.id) !== null)
    .sort((a, b) => (dateOf(a.id) ?? 0) - (dateOf(b.id) ?? 0));
}

// ------------------------------------------------------------------ the table

/** A pending material per pile: an id, or null for "No material". */
export type Assignments = Readonly<Record<string, string | null>>;

/** A pile's material with the pending assignments applied. */
export function materialOf(p: SurveyMeasurement, assignments: Assignments): string | undefined {
  if (p.id in assignments) return assignments[p.id] ?? undefined;
  return p.material;
}

const withAssignments = (
  piles: readonly SurveyMeasurement[],
  assignments: Assignments,
): SurveyMeasurement[] =>
  piles.map((p) => {
    if (!(p.id in assignments)) return p;
    const next = { ...p };
    const id = assignments[p.id];
    if (id) next.material = id;
    else delete next.material;
    return next;
  });

export interface MaterialRow {
  material: SiteMaterial;
  colour: string;
  /** The density on the date shown (null: none). */
  density: number | null;
  /** Piles of this material (with or without a figure on the date). */
  piles: number;
  volumeM3: number;
  tonnes: number | null;
}

export interface MaterialTotals {
  piles: number;
  volumeM3: number;
  tonnes: number | null;
}

/**
 * One row per site material on a capture: density on that date, pile count, volume and tonnes
 * (counted figures only, as the inventory adds them), and the "All materials" totals of the rows.
 */
export function materialRows(
  materials: readonly SiteMaterial[],
  piles: readonly SurveyMeasurement[],
  assignments: Assignments,
  capture: string,
  dateOf: CaptureDateOf,
): { rows: MaterialRow[]; total: MaterialTotals } {
  const assigned = withAssignments(piles, assignments);
  const groups = inventoryByMaterial(assigned, capture, null, materials, dateOf);
  const byId = new Map(groups.map((g) => [g.material?.id ?? null, g]));
  const rows = materials.map((m, i): MaterialRow => {
    const g = byId.get(m.id);
    const density = densityOn(m, capture, dateOf);
    return {
      material: m,
      colour: materialColour(m, i),
      density,
      piles: assigned.filter((p) => p.material === m.id).length,
      volumeM3: g?.volumeM3 ?? 0,
      // a material with a density and nothing on the date weighs 0 t
      tonnes: density === null ? null : (g?.tonnes ?? 0),
    };
  });
  const total: MaterialTotals = { piles: 0, volumeM3: 0, tonnes: null };
  for (const r of rows) {
    total.piles += r.piles;
    total.volumeM3 += r.volumeM3;
    if (r.tonnes !== null) total.tonnes = (total.tonnes ?? 0) + r.tonnes;
  }
  return { rows, total };
}

/** The tonnes of one material's piles on a capture at that material's density then. */
function tonnesOf(
  material: SiteMaterial,
  piles: readonly SurveyMeasurement[],
  assignments: Assignments,
  capture: string,
  dateOf: CaptureDateOf,
): number | null {
  const density = densityOn(material, capture, dateOf);
  if (density === null) return null;
  let sum = 0;
  for (const p of piles) {
    if (materialOf(p, assignments) !== material.id) continue;
    const f = figureOn(p, capture);
    if (f && f.status !== 'stale' && f.status !== 'refused') sum += f.netM3 * density;
  }
  return sum;
}

export interface DensityImpact {
  /** The date the new density applies from. */
  capture: string;
  from: number;
  to: number;
  /** The latest earlier date, which keeps its tonnes. */
  other: string;
  otherTonnes: number;
}

/**
 * The tonnes impact of a density edit: on the date it applies from, before and after; and the
 * latest earlier date, which stays as it was. Null when nothing earlier is kept (the edit applies
 * from the first date) or either density is missing.
 */
export function densityImpact(
  saved: SiteMaterial,
  draft: SiteMaterial,
  fromCapture: string,
  piles: readonly SurveyMeasurement[],
  assignments: Assignments,
  captures: readonly DatedCapture[],
): DensityImpact | null {
  const dateOf = captureDateOf(captures);
  const at = dateOf(fromCapture);
  if (at === null) return null;
  const earlier = datedCaptures(captures).filter((c) => (dateOf(c.id) ?? 0) < at);
  const other = earlier.at(-1)?.id;
  if (other === undefined) return null;
  const from = tonnesOf(saved, piles, assignments, fromCapture, dateOf);
  const to = tonnesOf(draft, piles, assignments, fromCapture, dateOf);
  const otherTonnes = tonnesOf(draft, piles, assignments, other, dateOf);
  if (from === null || to === null || otherTonnes === null) return null;
  return { capture: fromCapture, from, to, other, otherTonnes };
}

export interface HistoryRow {
  fromCapture: string;
  tPerM3: number;
  /** The entry this draft adds or changes. */
  isNew: boolean;
}

/** A material's density entries, newest first (undated ones last), the edited one marked new. */
export function historyRows(
  m: SiteMaterial,
  edit: DensityEdit | null,
  dateOf: CaptureDateOf,
): HistoryRow[] {
  const key = (c: string) => dateOf(c) ?? Number.NEGATIVE_INFINITY;
  return [...(m.densityHistory ?? [])]
    .sort((a, b) => key(b.fromCapture) - key(a.fromCapture))
    .map((e) => ({ ...e, isNew: edit?.fromCapture === e.fromCapture }));
}

/**
 * Fallbacks for the material palette tokens until the stylesheet defines them (a muted
 * categorical set that reads on the dark and light themes).
 */
const PALETTE_FALLBACK = [
  'oklch(0.72 0.12 250)',
  'oklch(0.76 0.13 75)',
  'oklch(0.7 0.12 160)',
  'oklch(0.68 0.14 25)',
  'oklch(0.7 0.11 300)',
  'oklch(0.78 0.1 120)',
  'oklch(0.7 0.1 200)',
  'oklch(0.66 0.1 345)',
];

/** A material colour as CSS with a fallback for the palette and "No material" tokens. */
export function swatch(colour: string): string {
  const m = /^var\(--mat-(\d)\)$/.exec(colour);
  if (m)
    return `var(--mat-${m[1] ?? '1'}, ${PALETTE_FALLBACK[Number(m[1]) - 1] ?? 'currentColor'})`;
  if (colour === 'var(--mat-none)') return 'var(--mat-none, var(--fg-4))';
  return colour;
}

// ------------------------------------------------------------------ the draft store

export interface DensityEdit {
  fromCapture: string;
  tPerM3: number;
}

export interface MaterialsDraftDeps {
  /** The saved site materials. */
  base(): readonly SiteMaterial[];
  captures(): readonly DatedCapture[];
  readOnly(): boolean;
  /** Write the materials and the piles' materials; null when saved, else why not. */
  save(materials: SiteMaterial[], assignments: Assignments): Promise<string | null>;
}

export interface MaterialsDraftState {
  /** The edited materials, or null while nothing is edited. */
  draft: SiteMaterial[] | null;
  assignments: Assignments;
  /** The density edit per material (its value and the date it applies from). */
  densityEdits: Readonly<Record<string, DensityEdit>>;
  /** True while anything is unsaved. */
  dirty(): boolean;
  /** The materials as they would be saved. */
  materials(): SiteMaterial[];
  /** Change a material: fields to merge, or a function (to remove optional fields cleanly). */
  edit(id: string, patch: Partial<SiteMaterial> | ((m: SiteMaterial) => SiteMaterial)): void;
  /** Add a material with a fresh id; returns its id (null at the limit). */
  add(name: string): string | null;
  setDensityFrom(id: string, fromCapture: string, tPerM3: number): void;
  /** Give the piles this material (a pile has one material). */
  assign(id: string, pileIds: readonly string[]): void;
  /** Leave a pile with no material. */
  unassign(pileId: string): void;
  /** Merge a CSV's materials into the draft by id. */
  importCsv(text: string): { read: number; problems: string[] };
  cancel(): void;
  /** Save the draft; null when saved, else why not (the draft is kept). */
  save(): Promise<string | null>;
}

export function createMaterialsDraft(deps: MaterialsDraftDeps): StoreApi<MaterialsDraftState> {
  return createStore<MaterialsDraftState>()((set, get) => {
    const current = (): SiteMaterial[] => get().draft ?? [...deps.base()];
    const patchOne = (id: string, fn: (m: SiteMaterial) => SiteMaterial) => {
      set({ draft: current().map((m) => (m.id === id ? fn(m) : m)) });
    };
    return {
      draft: null,
      assignments: {},
      densityEdits: {},
      dirty: () => {
        const s = get();
        return s.draft !== null || Object.keys(s.assignments).length > 0;
      },
      materials: current,
      edit: (id, patch) => {
        if (deps.readOnly()) return;
        patchOne(id, (m) => (typeof patch === 'function' ? patch(m) : { ...m, ...patch }));
      },
      add: (name) => {
        if (deps.readOnly()) return null;
        const list = current();
        if (list.length >= MAX_MATERIALS) return null;
        const id = materialIdFrom(name, new Set(list.map((m) => m.id)));
        set({ draft: [...list, { id, name }] });
        return id;
      },
      setDensityFrom: (id, fromCapture, tPerM3) => {
        if (deps.readOnly()) return;
        const captures = deps.captures();
        const dateOf = captureDateOf(captures);
        const earliest = datedCaptures(captures)[0]?.id ?? fromCapture;
        // each edit starts again from the saved densities: a new "from" date replaces the last one
        const saved = deps.base().find((m) => m.id === id);
        patchOne(id, (m) => {
          const source: SiteMaterial = { ...m };
          delete source.densityHistory;
          delete source.densityTPerM3;
          const history = saved ? saved.densityHistory : m.densityHistory;
          const density = saved ? saved.densityTPerM3 : m.densityTPerM3;
          if (history !== undefined) source.densityHistory = history;
          if (density !== undefined) source.densityTPerM3 = density;
          return withDensityFrom(source, fromCapture, tPerM3, earliest, dateOf);
        });
        set({ densityEdits: { ...get().densityEdits, [id]: { fromCapture, tPerM3 } } });
      },
      assign: (id, pileIds) => {
        if (deps.readOnly()) return;
        const next = { ...get().assignments };
        for (const p of pileIds) next[p] = id;
        set({ assignments: next });
      },
      unassign: (pileId) => {
        if (deps.readOnly()) return;
        set({ assignments: { ...get().assignments, [pileId]: null } });
      },
      importCsv: (text) => {
        const got = materialsFromCsv(text);
        if (!deps.readOnly() && got.materials.length > 0)
          set({ draft: mergeMaterials(current(), got.materials) });
        return { read: got.materials.length, problems: got.problems };
      },
      cancel: () => {
        set({ draft: null, assignments: {}, densityEdits: {} });
      },
      save: async () => {
        if (deps.readOnly()) return 'This project is read-only.';
        const list = current();
        const ids = new Set<string>();
        for (const [k, m] of list.entries()) {
          const p = SiteMaterialSchema.safeParse(m);
          if (!p.success) {
            const i = p.error.issues[0];
            return `${m.name || `Material ${String(k + 1)}`}: ${i ? `${i.path.join('.') || 'material'} ${i.message}` : 'not a material'}`;
          }
          if (ids.has(m.id)) return `The ID "${m.id}" is used twice.`;
          ids.add(m.id);
        }
        const err = await deps.save(list, get().assignments);
        if (err) return err;
        set({ draft: null, assignments: {}, densityEdits: {} });
        return null;
      },
    };
  });
}

/** The renderer's draft: the open project's site materials and its piles. */
export const materialsDraft = createMaterialsDraft({
  base: () => measureStore.getState().settings.materials,
  captures: () => workspace.getState().project?.manifest.captures ?? [],
  readOnly: () => measureStore.getState().readOnly,
  save: async (materials, assignments) => {
    const s = measureStore.getState();
    const err = await saveSiteSettings({ ...s.settings, materials });
    if (err) return `The materials were not saved: ${err}`;
    const next = measureStore
      .getState()
      .file.measurements.filter((m) => m.id in assignments)
      .map((m) => {
        const next = { ...m };
        const id = assignments[m.id];
        if (id) next.material = id;
        else delete next.material;
        return next;
      });
    if (next.length > 0) replaceMeasurements(next);
    return null;
  },
});
