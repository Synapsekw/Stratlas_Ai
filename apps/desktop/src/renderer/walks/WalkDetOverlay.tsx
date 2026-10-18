/**
 * The detections of the walk frame nearest the playback time, drawn over the 360 view as an SVG
 * layer (`detOverlay.ts` projects them). Only the playback copy is drawn on: the boxes are in its
 * pixels.
 */
import { boundsOf, type Detection } from '@aio/annotate/detections';
import type { PanoLook } from '@aio/engine';
import { memo, useMemo } from 'react';
import { boxScreenLines } from './detOverlay';
import './detOverlay.css';

export interface OverlayBox {
  detection: Detection;
  color: string;
  label: string;
}

const fmt = (p: readonly [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;

export const WalkDetOverlay = memo(function WalkDetOverlay({
  boxes,
  look,
  width,
  height,
}: {
  boxes: readonly OverlayBox[];
  look: PanoLook;
  width: number;
  height: number;
}) {
  const drawn = useMemo(
    () =>
      boxes.map((b) => {
        const d = b.detection;
        const r = boxScreenLines(boundsOf(d.geom), { width: d.size[0], height: d.size[1] }, look, {
          width,
          height,
        });
        return { ...b, ...r };
      }),
    [boxes, look, width, height],
  );
  return (
    <svg
      className="walk-det"
      data-testid="walk-det-overlay"
      width={width}
      height={height}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      aria-hidden="true"
    >
      {drawn.map((b) => {
        if (b.lines.length === 0) return null;
        const closed = b.lines.length === 1;
        return (
          <g
            key={b.detection.id}
            className={`walk-det-box ${b.detection.status}`}
            style={{ ['--c' as string]: b.color }}
            data-testid="walk-det-box"
            data-id={b.detection.id}
          >
            {b.lines.map((line, i) =>
              closed ? (
                <polygon key={i} points={line.map(fmt).join(' ')} />
              ) : (
                <polyline key={i} points={line.map(fmt).join(' ')} />
              ),
            )}
            {b.anchor && (
              <text x={b.anchor[0] + 2} y={b.anchor[1] - 4}>
                {b.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
});
