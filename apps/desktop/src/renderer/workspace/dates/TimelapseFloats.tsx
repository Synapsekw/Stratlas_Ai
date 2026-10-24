/**
 * The timelapse's floats on the stage while the dates player plays (board 6): at the bottom-left
 * the two dates being blended with the blend bar and the between-surveys choice (Crossfade |
 * Swipe | Hold, Swipe only where the kit's swipe exists); at the bottom-right the site total of
 * the surveys in play and "Figures change only at survey dates". Also the app wiring of
 * `connectTimelapse` (timelapse.ts), which the dates strip mounts.
 */
import { localeOf } from '@aio/geo';
import { getActiveMap } from '@aio/maps';
import { effectiveUnits } from '@aio/survey';
import { useT, type MessageKey } from '@aio/ui';
import { useVolumetric, volumetric } from '@aio/volumetric';
import { workspace } from '@aio/workspace';
import { useEffect, useId, type ReactElement } from 'react';
import { useStore } from 'zustand';
import { measureStore, useMeasure } from '../../survey/measureStore';
import { volumeParts } from '../../survey/pile/PileHeader';
import { timeline, useTimeline } from '../timeline';
import { datesPlayer, type BetweenMode } from './datesPlayer';
import {
  connectTimelapse,
  dayAt,
  rasterBlend,
  timelapseStore,
  useTimelapseSurveys,
  type TimelapseDay,
} from './timelapse';
import './timelapse.css';

/** The kit's swipe can carry the timelapse: a stockpile kit with two surveys owns the dates. */
export function kitSwipeAvailable(): boolean {
  const v = volumetric.getState();
  return (
    timeline.getState().owner === 'volumetric' &&
    v.status === 'ready' &&
    (v.file?.captures.length ?? 0) >= 2
  );
}

function useKitSwipe(): boolean {
  const owner = useTimeline((s) => s.owner);
  const ready = useVolumetric((s) => s.status === 'ready' && (s.file?.captures.length ?? 0) >= 2);
  return owner === 'volumetric' && ready;
}

/** Wires the timelapse to the app's player, timeline, map, kit and keys while mounted. */
export function useTimelapseConnection(): void {
  useEffect(
    () =>
      connectTimelapse({
        player: datesPlayer,
        focus: {
          get: () => timeline.getState().focus,
          subscribe: (cb) => timeline.subscribe(cb),
        },
        captureAt: (t) => dayAt(timelapseStore.getState().days, t)?.capture ?? null,
        map: getActiveMap,
        blendFor: (passed, next, f) => {
          const index = timeline.getState().index;
          const w = workspace.getState();
          if (!index || !w.project) return [];
          return rasterBlend(index, w.project.manifest.layers, w.hidden, passed, next, f);
        },
        kitSwipe: {
          available: kitSwipeAvailable,
          set: (x) => {
            const v = volumetric.getState();
            if (x === null) {
              if (v.swipe) v.setSwipe(false);
              return;
            }
            // a survey passed turns the kit's swipe off (setEpoch): turned on again here
            if (!v.swipe) v.setSwipe(true);
            volumetric.getState().setSwipeX(x);
          },
        },
        onPileClick: (cb) =>
          measureStore.subscribe((s, p) => {
            if (s.focus !== p.focus && s.focus !== null) cb();
          }),
        keys: typeof window === 'undefined' ? null : window,
      }),
    [],
  );
}

/* ----------------------------------------------------------------------- the floats */

const MODES: readonly { mode: BetweenMode; label: MessageKey }[] = [
  { mode: 'crossfade', label: 'timelapse.crossfade' },
  { mode: 'swipe', label: 'timelapse.swipe' },
  { mode: 'hold', label: 'timelapse.hold' },
];

export interface TimelapseBlendViewProps {
  passed: TimelapseDay;
  next: TimelapseDay | null;
  /** The fraction of the gap, 0 to 1. */
  f: number;
  between: BetweenMode;
  /** The kit's swipe exists: Swipe is offered. */
  kitSwipe: boolean;
  onBetween: (mode: BetweenMode) => void;
}

/** Bottom-left: "31 Dec and 10 Jan blend 55 %" with its bar, then Between surveys. */
export function TimelapseBlendView(p: TimelapseBlendViewProps): ReactElement {
  const t = useT();
  const id = useId();
  const pct = Math.round(Math.min(1, Math.max(0, p.f)) * 100);
  const blends = p.next !== null && p.between !== 'hold';
  return (
    <div className="tlx overlay-box" data-testid="timelapse-blend">
      {blends && p.next && (
        <div className="tlx-blend" role="status">
          <span>
            {t('timelapse.blend', { from: p.passed.short, to: p.next.short, percent: pct })}
          </span>
          <span className="tlx-bar" aria-hidden="true">
            <i style={{ inlineSize: `${pct}%` }} />
          </span>
        </div>
      )}
      <span className="tlx-cap" id={id}>
        {t('timelapse.between')}
      </span>
      <div className="seg tlx-seg" role="group" aria-labelledby={id}>
        {MODES.filter((m) => m.mode !== 'swipe' || p.kitSwipe).map((m) => (
          <button
            key={m.mode}
            type="button"
            aria-pressed={p.between === m.mode}
            onClick={() => {
              p.onBetween(m.mode);
            }}
          >
            {t(m.label)}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface TimelapseTotalsRow {
  capture: string;
  label: string;
  colour: string;
  /** The formatted site total ("76 199 m³"); null when nothing is counted. */
  volume: string | null;
}

/** Bottom-right: the site total of each survey in play; the figures change only at surveys. */
export function TimelapseTotalsView({ rows }: { rows: readonly TimelapseTotalsRow[] }) {
  const t = useT();
  return (
    <div className="tlx overlay-box" data-testid="timelapse-totals">
      <span className="tlx-cap">{t('timelapse.siteTotal')}</span>
      <dl className="tlx-rows">
        {rows.map((r) => (
          <div key={r.capture} className="tlx-row">
            <dt>
              <span className="tlx-dot" style={{ background: r.colour }} aria-hidden="true" />
              {r.label}
            </dt>
            <dd>{r.volume ?? '-'}</dd>
          </div>
        ))}
      </dl>
      <p className="tlx-note">{t('timelapse.onlyAtSurveys')}</p>
    </div>
  );
}

/** The blend float wired to the player. */
export function TimelapseBlend(): ReactElement | null {
  const surveys = useTimelapseSurveys();
  const f = useStore(datesPlayer, (s) => s.frame?.f ?? 0);
  const between = useStore(datesPlayer, (s) => s.between);
  const kitSwipe = useKitSwipe();
  if (!surveys) return null;
  return (
    <TimelapseBlendView
      passed={surveys.passed}
      next={surveys.next}
      f={f}
      // Swipe chosen in a kit project, then another project: it crossfades, and says so
      between={between === 'swipe' && !kitSwipe ? 'crossfade' : between}
      kitSwipe={kitSwipe}
      onBetween={(mode) => {
        datesPlayer.getState().setBetween(mode);
      }}
    />
  );
}

/** A site total as the Volumes tab writes it. */
export function useVolumeText(): (m3: number | null) => string | null {
  const settings = useMeasure((s) => s.settings);
  const units = effectiveUnits(settings.units);
  const locale = settings.locale ?? localeOf(units.distance);
  return (m3) => {
    if (m3 === null) return null;
    const v = volumeParts(m3, units, settings.precision.volume, locale);
    return `${v.num} ${v.unit}`;
  };
}

/** The site total float wired to the player. */
export function TimelapseTotals(): ReactElement | null {
  const surveys = useTimelapseSurveys();
  const text = useVolumeText();
  if (!surveys) return null;
  const rows = [surveys.passed, ...(surveys.next ? [surveys.next] : [])].map((d) => ({
    capture: d.capture,
    label: d.label,
    colour: d.colour,
    volume: text(d.volumeM3),
  }));
  return <TimelapseTotalsView rows={rows} />;
}
