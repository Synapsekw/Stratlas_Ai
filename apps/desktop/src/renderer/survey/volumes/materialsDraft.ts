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
  newestDensity,
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
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { timeline } from '../../workspace/timeline';
import { showBench } from '../../workspace/workbench/followTool';
import { workbench, type WorkbenchState } from '../../workspace/workbench/workbenchStore';
import { measureStore, replaceMeasurements, saveSiteSettings } from '../measureStore';
import { captureDateOf, datedCaptures, type DatedCapture } from './surveyDates';
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

// the survey dates live in their own pure module (surveyDates.ts) so readers need no store
export { captureDateOf, datedCaptures, type DatedCapture } from './surveyDates';

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

export interface CountOptions {
  /**
   * The inventory's counting rule (`useCounted`: fingerprint staleness, failed runs, no data):
   * whether a pile's figure on a capture is added to totals. Without it, only a figure's own
   * status decides (stale and refused ones are left out).
   */
  isCounted?: (pile: string, capture: string) => boolean;
}

/** The piles whose figure on the capture the inventory counts (`CountOptions.isCounted`). */
function countedOn(
  piles: readonly SurveyMeasurement[],
  capture: string,
  opts: CountOptions,
): SurveyMeasurement[] {
  const isCounted = opts.isCounted;
  return isCounted ? piles.filter((p) => isCounted(p.id, capture)) : [...piles];
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
  opts: CountOptions = {},
): { rows: MaterialRow[]; total: MaterialTotals } {
  const assigned = withAssignments(piles, assignments);
  const counted = countedOn(assigned, capture, opts);
  const groups = inventoryByMaterial(counted, capture, null, materials, dateOf);
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
  opts: CountOptions,
): number | null {
  const density = densityOn(material, capture, dateOf);
  if (density === null) return null;
  let sum = 0;
  for (const p of countedOn(piles, capture, opts)) {
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
  opts: CountOptions = {},
): DensityImpact | null {
  const dateOf = captureDateOf(captures);
  const at = dateOf(fromCapture);
  if (at === null) return null;
  const earlier = datedCaptures(captures).filter((c) => (dateOf(c.id) ?? 0) < at);
  const other = earlier.at(-1)?.id;
  if (other === undefined) return null;
  const from = tonnesOf(saved, piles, assignments, fromCapture, dateOf, opts);
  const to = tonnesOf(draft, piles, assignments, fromCapture, dateOf, opts);
  const otherTonnes = tonnesOf(draft, piles, assignments, other, dateOf, opts);
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
  /** The survey date in focus (an imported density applies from it; else the latest date). */
  focus?(): string | null;
  /** Called once, at the first edit: start watching what drops the draft (a project change). */
  watch?(): void;
  /** Write the materials and the piles' materials; null when saved, else why not. */
  save(materials: SiteMaterial[], assignments: Assignments): Promise<string | null>;
}

export interface MaterialsDraftState {
  /** The edited materials, or null while nothing is edited. */
  draft: SiteMaterial[] | null;
  /** The saved materials the draft started from (Save rebases the edits onto the newer ones). */
  since: readonly SiteMaterial[] | null;
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

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The draft's edits rebased onto the materials saved since it started (`since` to `now`): a field
 * the draft changed takes the draft's value, every other field the newer saved one; a density
 * edit is applied again from its date onto the newer history (`withDensityFrom`), so a density
 * saved meanwhile from the pile panel is kept. Materials added meanwhile are kept, at the end.
 */
export function rebaseMaterials(
  draft: readonly SiteMaterial[],
  since: readonly SiteMaterial[],
  now: readonly SiteMaterial[],
  edits: Readonly<Record<string, DensityEdit>>,
  captures: readonly DatedCapture[],
): SiteMaterial[] {
  const was = new Map(since.map((m) => [m.id, m]));
  const cur = new Map(now.map((m) => [m.id, m]));
  const dateOf = captureDateOf(captures);
  const out = draft.map((d): SiteMaterial => {
    const b = was.get(d.id);
    const c = cur.get(d.id);
    if (!b || !c) return d;
    const dr = d as unknown as Record<string, unknown>;
    const br = b as unknown as Record<string, unknown>;
    // the fields the draft changed (a field it removed is left out)
    const changed = new Set(
      [...Object.keys(dr), ...Object.keys(br)].filter(
        (k) => k !== 'densityTPerM3' && k !== 'densityHistory' && !sameJson(dr[k], br[k]),
      ),
    );
    const next = Object.fromEntries([
      ...Object.entries(c).filter(([k]) => !changed.has(k)),
      ...Object.entries(dr).filter(([k, v]) => changed.has(k) && v !== undefined),
    ]);
    let m = next as unknown as SiteMaterial;
    const e = edits[d.id];
    if (e) {
      const earliest = datedCaptures(captures)[0]?.id ?? e.fromCapture;
      m = withDensityFrom(m, e.fromCapture, e.tPerM3, earliest, dateOf);
    } else if (
      !sameJson(d.densityTPerM3, b.densityTPerM3) ||
      !sameJson(d.densityHistory, b.densityHistory)
    ) {
      const rest = { ...m };
      delete rest.densityTPerM3;
      delete rest.densityHistory;
      m = {
        ...rest,
        ...(d.densityTPerM3 !== undefined ? { densityTPerM3: d.densityTPerM3 } : {}),
        ...(d.densityHistory !== undefined ? { densityHistory: d.densityHistory } : {}),
      };
    }
    return m;
  });
  const have = new Set(draft.map((m) => m.id));
  for (const c of now) if (!have.has(c.id) && !was.has(c.id)) out.push(c);
  return out;
}

export function createMaterialsDraft(deps: MaterialsDraftDeps): StoreApi<MaterialsDraftState> {
  return createStore<MaterialsDraftState>()((set, get) => {
    const current = (): SiteMaterial[] => get().draft ?? [...deps.base()];
    /** Change the draft, remembering the saved materials it started from. */
    let watching = false;
    const watch = () => {
      if (watching) return;
      watching = true;
      deps.watch?.();
    };
    const setDraft = (draft: SiteMaterial[]) => {
      watch();
      set({ draft, since: get().since ?? [...deps.base()] });
    };
    const patchOne = (id: string, fn: (m: SiteMaterial) => SiteMaterial) => {
      setDraft(current().map((m) => (m.id === id ? fn(m) : m)));
    };
    /** The date in focus when it has a date, else the latest dated survey. */
    const focusOf = (captures: readonly DatedCapture[]): string | null => {
      const dated = datedCaptures(captures);
      const f = deps.focus?.() ?? null;
      if (f !== null && dated.some((c) => c.id === f)) return f;
      return dated.at(-1)?.id ?? null;
    };
    const cleared = { draft: null, since: null, assignments: {}, densityEdits: {} };
    return {
      draft: null,
      since: null,
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
        setDraft([...list, { id, name }]);
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
        watch();
        set({ assignments: next });
      },
      unassign: (pileId) => {
        if (deps.readOnly()) return;
        watch();
        set({ assignments: { ...get().assignments, [pileId]: null } });
      },
      importCsv: (text) => {
        const got = materialsFromCsv(text);
        if (deps.readOnly() || got.materials.length === 0)
          return { read: got.materials.length, problems: got.problems };
        const captures = deps.captures();
        const dateOf = captureDateOf(captures);
        const from = focusOf(captures);
        const earliest = datedCaptures(captures)[0]?.id ?? null;
        const before = current();
        const merged = mergeMaterials(
          before,
          got.materials,
          from !== null && earliest !== null
            ? { fromCapture: from, earliestCapture: earliest, dateOf }
            : undefined,
        );
        // a density the import changed is an edit from the date in focus (Save rebases it)
        const edits = { ...get().densityEdits };
        if (from !== null)
          for (const m of merged) {
            const was = before.find((x) => x.id === m.id);
            const now = newestDensity(m, dateOf);
            if (was && now !== null && newestDensity(was, dateOf) !== now)
              edits[m.id] = { fromCapture: from, tPerM3: now };
          }
        setDraft(merged);
        set({ densityEdits: edits });
        return { read: got.materials.length, problems: got.problems };
      },
      cancel: () => {
        set(cleared);
      },
      save: async () => {
        if (deps.readOnly()) return t('materials.error.readOnly');
        const s = get();
        const list =
          s.draft !== null && s.since !== null
            ? rebaseMaterials(s.draft, s.since, deps.base(), s.densityEdits, deps.captures())
            : current();
        const ids = new Set<string>();
        for (const [k, m] of list.entries()) {
          const p = SiteMaterialSchema.safeParse(m);
          if (!p.success) {
            const i = p.error.issues[0];
            return t('materials.error.invalid', {
              material: m.name || t('materials.error.nth', { n: k + 1 }),
              problem: i
                ? `${i.path.join('.') || t('materials.error.field')} ${i.message}`
                : t('materials.error.notMaterial'),
            });
          }
          if (ids.has(m.id)) return t('materials.error.idTwice', { id: m.id });
          ids.add(m.id);
        }
        const err = await deps.save(list, get().assignments);
        if (err) return err;
        set(cleared);
        return null;
      },
    };
  });
}

/**
 * Drop the draft and the pending pile assignments when another project opens (or the project
 * closes): they belong to the project they were made in, never to the next one's Save.
 */
export function followProject(
  draft: StoreApi<MaterialsDraftState>,
  projects: {
    getState(): { project: { id: string } | null };
    subscribe(listener: (s: { project: { id: string } | null }) => void): () => void;
  },
): () => void {
  let id = projects.getState().project?.id ?? null;
  return projects.subscribe((s) => {
    const next = s.project?.id ?? null;
    if (next === id) return;
    id = next;
    draft.getState().cancel();
  });
}

/** The renderer's draft: the open project's site materials and its piles. */
export const materialsDraft = createMaterialsDraft({
  base: () => measureStore.getState().settings.materials,
  captures: () => workspace.getState().project?.manifest.captures ?? [],
  readOnly: () => measureStore.getState().readOnly,
  focus: () => timeline.getState().focus,
  // from the first edit on, a project change drops the draft (never at import: tests mock stores)
  watch: () => {
    followProject(materialsDraft, workspace);
  },
  save: async (materials, assignments) => {
    const s = measureStore.getState();
    const err = await saveSiteSettings({ ...s.settings, materials });
    if (err) return t('materials.error.notSaved', { error: err });
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
