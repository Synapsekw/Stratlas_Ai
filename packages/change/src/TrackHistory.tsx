import { useT } from '@aio/ui';
import type { CSSProperties, ReactElement } from 'react';
import type { Track, TrackMetric } from './tracks';

/**
 * A track's history where the object is inspected (Wave 3 M2): one row per survey date with the
 * values measured on it, and the change since the date before. Nothing when the object was seen on
 * one date only.
 */

const UNIT: Record<TrackMetric, string> = {
  azimuthDeg: '°',
  downtiltDeg: '°',
  centreHeightM: ' m',
  areaM2: ' m²',
  netM3: ' m³',
  maxDistM: ' m',
  peakC: ' °C',
  deltaC: ' °C',
};

const DIGITS: Record<TrackMetric, number> = {
  azimuthDeg: 1,
  downtiltDeg: 1,
  centreHeightM: 2,
  areaM2: 1,
  netM3: 1,
  maxDistM: 2,
  peakC: 1,
  deltaC: 1,
};

export function formatTrackValue(metric: TrackMetric, v: number, signed = false): string {
  const text = v.toFixed(DIGITS[metric]);
  const sign = signed && v > 0 ? '+' : '';
  return `${sign}${text}${UNIT[metric]}`;
}

const BOX: CSSProperties = { display: 'grid', gap: 'var(--sp-2)' };
const HEAD: CSSProperties = { fontSize: 'var(--t-11)', color: 'var(--fg-3)' };
const CELL: CSSProperties = { padding: 'var(--sp-1) var(--sp-2)', textAlign: 'right' };
const FIRST: CSSProperties = { ...CELL, textAlign: 'left' };

export interface TrackHistoryProps {
  track: Track | undefined;
  /** What the app calls a survey date (its label), by capture id. */
  dateLabel: (capture: string) => string;
  /** The sighting being inspected, marked in the list. */
  current?: string;
  testId?: string;
}

export function TrackHistory({
  track,
  dateLabel,
  current,
  testId = 'track-history',
}: TrackHistoryProps): ReactElement | null {
  const t = useT();
  if (!track || track.sightings.length < 2) return null;
  const metrics = track.trends.map((x) => x.metric);
  return (
    <section
      style={BOX}
      data-testid={testId}
      data-track={track.id}
      aria-label={t('change.track.title')}
    >
      <div style={HEAD}>
        {t('change.track.title')} · {t('change.track.seen', { count: track.sightings.length })}
      </div>
      <table className="mono" style={{ borderCollapse: 'collapse', fontSize: 'var(--t-11)' }}>
        <thead>
          <tr style={HEAD}>
            <th style={FIRST} scope="col">
              {t('change.track.date')}
            </th>
            {metrics.map((m) => (
              <th key={m} style={CELL} scope="col">
                {t(`change.track.metric.${m}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {track.sightings.map((s) => (
            <tr
              key={s.capture}
              data-testid={`${testId}-row`}
              data-capture={s.capture}
              aria-current={s.ref === current ? 'true' : undefined}
              style={s.ref === current ? { color: 'var(--fg-1)' } : { color: 'var(--fg-2)' }}
            >
              <th style={FIRST} scope="row">
                {dateLabel(s.capture)}
                {s.draft ? ` (${t('change.track.draft')})` : ''}
              </th>
              {metrics.map((m) => {
                const v = s.values[m];
                return (
                  <td key={m} style={CELL}>
                    {v === undefined ? '-' : formatTrackValue(m, v)}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr data-testid={`${testId}-change`} style={HEAD}>
            <th style={FIRST} scope="row">
              {t('change.track.lastChange')}
            </th>
            {track.trends.map((tr) => (
              <td key={tr.metric} style={CELL}>
                {tr.lastChange === null ? '-' : formatTrackValue(tr.metric, tr.lastChange, true)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </section>
  );
}
