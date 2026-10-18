/**
 * The detections of the walk frame nearest the playback time, drawn over the 360 view as an SVG
 * layer (`detOverlay.ts` projects them). Only the playback copy is drawn on: the boxes are in its
 * pixels. Each box is its class colour over a dark halo with a faint tint, its label a chip in
 * that colour (the review's look, `@aio/annotate/detections` `classStyle`); the box under the
 * pointer thickens and comes to the front.
 */
import {
  CHIP_H,
  CHIP_PAD_X,
  boundsOf,
  chipTextColor,
  chipWidth,
  stackChips,
  type Detection,
} from '@aio/annotate/detections';
import type { PanoLook } from '@aio/engine';
import { memo, useMemo, useState } from 'react';
import { boxScreenLines } from './detOverlay';
import './detOverlay.css';

export interface OverlayBox {
  detection: Detection;
  color: string;
  /** Chip text ("No safety jacket 88%"). */
  label: string;
  /** Tooltip; the label when absent. */
  title?: string;
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
  const [hoverId, setHoverId] = useState<string | null>(null);
  const drawn = useMemo(
    () =>
      boxes.flatMap((b) => {
        const d = b.detection;
        const r = boxScreenLines(boundsOf(d.geom), { width: d.size[0], height: d.size[1] }, look, {
          width,
          height,
        });
        if (r.lines.length === 0) return [];
        const pts = r.lines.flat();
        const left = Math.min(...pts.map((p) => p[0]));
        const top = Math.min(...pts.map((p) => p[1]));
        return [{ ...b, lines: r.lines, left, top }];
      }),
    [boxes, look, width, height],
  );
  // the hovered box is drawn last (on top) and its chip placed first (it keeps its place)
  const hovered = drawn.find((b) => b.detection.id === hoverId);
  const ordered = hovered ? [...drawn.filter((b) => b !== hovered), hovered] : drawn;
  const chipOrder = [...ordered].reverse();
  const places = stackChips(
    chipOrder.map((b) => ({ x: b.left, y: b.top, w: chipWidth(b.label), h: CHIP_H })),
    { width, height },
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
      {ordered.map((b) => {
        const closed = b.lines.length === 1;
        const id = b.detection.id;
        const shape = (cls: string) =>
          b.lines.map((line, i) =>
            closed ? (
              <polygon
                key={`${cls}${String(i)}`}
                className={cls}
                points={line.map(fmt).join(' ')}
              />
            ) : (
              <polyline
                key={`${cls}${String(i)}`}
                className={cls}
                points={line.map(fmt).join(' ')}
              />
            ),
          );
        return (
          <g
            key={id}
            className={`walk-det-box ${b.detection.status}${id === hoverId ? ' hov' : ''}`}
            style={{ ['--c' as string]: b.color }}
            data-testid="walk-det-box"
            data-id={id}
            onPointerEnter={() => {
              setHoverId(id);
            }}
            onPointerLeave={() => {
              setHoverId((h) => (h === id ? null : h));
            }}
          >
            <title>{b.title ?? b.label}</title>
            {shape('halo')}
            {shape('line')}
          </g>
        );
      })}
      <g className="walk-det-chips">
        {chipOrder.map((b, i) => {
          const at = places[i];
          if (!at) return null;
          return (
            <g
              key={b.detection.id}
              className={`walk-det-chip${b.detection.id === hoverId ? ' hov' : ''}`}
              data-id={b.detection.id}
              transform={`translate(${at.x.toFixed(1)} ${at.y.toFixed(1)})`}
            >
              <rect width={chipWidth(b.label)} height={CHIP_H} rx={3} fill={b.color} />
              <text x={CHIP_PAD_X} y={CHIP_H / 2} fill={chipTextColor(b.color)}>
                {b.label}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
});
