/**
 * What the Media screen shows of its photos: only the ones with findings, the order, one severity
 * level, and a scope (a set of photos with a label, a chip the person can clear). It lives in a
 * store so the screen and the agent set the same thing, and the person sees every filter on the
 * screen and can clear it.
 *
 * The only-with-findings switch and the order last while the app runs; the scope and the level
 * belong to the open project and clear when another one opens.
 */
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
});
