/**
 * A kit pile picked in the volumetric view (its body, toe line, callout or register row) opens the
 * volume measurement it was converted to, found by `origin.pile`. A kit pile with no measurement
 * keeps the volumetric view's own selection only.
 */
import type { SurveyMeasurement } from '@aio/schema';
import { volumetric } from '@aio/volumetric';
import { primaryScene } from '../../workspace/compare';
import { measurementsOn } from '../measureDates';
import { measureStore } from '../measureStore';
import { openPile } from './openPile';

export interface KitPilePickDeps {
  vol: {
    getState(): { selected: string | null };
    subscribe(
      listener: (s: { selected: string | null }, prev: { selected: string | null }) => void,
    ): () => void;
  };
  measurements: () => readonly SurveyMeasurement[];
  open: (id: string) => void;
}

const appDeps = (): KitPilePickDeps => ({
  vol: volumetric,
  measurements: () => measureStore.getState().file.measurements,
  // the kit pile was picked where it shows: the camera moves only if it is out of view
  open: (id) => {
    openPile(id, undefined, undefined, 'if-out-of-view');
  },
});

/** Follow the volumetric view's selected pile to its measurement. Returns the detach. */
export function connectKitPilePick(deps: KitPilePickDeps = appDeps()): () => void {
  return deps.vol.subscribe((s, prev) => {
    const pile = s.selected;
    if (pile === null || pile === prev.selected) return;
    const m = deps
      .measurements()
      .find((x) => x.origin?.kind === 'kit-pile' && x.origin.pile === pile);
    if (m) deps.open(m.id);
  });
}

/** The kit piles whose converted measurement is among `drawn` (the measurements on screen). */
export function shownKitPiles(drawn: readonly SurveyMeasurement[]): string[] {
  const out = new Set<string>();
  for (const m of drawn) if (m.origin?.kind === 'kit-pile') out.add(m.origin.pile);
  return [...out].sort();
}

/**
 * Tell the volumetric view which kit piles their measurement draws now (shown, on the date in
 * focus): the kit draws no body for those, and keeps it for a pile whose measurement is hidden or
 * on another date. Returns the detach.
 */
export function connectKitPilesShown(): () => void {
  const push = () => {
    volumetric
      .getState()
      .setMeasuredShown(
        shownKitPiles(measurementsOn(measureStore.getState(), primaryScene.getState())),
      );
  };
  const offM = measureStore.subscribe((s, p) => {
    if (
      s.file !== p.file ||
      s.hiddenMeasurements !== p.hiddenMeasurements ||
      s.measurementsVisible !== p.measurementsVisible
    )
      push();
  });
  const offD = primaryScene.subscribe((ws, prev) => {
    if (ws.hidden !== prev.hidden || ws.dates !== prev.dates) push();
  });
  push();
  return () => {
    offM();
    offD();
  };
}
