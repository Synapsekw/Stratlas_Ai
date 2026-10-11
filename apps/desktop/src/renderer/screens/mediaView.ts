/**
 * What the Media screen shows of its photos: only the ones with findings, the order, one severity
 * level, and a scope (a set of photos with a label, a chip the person can clear). It lives in a
 * store so the screen and the agent set the same thing, and the person sees every filter on the
 * screen and can clear it.
 *
 * The only-with-findings switch and the order last while the app runs; the scope and the level
 * belong to the open project and clear when another one opens.
 */
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  orderPhotos,
  photoKey,
  rankOfSeverity,
  type PhotoFindings,
  type PhotoOrder,
} from './mediaFindings';

export interface MediaViewState {
  onlyFindings: boolean;
  order: PhotoOrder;
  /** A level's value, `uncertain`, or null for any. */
  severity: number | 'uncertain' | null;
  /** Photo keys, `photoKey(layer, photo)`, with the label the chip shows. */
  scope: { label: string; ids: readonly string[] } | null;
}

export const DEFAULT_MEDIA_VIEW: MediaViewState = {
  onlyFindings: false,
  order: 'file',
  severity: null,
  scope: null,
};

export const mediaView: StoreApi<MediaViewState> = createStore<MediaViewState>(
  () => DEFAULT_MEDIA_VIEW,
);

export function setMediaView(patch: Partial<MediaViewState>): void {
  mediaView.setState(patch);
}

export function useMediaView<T>(selector: (s: MediaViewState) => T): T {
  return useStore(mediaView, selector);
}

/**
 * A request to bring the photos the view shows into view: the agent set the filter, and what it
 * was asked to show sits below the videos. It is asked for once and taken once by the Media
 * screen, which may only show after the request was made. It is not part of the view: a filter
 * changed by hand, or put back by Undo, asks for nothing.
 */
export const mediaReveal: StoreApi<{ asked: number; taken: number }> = createStore<{
  asked: number;
  taken: number;
}>(() => ({ asked: 0, taken: 0 }));

export function requestMediaReveal(): void {
  mediaReveal.setState((s) => ({ asked: s.asked + 1 }));
}

/** True once per request (several made before it is taken are one): the screen scrolls then. */
export function takeMediaReveal(): boolean {
  const { asked, taken } = mediaReveal.getState();
  if (asked === taken) return false;
  mediaReveal.setState({ taken: asked });
  return true;
}

/** How many times it was asked for: a change tells the screen to look. */
export function useMediaRevealAsked(): number {
  return useStore(mediaReveal, (s) => s.asked);
}

/** The photos of a set the view shows, in order: scope, then level, then only-with-findings, then order. */
export function photosInView<T extends { id: string }>(
  items: readonly T[],
  layer: string,
  index: ReadonlyMap<string, PhotoFindings>,
  v: MediaViewState,
): T[] {
  let kept = items;
  if (v.scope) {
    const keys = new Set(v.scope.ids);
    kept = kept.filter((p) => keys.has(photoKey(layer, p.id)));
  }
  if (v.severity !== null) {
    const rank = rankOfSeverity(v.severity);
    kept = kept.filter((p) => index.get(photoKey(layer, p.id))?.levels.includes(rank) === true);
  }
  return orderPhotos(kept, layer, index, v.onlyFindings, v.order);
}

/**
 * The highest level present on the photos (in scope when one is given); null when no photo has a
 * graded finding. Uncertain (0.5) and ungraded (0.25) rank below every level, so uncertain is the
 * answer only when nothing is graded.
 */
export function highestLevel(
  index: ReadonlyMap<string, PhotoFindings>,
  scope: readonly string[] | null,
): number | 'uncertain' | null {
  const photos = scope
    ? scope.flatMap((k) => {
        const f = index.get(k);
        return f ? [f] : [];
      })
    : [...index.values()];
  const worst = photos.reduce((m, f) => Math.max(m, f.levels[0] ?? 0), 0);
  if (worst > rankOfSeverity('uncertain')) return worst;
  return worst === rankOfSeverity('uncertain') ? 'uncertain' : null;
}

/**
 * The name of a level: from the first severity model that has it. Empty for no level and for a
 * level no model has. The Severity select and the answer of the agent both name a level with
 * this, so the person reads on the screen the word the agent said.
 */
export function levelLabel(
  manifest: Pick<ProjectManifest, 'severityModels'>,
  level: MediaViewState['severity'],
): string {
  if (level === null) return '';
  for (const model of manifest.severityModels) {
    const label =
      level === 'uncertain'
        ? model.uncertain?.label
        : model.levels.find((l) => l.value === level)?.label;
    if (label) return label;
  }
  return '';
}

/**
 * An entry of the Severity select: a level with its name (empty for a level no model names: the
 * screen shows its value), or uncertain, which the select names with the app's own word.
 */
export type SeverityOption = { value: number; label: string } | 'uncertain';

/**
 * The entries of the Severity select below "Any": every level of every severity model of the
 * project, one per value, worst first, then uncertain when a model has it. A project can have
 * several models, and "the highest present" is taken over all of them, so the first model alone
 * would leave a level the agent set without an entry. The level that is on always has one, also
 * when no model has it: a select with no entry for its value reads "Any" while it filters.
 *
 * Null when there is nothing to choose and nothing on: the select is not drawn.
 */
export function severityOptions(
  models: ProjectManifest['severityModels'],
  current: MediaViewState['severity'],
): SeverityOption[] | null {
  if (models.length === 0 && current === null) return null;
  const values = new Set(models.flatMap((m) => m.levels.map((l) => l.value)));
  if (typeof current === 'number') values.add(current);
  const options: SeverityOption[] = [...values]
    .sort((a, b) => b - a)
    .map((value) => ({ value, label: levelLabel({ severityModels: models }, value) }));
  if (current === 'uncertain' || models.some((m) => m.uncertain !== undefined)) {
    options.push('uncertain');
  }
  return options;
}

/** A level or a scope is set and no photo of any set passes it: the screen says so. */
export function noPhotoMatches(
  sets: readonly { id: string; items: readonly { id: string }[] }[],
  index: ReadonlyMap<string, PhotoFindings>,
  v: MediaViewState,
): boolean {
  if (v.severity === null && v.scope === null) return false;
  return sets.every((set) => photosInView(set.items, set.id, index, v).length === 0);
}

// Another project has other photos and another severity model: the scope and the level go (the
// person could not tell a level of the old model from "Any"), the other choices stay.
workspace.subscribe((ws, prev) => {
  if ((ws.project?.id ?? null) === (prev.project?.id ?? null)) return;
  const { scope, severity } = mediaView.getState();
  if (scope || severity !== null) mediaView.setState({ scope: null, severity: null });
  // a request for the photos of the project that was open is not one for this project's
  takeMediaReveal();
});
