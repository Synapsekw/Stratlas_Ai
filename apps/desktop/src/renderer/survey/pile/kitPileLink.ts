/**
 * A kit pile picked in the volumetric view (its body, toe line, callout or register row) opens the
 * volume measurement it was converted to, found by `origin.pile`. A kit pile with no measurement
 * keeps the volumetric view's own selection only.
 */
import type { SurveyMeasurement } from '@aio/schema';
import { volumetric } from '@aio/volumetric';
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
