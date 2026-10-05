/**
 * Issue and detection shapes as SVG, in the pixel grid of the picture they are drawn on (the
 * caller's viewBox). Strokes keep their screen width at any scale.
 */
import type { FrameGeom } from '@aio/schema';
import type { CSSProperties } from 'react';
import type { MarkGeom } from './model';

export function Mark({
  geom,
  color,
  pointR,
  className = 'mk',
}: {
  geom: MarkGeom | FrameGeom;
  color: string;
  /** Radius of a point mark, in the picture's pixels. */
  pointR: number;
  className?: string;
}) {
  const style = { ['--c' as string]: color } as CSSProperties;
  switch (geom.type) {
    case 'box':
      return (
        <rect
          className={className}
          style={style}
          x={geom.x}
          y={geom.y}
          width={geom.w}
          height={geom.h}
        />
      );
    case 'rotbox': {
      const cx = geom.x + geom.w / 2;
      const cy = geom.y + geom.h / 2;
      return (
        <rect
          className={className}
          style={style}
          x={geom.x}
          y={geom.y}
          width={geom.w}
          height={geom.h}
          transform={`rotate(${String(geom.angleDeg)} ${String(cx)} ${String(cy)})`}
        />
      );
    }
    case 'polygon':
      return (
        <polygon
          className={className}
          style={style}
          points={geom.points.map((p) => p.join(',')).join(' ')}
        />
      );
    case 'point':
      return (
        <g className={`${className} pt`} style={style}>
          <circle cx={geom.x} cy={geom.y} r={pointR} />
          <circle className="dot" cx={geom.x} cy={geom.y} r={pointR / 4} />
        </g>
      );
  }
}
