import type { HeightTiles } from '@aio/schema';
import { surfaceOfCapture } from '@aio/survey';
import { t, type MessageKey } from '@aio/ui';
import {
  useVolumetric,
  volumetric,
  type BodyMode,
  type ChangePair,
  type SurfaceMode,
  type Volumetric,
} from '@aio/volumetric';
import { useId } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { RunCancelled, type SiteReply } from '../survey/engineClient';
import type { SiteRequest } from '../survey/engineProtocol';
import { surveyDateLabel } from './surveyDateLabel';

const SURFACES: { v: SurfaceMode; t: MessageKey; d: MessageKey }[] = [
  { v: 'photo', t: 'vol.surfaceMode.photo', d: 'vol.surfaceMode.photoHint' },
  { v: 'elev', t: 'vol.surfaceMode.elev', d: 'vol.surfaceMode.elevHint' },
  { v: 'change', t: 'vol.surfaceMode.change', d: 'vol.surfaceMode.changeHint' },
];

const BODIES: { v: BodyMode; t: MessageKey; d: MessageKey }[] = [
  { v: 'lift', t: 'vol.bodies.lift', d: 'vol.bodies.liftHint' },
  { v: 'place', t: 'vol.bodies.place', d: 'vol.bodies.placeHint' },
  { v: 'off', t: 'vol.bodies.off', d: 'vol.bodies.offHint' },
];

const NO_CAPTURES: readonly { epoch: string; date: string; label: string }[] = [];

/**
 * The survey dates and Swipe, one switch.
 * Retiring: the notch carries the date and Swipe; kept only until the Volumes bench stops using it.
 */
export function VolumeDateSwipe() {
  const captures = useVolumetric((s) => s.file?.captures ?? NO_CAPTURES);
  const epoch = useVolumetric((s) => s.epoch);
  const swipe = useVolumetric((s) => s.swipe);
  const surface = useVolumetric((s) => s.surface);
  const v = volumetric.getState();
  return (
    <div className="seg vol-dates" role="group" aria-label={t('vol.surveyDate')}>
      {captures.map((c) => (
        <button
          key={c.epoch}
          type="button"
          aria-pressed={!swipe && surface !== 'change' && c.epoch === epoch}
          title={c.label}
          onClick={() => {
            if (surface === 'change') v.setSurface('photo');
            if (swipe) v.setSwipe(false);
            v.setEpoch(c.epoch);
          }}
        >
          {surveyDateLabel(c)}
        </button>
      ))}
      <button
        type="button"
        aria-pressed={swipe}
        disabled={captures.length < 2}
        title={t('vol.swipeTip')}
        onClick={() => {
          if (surface === 'change') v.setSurface('photo');
          v.setSwipe(!swipe);
        }}
      >
        {t('vol.swipe')}
      </button>
    </div>
  );
}

/**
 * The two surveys Cut / fill compares, From and To, one date each (previous to current until
 * another pair is picked). A date is never compared with itself.
 */
export function VolumeChangePicks() {
  const id = useId();
  const captures = useVolumetric((s) => s.file?.captures ?? NO_CAPTURES);
  const change = useVolumetric((s) => s.change);
  // the colours come from the survey engine once its difference for this pair has arrived
  const engine = useVolumetric(
    (s) => !!s.change && s.changeGrid?.from === s.change.from && s.changeGrid.to === s.change.to,
  );
  if (!change) return null;
  const row = (side: keyof ChangePair, label: string) => {
    const other = side === 'from' ? change.to : change.from;
    return (
      <>
        <span className="vol-pair-lbl" id={`${id}-${side}`}>
          {label}
        </span>
        <div
          className="seg vol-dates"
          role="group"
          aria-labelledby={`${id}-${side}`}
          data-testid={`vol-change-${side}`}
        >
          {captures.map((c) => (
            <button
              key={c.epoch}
              type="button"
              aria-pressed={change[side] === c.epoch}
              disabled={c.epoch === other}
              onClick={() => {
                volumetric.getState().setChange({ ...change, [side]: c.epoch });
              }}
            >
              {surveyDateLabel(c)}
            </button>
          ))}
        </div>
      </>
    );
  };
  const label = (epoch: string) => {
    const c = captures.find((x) => x.epoch === epoch);
    return c ? surveyDateLabel(c) : epoch;
  };
  const dates = { from: label(change.from), to: label(change.to) };
  return (
    <div className="vol-pair" role="group" aria-label={t('island.tile.cutFill')}>
      {row('from', t('vol.from'))}
      {row('to', t('vol.to'))}
      <p className="vol-pair-src" role="status" data-testid="vol-change-source">
        {t(engine ? 'vol.change.engine' : 'vol.change.heights', dates)}
      </p>
    </div>
  );
}

/**
 * The surface colours: photo, elevation, cut and fill (with its two surveys while it shows).
 * Retiring: the stage's Show control (StageShow.tsx) is the one surface switch; kept only until
 * the Volumes bench stops using it.
 */
export function VolumeSurfaces() {
  const swipe = useVolumetric((s) => s.swipe);
  const surface = useVolumetric((s) => s.surface);
  const dates = useVolumetric((s) => s.file?.captures.length ?? 0);
  const v = volumetric.getState();
  return (
    <>
      <div className="seg vol-surface" role="group" aria-label={t('vol.surfaceColours')}>
        {SURFACES.map((s) => (
          <button
            key={s.v}
            type="button"
            aria-pressed={surface === s.v}
            title={t(s.d)}
            disabled={s.v === 'change' && dates < 2}
            onClick={() => {
              if (swipe) v.setSwipe(false);
              v.setSurface(s.v);
            }}
          >
            {t(s.t)}
          </button>
        ))}
      </div>
      {surface === 'change' && <VolumeChangePicks />}
    </>
  );
}

/** The volume bodies choice: each with its line of explanation, or `compact`, one switch. */
export function VolumeBodies({ compact = false }: { compact?: boolean }) {
  const body = useVolumetric((s) => s.body);
  const v = volumetric.getState();
  if (compact)
    return (
      <div className="seg vol-bodies" role="group" aria-label={t('vol.bodies')}>
        {BODIES.map((b) => (
          <button
            key={b.v}
            type="button"
            aria-pressed={body === b.v}
            onClick={() => {
              v.setBody(b.v);
            }}
          >
            {t(b.t)}
          </button>
        ))}
      </div>
    );
  return (
    <div className="pop-list" role="group" aria-label={t('vol.bodies')}>
      {BODIES.map((b) => (
        <button
          key={b.v}
          type="button"
          className="pop-item"
          aria-pressed={body === b.v}
          onClick={() => {
            v.setBody(b.v);
          }}
        >
          <b>{t(b.t)}</b>
          <small>{t(b.d)}</small>
        </button>
      ))}
    </div>
  );
}

/** Start or clear the section line between the surveys. */
export function toggleVolumeSection(): void {
  const s = volumetric.getState();
  if (s.section.mode !== 'idle') s.clearSection();
  else s.startSection();
}

/**
 * The section line's name (`vol.sectionLine`).
 * Retiring: the section line is the notch row's tile (island/groups.tsx); kept only until the
 * Volumes bench stops reading it.
 */
export const SECTION_LINE_LABEL = t('vol.sectionLine');

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
