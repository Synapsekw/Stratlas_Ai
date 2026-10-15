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
  sightings?: Sighting[];
}

export interface PlaceSummary {
  layerId: string;
  layerName: string;
  total: number;
  placed: number;
  missed: number;
  noPhoto: number;
  notLoaded: number;
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
  busy: boolean;
  result: PlaceSummary | null;
  matches: MatchOffer[];
  error: string | null;
  offerIds(ids: readonly string[], source: OfferSource): void;
  setLayer(id: string): void;
  place(): Promise<PlaceSummary | null>;
  placeIds(ids: readonly string[], layerId: string): Promise<PlaceSummary | null>;
  notNow(): void;
  undo(): void;
  same(): void;
  different(): void;
  skipAll(): void;
  dismiss(): void;
}

export interface PlacementDeps {
  workspace: StoreApi<Workspace>;
  editor: Pick<IssueEditor, 'commitIssues' | 'undo' | 'state'>;
  /**
   * Learn what projecting the issue needs and no viewer has measured yet (the pixel size of its
   * photos). Runs before `place` for every issue placed on a ready layer.
   */
  prepare: (issue: Issue) => Promise<void>;
  place: (issue: Issue, layer: Layer) => Promise<PlaceResult>;
  /** Write a selection file; its project path, or null when it was not written. */
  writeSelection: (projectId: string, name: string, data: Uint8Array) => Promise<string | null>;
  /** Show the layer when hidden and wait until the 3D view can cast rays at it. */
  ready: (layerId: string) => Promise<boolean>;
  now: () => string;
  newId: () => string;
}

const plural = (n: number) => `${String(n)} issue${n === 1 ? '' : 's'}`;

export function createPlacementStore(deps: PlacementDeps): StoreApi<PlacementState> {
  const issueById = (id: string) => deps.workspace.getState().issues.find((i) => i.id === id);

  return createStore<PlacementState>()((set, get) => {
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

    const placeIds = async (
      ids: readonly string[],
      layerId: string,
    ): Promise<PlaceSummary | null> => {
      const project = deps.workspace.getState().project;
      const layer = project?.manifest.layers.find((l) => l.id === layerId);
      if (!project || !layer) return null;
      set({ busy: true, error: null });
      try {
        const ready = await deps.ready(layerId);
        const outcomes: PlaceOutcome[] = [];
        const next: Issue[] = [];
        for (const id of ids) {
          const issue = issueById(id);
          if (!issue) continue;
          if (!ready) {
            outcomes.push({ id, code: issue.code, ok: false, reason: 'layer-not-loaded' });
            continue;
          }
          await deps.prepare(issue);
          const r = await deps.place(issue, layer);
          if (!r.ok) {
            outcomes.push({ id, code: issue.code, ok: false, reason: r.reason });
            continue;
          }
          let sightings = r.sightings;
          if (r.selection) {
            const path = await deps.writeSelection(
              project.id,
              selectionName(issue.id, layer.id),
              encodeSelection(r.selection.positions, r.selection.lod),
            );
            if (path)
              sightings = [
                ...sightings,
                selectionSighting(layer.id, { path }, r.selection, r.from),
              ];
          }
          next.push(withPlacedArea(issue, layer.id, sightings, deps.now()));
          outcomes.push({ id, code: issue.code, ok: true, sightings });
        }
        const label = `Place ${plural(next.length)} on ${layer.name}`;
        if (next.length > 0) {
          const c = deps.editor.commitIssues(next, label);
          if (!c.ok) {
            set({ busy: false, error: c.error });
            return null;
          }
        }
        const count = (reason: PlaceFailure) => outcomes.filter((o) => o.reason === reason).length;
        const summary: PlaceSummary = {
          layerId,
          layerName: layer.name,
          total: outcomes.length,
          placed: next.length,
          missed: count('missed'),
          noPhoto: count('no-photo-shape'),
          notLoaded: count('layer-not-loaded'),
          label,
          outcomes,
        };
        set({ busy: false, result: summary, matches: matchesFor(next) });
        return summary;
      } catch (e) {
        set({ busy: false, error: e instanceof Error ? e.message : String(e) });
        return null;
      }
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
        if (!r && get().error) set({ offer });
        return r;
      },
      placeIds,
      notNow() {
        set({ offer: null });
      },
      undo() {
        const r = get().result;
        if (r && r.placed > 0 && deps.editor.state.undoLabel === r.label) deps.editor.undo();
        set({ result: null, matches: [] });
      },
      same() {
        const m = get().matches[0];
        const dates = deps.workspace.getState().dates;
        const a = m ? issueById(m.issueId) : undefined;
        const b = m ? issueById(m.otherId) : undefined;
        if (!m || !a || !b || !dates) {
          set({ matches: get().matches.slice(1) });
          return;
        }
        const at = (i: Issue) => dates.captures.findIndex((c) => c.id === issueDate(i, dates));
        const [earlier, later] = at(a) <= at(b) ? [a, b] : [b, a];
        const r = trackPair(
          earlier,
          later,
          { from: issueDate(earlier, dates) ?? '', to: issueDate(later, dates) ?? '' },
          deps.now(),
          deps.newId,
        );
        const changed = [r.earlier, r.later].filter(
          (x): x is Issue => x !== undefined && x !== issueById(x.id),
        );
        const c = deps.editor.commitIssues(changed, `Match ${earlier.code} and ${later.code}`);
        set({ matches: dropMatch([a.id, b.id]), ...(c.ok ? {} : { error: c.error }) });
      },
      different() {
        set({ matches: get().matches.slice(1) });
      },
      skipAll() {
        set({ matches: [] });
      },
      dismiss() {
        set({ result: null, matches: [], error: null });
      },
    };
  });
}
