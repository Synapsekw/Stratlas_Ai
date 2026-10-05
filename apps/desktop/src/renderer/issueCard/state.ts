/**
 * App state around the issue card: when it opens, and the full-size photo viewer (lightbox).
 *
 * Every place that picks an issue (a pin or count badge in 3D, a map marker, a timeline mark, a
 * register row, a detection's issue link) selects it in the workspace; this module turns a newly
 * selected issue into "open the card": the right panel unfolds and its context switches to the
 * selection. Arrow-key stepping through a list (the register, the road defects) keeps that list
 * on screen, so the keyboard does not lose its place.
 */
import type { Selection, Workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { lightboxReducer, type LightboxAction, type LightboxState } from './model';

/** Keys that move through a list without opening what they land on. */
const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'j', 'k']);

export function isListNavKey(key: string): boolean {
  return NAV_KEYS.has(key);
}

/**
 * Should a selection change open the card? Only for a newly selected issue, and not while the
 * keyboard steps through an issue list.
 */
export function opensCard(
  prev: Selection | null,
  next: Selection | null,
  steppingList: boolean,
): boolean {
  if (next?.kind !== 'issue') return false;
  if (prev?.kind === 'issue' && prev.id === next.id) return false;
  return !steppingList;
}

/** Bumped each time the card should come to the front (panels switch to their selection tab). */
export const cardFocus = createStore<{ seq: number; id: string | null }>(() => ({
  seq: 0,
  id: null,
}));

export function useCardFocusSeq(): number {
  return useStore(cardFocus, (s) => s.seq);
}

export interface CardOpen {
  id: string;
  /** Picked with the pointer in the 3D view (pin, count badge list or code label). */
  fromScene: boolean;
}

/**
 * Watch the selection and open the card for each newly picked issue (`onOpen`: unfold the right
 * panel, and open the evidence beside the 3D view when it was picked there). Returns an
 * unsubscribe function.
 */
export function startCardFocus(
  ws: StoreApi<Workspace>,
  onOpen: (open: CardOpen) => void,
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  let stepping = false;
  let inScene = false;
  const within = (t: EventTarget | null, selector: string) =>
    (t as { closest?: (s: string) => unknown } | null)?.closest?.(selector) != null;
  const onKey = (e: Event) => {
    stepping = isListNavKey((e as KeyboardEvent).key) && within(e.target, '[data-issue-list]');
    inScene = false;
  };
  const onPointer = (e: Event) => {
    stepping = false;
    inScene = within(e.target, '.pane-3d');
  };
  target.addEventListener('keydown', onKey, true);
  target.addEventListener('pointerdown', onPointer, true);
  const unsub = ws.subscribe((s, prev) => {
    if (s.selection === prev.selection) return;
    if (!opensCard(prev.selection, s.selection, stepping)) return;
    const id = s.selection?.id ?? '';
    cardFocus.setState((c) => ({ seq: c.seq + 1, id }));
    const fromScene = inScene;
    inScene = false;
    onOpen({ id, fromScene });
  });
  return () => {
    unsub();
    target.removeEventListener('keydown', onKey, true);
    target.removeEventListener('pointerdown', onPointer, true);
  };
}

// ---- lightbox ----

export const lightbox = createStore<{ state: LightboxState | null }>(() => ({ state: null }));

/** Where focus returns when the lightbox closes. */
let opener: HTMLElement | null = null;

export function useLightbox(): LightboxState | null {
  return useStore(lightbox, (s) => s.state);
}

export function lightboxDispatch(a: LightboxAction): void {
  if (a.type === 'open') {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  lightbox.setState((s) => ({ state: lightboxReducer(s.state, a) }));
  if (a.type === 'close') {
    const back = opener;
    opener = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }
}

export function openLightbox(issueId: string, index: number): void {
  lightboxDispatch({ type: 'open', issueId, index });
}
