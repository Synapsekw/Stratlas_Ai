/**
 * What the app wires to the stockpile kit's Cut & fill colours: the pair of surveys they compare
 * (the app's one compare pair, picked in the Cut & fill pane and on the dates strip's Compare
 * band) and the survey engine's whole-site difference for it. The kit's own From and To pickers,
 * its section line and its bodies switch are retired (volumetrics finalization, 18 Nov 2026).
 */
import type { HeightTiles } from '@aio/schema';
import { surfaceOfCapture } from '@aio/survey';
import type { Volumetric } from '@aio/volumetric';
import type { StoreApi } from 'zustand/vanilla';
import { RunCancelled, type SiteReply } from '../survey/engineClient';
import type { SiteRequest } from '../survey/engineProtocol';

/** The app's compare pair as the kit follows it (`compareDates`): two capture ids, or none. */
export interface ComparePairSource {
  getState(): { from: string | null; to: string | null };
  subscribe(listener: () => void): () => void;
}

/**
 * Keep the two surveys the kit's Cut & fill colours compare to the app's one compare pair, while
 * those colours show: a From or To picked in the Cut & fill pane or on the dates strip recolours
 * the terrain. A pair the kit has no survey for (or none picked yet) leaves the kit's own default,
 * previous to current.
 */
export function connectVolumePair(
  store: StoreApi<Volumetric>,
  pairs: ComparePairSource,
): () => void {
  const run = () => {
    const s = store.getState();
    if (s.status !== 'ready' || s.surface !== 'change') return;
    const epochOf = (capture: string | null) =>
      s.file?.captures.find((c) => c.captureId === capture)?.epoch;
    const { from, to } = pairs.getState();
    const a = epochOf(from);
    const b = epochOf(to);
    // the store orders the pair and ignores one it already shows
    if (a !== undefined && b !== undefined && a !== b) s.setChange({ from: a, to: b });
  };
  run();
  const offStore = store.subscribe((s, p) => {
    if (s.surface !== p.surface || s.status !== p.status || s.file !== p.file) run();
  });
  const offPairs = pairs.subscribe(run);
  return () => {
    offStore();
    offPairs();
  };
}

/** At most this many cells in a Cut / fill difference grid (as the whole-site comparison). */
const MAX_CHANGE_CELLS = 1_000_000;

export interface VolumeChangeDeps {
  /** The survey engine's whole-site comparison (`engineClient().site`). */
  site(req: SiteRequest, key?: string): Promise<SiteReply>;
  /** The project's prepared surfaces (`compareStore`). */
  surfaces(): readonly HeightTiles[];
  /** Hear the prepared surfaces change (they arrive after the volumes, or are prepared later). */
  onSurfaces?(listener: () => void): () => void;
}

/**
 * Run the survey engine's whole-site comparison of the two surveys Cut / fill compares, whenever
 * they change, and hand its difference to the volumetric store, which drapes it. A date without a
 * prepared surface, or an engine that fails, leaves the colours to the two surveys' own heights.
 */
export function connectVolumeChange(
  store: StoreApi<Volumetric>,
  deps: VolumeChangeDeps,
): () => void {
  let asked = '';
  const run = (s: Volumetric) => {
    const c = s.surface === 'change' ? s.change : null;
    const key = c ? `${s.projectId ?? ''}/${c.from}/${c.to}` : '';
    if (key === asked) return;
    asked = key;
    if (!c) return;
    const capture = (epoch: string) => s.file?.captures.find((x) => x.epoch === epoch)?.captureId;
    const surfaces = deps.surfaces();
    const pick = (epoch: string) => {
      const id = capture(epoch);
      return id ? surfaceOfCapture(surfaces, id) : null;
    };
    const a = pick(c.from);
    const b = pick(c.to);
    if (!a || !b) return;
    // the finer of the two surfaces, coarsened so the grid stays within MAX_CHANGE_CELLS
    const span = (x: HeightTiles) => (x.bounds[3] - x.bounds[0]) * (x.bounds[4] - x.bounds[1]);
    const cellM = Math.max(
      Math.min(a.cellM, b.cellM),
      Math.sqrt(Math.max(span(a), span(b)) / MAX_CHANGE_CELLS),
    );
    deps
      .site(
        { from: { kind: 'survey', surface: a.id }, to: { kind: 'survey', surface: b.id }, cellM },
        'volume-tools-change',
      )
      .then(
        (r) => {
          if (r.grid && asked === key) store.getState().setChangeGrid({ ...c, grid: r.grid });
        },
        (e: unknown) => {
          // a newer pick cancelled it; otherwise the survey heights keep colouring it
          if (!(e instanceof RunCancelled))
            console.warn(`Cut / fill: the engine could not compare ${c.from} with ${c.to}`, e);
        },
      );
  };
  run(store.getState());
  const offStore = store.subscribe(run);
  const offSurfaces = deps.onSurfaces?.(() => {
    // ask again: a date may have a prepared surface now
    asked = '';
    run(store.getState());
  });
  return () => {
    offStore();
    offSurfaces?.();
  };
}
