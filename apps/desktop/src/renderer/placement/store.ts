/**
 * Findings on a model, the app side (spec section 6): the offer to connect findings to a mesh or
 * point cloud, placing them (one editor step), the result with Undo, and match suggestions with
 * Same, Different and Skip all. The projection and the rules of a placed area live in
 * @aio/annotate; the matching rule in @aio/change. Dependencies are injected (index.ts wires the
 * live ones) so the store is tested without a scene or the bridge.
 */
import {
  selectionName,
  selectionSighting,
  withPlacedArea,
  type IssueEditor,
  type PlaceFailure,
  type PlaceResult,
} from '@aio/annotate';
import { issueDate, suggestMatches, trackPair } from '@aio/change';
import { encodeSelection, type Issue, type Layer, type Sighting } from '@aio/schema';
import { formatDate } from '@aio/ui';
import type { Workspace } from '@aio/workspace';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { hasPhotoShape, layerChoices } from './layers';

export type OfferSource = 'detections' | 'change' | 'menu';

export interface PlaceOutcome {
  id: string;
  code: string;
  ok: boolean;
  reason?: PlaceFailure;
  /**
   * The issue, or the photo sighting it was projected from, changed or went while placing:
   * nothing was written for it (reason 'missed'; counted in `PlaceSummary.changed`).
   */
  changed?: true;
  sightings?: Sighting[];
  /** The point selection file could not be written (the prism still landed). */
  selectionError?: string;
}

export interface PlaceSummary {
  layerId: string;
  layerName: string;
  total: number;
  placed: number;
  /** Missed the model (not counting `changed`). */
  missed: number;
  noPhoto: number;
  notLoaded: number;
  /** Changed or removed while placing, so left as they are. */
  changed: number;
  /** Cloud findings whose point selection file could not be written. */
  selectionFailed: number;
  /** The editor step's label: Undo acts only while it is the last step. */
  label: string;
  outcomes: PlaceOutcome[];
}

export interface MatchOffer {
  issueId: string;
  code: string;
  otherId: string;
  otherCode: string;
  /** The other issue's survey date ("3 Mar 2026"). */
  date: string;
}

export interface PlacementState {
  offer: { ids: string[]; source: OfferSource } | null;
  layerId: string | null;
  /** The project has no mesh or point cloud. */
  noLayers: boolean;
  /** A placement is running or waiting its turn. */
  busy: boolean;
  result: PlaceSummary | null;
  matches: MatchOffer[];
  error: string | null;
  /** Undo was pressed after another edit: the placement was not undone (Ctrl+Z still can). */
  undoStale: boolean;
  offerIds(ids: readonly string[], source: OfferSource): void;
  setLayer(id: string): void;
  place(): Promise<PlaceSummary | null>;
  /** Place the issues on a layer; runs queue up, one at a time. */
  placeIds(ids: readonly string[], layerId: string): Promise<PlaceSummary | null>;
  notNow(): void;
  undo(): void;
  /** Track the first match as one finding: true when they are (now or already), else false. */
  same(): boolean;
  different(): void;
  skipAll(): void;
  dismiss(): void;
  /** Forget everything (another project opened); runs still queued write nothing. */
  reset(): void;
}

export type SelectionWrite = { path: string } | { error: string };

export interface PlacementDeps {
  workspace: StoreApi<Workspace>;
  editor: Pick<IssueEditor, 'commitIssues' | 'undo' | 'state'>;
  /**
   * Learn what projecting the issue needs and no viewer has measured yet (the pixel size of its
   * photos). Runs before `place` for every issue placed on a ready layer.
   */
  prepare: (issue: Issue) => Promise<void>;
  place: (issue: Issue, layer: Layer) => Promise<PlaceResult>;
  /** Write a selection file: its project path, or why it was not written. */
  writeSelection: (projectId: string, name: string, data: Uint8Array) => Promise<SelectionWrite>;
  /** Show the layer when hidden and wait until the 3D view can cast rays at it. */
  ready: (layerId: string) => Promise<boolean>;
  now: () => string;
  newId: () => string;
}

const plural = (n: number) => `${String(n)} issue${n === 1 ? '' : 's'}`;

/**
 * A selection file name of its own for every write (`SelectionName`, at most 120 characters):
 * the issue and layer, then the time of the write, so Undo puts back a sighting whose file still
 * holds its own points.
 */
export function stepSelectionName(issueId: string, layer: string, now: string): string {
  const stamp = now.replace(/[^0-9]/g, '').slice(0, 17) || '0';
  return `${selectionName(issueId, layer).slice(0, 119 - stamp.length)}-${stamp}`;
}

/** What one issue's projection gave, before it is committed onto the issue as it is then. */
interface Computed {
  id: string;
  sightings: Sighting[];
  /** Index of the photo sighting projected from, and that sighting as it was. */
  from: number;
  source: string;
}

export function createPlacementStore(deps: PlacementDeps): StoreApi<PlacementState> {
  const issueById = (id: string) => deps.workspace.getState().issues.find((i) => i.id === id);
  const projectId = () => deps.workspace.getState().project?.id ?? null;

  return createStore<PlacementState>()((set, get) => {
    /** Runs one after another (one refine at a time); `generation` moves on at every reset. */
    let queue: Promise<unknown> = Promise.resolve();
    let pending = 0;
    let generation = 0;

    const matchesFor = (placed: readonly Issue[]): MatchOffer[] => {
      const ws = deps.workspace.getState();
      const dates = ws.dates;
      if (!dates) return [];
      const out: MatchOffer[] = [];
      const seen = new Set<string>();
      for (const p of placed) {
        const current = issueById(p.id) ?? p;
        const best = suggestMatches(current, ws.issues, dates)[0];
        if (!best) continue;
        const key = [current.id, best.issue.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const capture = dates.captures.find((c) => c.id === best.capture);
        out.push({
          issueId: current.id,
          code: current.code,
          otherId: best.issue.id,
          otherCode: best.issue.code,
          date: capture ? formatDate(capture.date) : best.capture,
        });
      }
      return out;
    };

    const runPlace = async (
      ids: readonly string[],
      layerId: string,
      project: string | null,
      gen: number,
    ): Promise<PlaceSummary | null> => {
      const current = () => gen === generation && project !== null && projectId() === project;
      const open = deps.workspace.getState().project;
      const layer = open?.manifest.layers.find((l) => l.id === layerId);
      if (!open || !layer || !current()) return null;
      try {
        const ready = await deps.ready(layerId);
        const outcomes = new Map<string, PlaceOutcome>();
        const computed: Computed[] = [];
        for (const id of ids) {
          if (!current()) return null;
          const issue = issueById(id);
          if (!issue) continue;
          if (!ready) {
            outcomes.set(id, { id, code: issue.code, ok: false, reason: 'layer-not-loaded' });
            continue;
          }
          await deps.prepare(issue);
          const r = await deps.place(issue, layer);
          if (!r.ok) {
            outcomes.set(id, { id, code: issue.code, ok: false, reason: r.reason });
            continue;
          }
          let sightings = r.sightings;
          let selectionError: string | undefined;
          if (r.selection) {
            const w = await deps.writeSelection(
              open.id,
              stepSelectionName(issue.id, layer.id, deps.now()),
              encodeSelection(r.selection.positions, r.selection.lod),
            );
            if ('path' in w)
              sightings = [
                ...sightings,
                selectionSighting(layer.id, { path: w.path }, r.selection, r.from),
              ];
            else selectionError = w.error;
          }
          computed.push({
            id,
            sightings,
            from: r.from,
            source: JSON.stringify(issue.sightings[r.from] ?? null),
          });
          outcomes.set(id, {
            id,
            code: issue.code,
            ok: true,
            sightings,
            ...(selectionError !== undefined ? { selectionError } : {}),
          });
        }
        // another project opened meanwhile: nothing of this run is written
        if (!current()) return null;
        // build on the issues as they are now: edits made while placing stay
        const next: Issue[] = [];
        for (const c of computed) {
          const now = issueById(c.id);
          const o = outcomes.get(c.id);
          const same =
            now !== undefined && JSON.stringify(now.sightings[c.from] ?? null) === c.source;
          if (!now || !same) {
            outcomes.set(c.id, {
              id: c.id,
              code: now?.code ?? o?.code ?? c.id,
              ok: false,
              reason: 'missed',
              changed: true,
            });
            continue;
          }
          next.push(withPlacedArea(now, layer.id, c.sightings, deps.now()));
        }
        const label = `Place ${plural(next.length)} on ${layer.name}`;
        if (next.length > 0) {
          const c = deps.editor.commitIssues(next, label);
          if (!c.ok) {
            set({ error: c.error });
            return null;
          }
        }
        const list = ids.flatMap((id) => {
          const o = outcomes.get(id);
          return o ? [o] : [];
        });
        const count = (reason: PlaceFailure) =>
          list.filter((o) => o.reason === reason && !o.changed).length;
        const failed = list.filter((o) => o.ok && o.selectionError !== undefined);
        const summary: PlaceSummary = {
          layerId,
          layerName: layer.name,
          total: list.length,
          placed: next.length,
          missed: count('missed'),
          noPhoto: count('no-photo-shape'),
          notLoaded: count('layer-not-loaded'),
          changed: list.filter((o) => o.changed).length,
          selectionFailed: failed.length,
          label,
          outcomes: list,
        };
        set({
          result: summary,
          matches: matchesFor(next),
          undoStale: false,
          ...(failed[0]?.selectionError !== undefined ? { error: failed[0].selectionError } : {}),
        });
        return summary;
      } catch (e) {
        if (current()) set({ error: e instanceof Error ? e.message : String(e) });
        return null;
      }
    };

    const placeIds = (ids: readonly string[], layerId: string): Promise<PlaceSummary | null> => {
      const project = projectId();
      const gen = generation;
      pending += 1;
      set({ busy: true, error: null });
      const run = queue
        .then(() => runPlace([...ids], layerId, project, gen))
        .finally(() => {
          pending -= 1;
          if (pending === 0) set({ busy: false });
        });
      queue = run.catch(() => undefined);
      return run;
    };

    const dropMatch = (ids: readonly string[]) =>
      get()
        .matches.slice(1)
        .filter((m) => !ids.includes(m.issueId) && !ids.includes(m.otherId));

    return {
      offer: null,
      layerId: null,
      noLayers: false,
      busy: false,
      result: null,
      matches: [],
      error: null,
      undoStale: false,
      offerIds(ids, source) {
        const ws = deps.workspace.getState();
        const project = ws.project;
        if (!project) return;
        const merged = [...new Set([...(get().offer?.ids ?? []), ...ids])];
        const issues = merged
          .map(issueById)
          .filter((i): i is Issue => i !== undefined && hasPhotoShape(i));
        if (issues.length === 0) return;
        const choices = layerChoices(project.manifest, ws.dates, issues);
        const keep = get().layerId;
        const layerId =
          keep && choices.some((c) => c.id === keep) ? keep : (choices[0]?.id ?? null);
        set({
          offer: { ids: issues.map((i) => i.id), source },
          layerId,
          noLayers: choices.length === 0,
        });
      },
      setLayer(id) {
        set({ layerId: id });
      },
      async place() {
        const { offer, layerId } = get();
        if (!offer || !layerId) return null;
        set({ offer: null });
        const r = await placeIds(offer.ids, layerId);
        const notLoaded = r !== null && r.total > 0 && r.notLoaded === r.total;
        if ((!r && get().error) || notLoaded) {
          // offered again, together with anything offered while it ran
          const now = get().offer;
          set({
            offer: {
              ids: [...new Set([...offer.ids, ...(now?.ids ?? [])])],
              source: now?.source ?? offer.source,
            },
          });
        }
        return r;
      },
      placeIds,
      notNow() {
        set({ offer: null });
      },
      undo() {
        const r = get().result;
        const stale = r !== null && r.placed > 0 && deps.editor.state.undoLabel !== r.label;
        if (r && r.placed > 0 && !stale) deps.editor.undo();
        set({ result: null, matches: [], undoStale: stale });
      },
      same() {
        const m = get().matches[0];
        const dates = deps.workspace.getState().dates;
        const a = m ? issueById(m.issueId) : undefined;
        const b = m ? issueById(m.otherId) : undefined;
        if (!m || !a || !b || !dates) {
          set({ matches: get().matches.slice(1) });
          return false;
        }
        const at = (i: Issue) => dates.captures.findIndex((c) => c.id === issueDate(i, dates));
        const [earlier, later] = at(a) <= at(b) ? [a, b] : [b, a];
        const r = trackPair(
          earlier,
          later,
          { from: issueDate(earlier, dates) ?? '', to: issueDate(later, dates) ?? '' },
          deps.now(),
          () => deps.newId(),
        );
        const changed = [r.earlier, r.later].filter(
          (x): x is Issue => x !== undefined && x !== issueById(x.id),
        );
        if (changed.length === 0) {
          set({ matches: dropMatch([a.id, b.id]) });
          return true;
        }
        const c = deps.editor.commitIssues(changed, `Match ${earlier.code} and ${later.code}`);
        set({ matches: dropMatch([a.id, b.id]), ...(c.ok ? {} : { error: c.error }) });
        return c.ok;
      },
      different() {
        set({ matches: get().matches.slice(1) });
      },
      skipAll() {
        set({ matches: [] });
      },
      dismiss() {
        set({ result: null, matches: [], error: null, undoStale: false });
      },
      reset() {
        generation += 1;
        set({
          offer: null,
          layerId: null,
          noLayers: false,
          result: null,
          matches: [],
          error: null,
          busy: false,
          undoStale: false,
        });
      },
    };
  });
}

/** Reset the placement whenever another project opens (or the project closes). */
export function followProject(
  store: StoreApi<PlacementState>,
  ws: StoreApi<Workspace>,
): () => void {
  return ws.subscribe((s, prev) => {
    if ((s.project?.id ?? null) !== (prev.project?.id ?? null)) store.getState().reset();
  });
}
