/**
 * The 360 walk track of a draft (`walk.track`): how many frames of the walk saw the same object
 * and, once it is placed, how far and which way it is from where the walker stood. Nothing for a
 * draft without a track or with a one-frame track. Shown on a finding row and in the review queue.
 */
import type { Detection } from '@aio/annotate/detections';
import { Chip, useT } from '@aio/ui';
import type { ReactElement } from 'react';

/** Metres to read in a chip: one decimal under 10 m, whole metres beyond. */
const metres = (m: number): string => (m < 10 ? m.toFixed(1) : String(Math.round(m)));

export function TrackChip({ track }: { track: Detection['track'] }): ReactElement | null {
  const t = useT();
  if (!track || track.frames < 2) return null;
  const placed = track.rangeM !== undefined && track.bearingDeg !== undefined;
  return (
    <>
      <span data-testid="inspect-track">
        <Chip kind="tag">{t('inspect.track.frames', { count: track.frames })}</Chip>
      </span>
      {placed && (
        <span data-testid="inspect-track-place">
          <Chip kind="tag">
            {t('inspect.track.place', {
              range: metres(track.rangeM ?? 0),
              deg: Math.round(track.bearingDeg ?? 0) % 360,
            })}
          </Chip>
        </span>
      )}
    </>
  );
}
