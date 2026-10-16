import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Where a folding side panel is in its slide (styles.css, `data-fold`). */
export type FoldPhase = 'closing' | 'opening' | null;

/** `--d-2` (tokens.css): how long the slide lasts. */
const SLIDE_MS = 180;
/** A slide whose `transitionend` never comes (a hidden window) settles this much later. */
const SLIDE_SLACK_MS = 120;

export interface Fold {
  /** The layout's state, for the split's controlled `collapsed`: the grid snaps when it flips. */
  layoutFolded: boolean;
  phase: FoldPhase;
  /** The slide ended (`transitionend` / `animationend` of the sliding panel). */
  settle: () => void;
  /** Take a state the person dragged the split into, with no slide (it is already there). */
  snap: (folded: boolean) => void;
}

function reducedMotion(): boolean {
  if (typeof document === 'undefined') return true;
  return document.documentElement.dataset.motion === 'reduce';
}

/**
 * A side panel that folds without resizing the views more than once (UI foundation spec,
 * decision 8): closing, the panel slides out with a transform and the grid snaps at the end;
 * opening, the grid snaps at the start and the panel slides in. Nothing animates a width, so the
 * stage canvas keeps its size during the slide and is resized once. Under reduced motion
 * (`<html data-motion='reduce'>`, the OS setting or Settings) the layout follows at once.
 */
export function useFold(folded: boolean): Fold {
  const [layoutFolded, setLayoutFolded] = useState(folded);
  const [phase, setPhase] = useState<FoldPhase>(null);
  const [seen, setSeen] = useState(folded);
  if (seen !== folded) {
    // adjust state while rendering (react.dev, "storing information from previous renders")
    setSeen(folded);
    if (folded === layoutFolded) setPhase(null);
    else if (reducedMotion()) {
      setLayoutFolded(folded);
      setPhase(null);
    } else if (folded) setPhase('closing');
    else {
      setLayoutFolded(false);
      setPhase('opening');
    }
  }

  const target = useRef(folded);
  useLayoutEffect(() => {
    target.current = folded;
  }, [folded]);

  const settle = useCallback(() => {
    setLayoutFolded(target.current);
    setPhase(null);
  }, []);
  const snap = useCallback((next: boolean) => {
    setLayoutFolded(next);
    setPhase(null);
  }, []);

  useEffect(() => {
    if (!phase) return;
    const timer = setTimeout(settle, SLIDE_MS + SLIDE_SLACK_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [phase, settle]);

  return { layoutFolded, phase, settle, snap };
}
