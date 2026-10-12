import { useT } from '@aio/ui';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { SheetPx, WalkDrawing } from './walkOverlay';
import './walkOverlay.css';

/** Line width, still dot diameter and pin size on screen, px. */
const LINE_PX = 2;
const STILL_PX = 3;
const PIN_R = 9;
const DASH = [6, 4] as const;
/** Opacity of a walk outside Place walk (and of the walks not being placed). */
const DIM = 0.6;

const num = (v: number): string => String(Math.round(v * 1000) / 1000);
const pathOf = (pts: readonly SheetPx[]): string =>
  pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${num(x)} ${num(y)}`).join('');

/**
 * The walks on a drawing (design "What the surface shows"), as SVG in the picture's pixels inside
 * `RasterView`'s overlay: the path line in the date colour (dashed across a stretch without a pin),
 * still dots under it, numbered pins and the current position, all at a constant screen size
 * (`1 / scale`, as the place marks). Pins can be dragged when `onPinDrag` and `toImage` (from the
 * overlay context of `RasterView`) are given; `i` is the pin's index in the calibration's `pins`.
 */
export function WalkSheetOverlay({
  drawings,
  scale,
  onPinDrag,
  toImage,
}: {
  drawings: readonly WalkDrawing[];
  scale: number;
  onPinDrag?: ((layerId: string, i: number, px: [number, number]) => void) | undefined;
  toImage?: ((clientX: number, clientY: number, from: Element) => [number, number]) | undefined;
}) {
  const t = useT();
  const k = 1 / (Number.isFinite(scale) && scale > 0 ? scale : 1);
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ id: number; layer: string; index: number } | null>(null);
  const draggable = onPinDrag !== undefined && toImage !== undefined;

  const pinHandlers = (layer: string, index: number) =>
    draggable
      ? {
          onPointerDown: (e: ReactPointerEvent<SVGGElement>) => {
            if (e.button !== 0) return;
            // the picture under the pin does not pan or pick
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { id: e.pointerId, layer, index };
          },
          onPointerMove: (e: ReactPointerEvent<SVGGElement>) => {
            const d = drag.current;
            if (d?.id !== e.pointerId) return;
            const px = toImage(e.clientX, e.clientY, e.currentTarget);
            if (px.every(Number.isFinite)) onPinDrag(d.layer, d.index, px);
          },
          onPointerUp: (e: ReactPointerEvent<SVGGElement>) => {
            if (drag.current?.id === e.pointerId) drag.current = null;
          },
          onPointerCancel: () => {
            drag.current = null;
          },
        }
      : {};

  return (
    <svg className="walk-overlay" data-testid="walk-overlay" aria-hidden="true">
      {drawings.map((d) => {
        const pins = [...d.pins].sort(
          (a, b) =>
            Number(hover === `${d.id}:${String(a.index)}`) -
            Number(hover === `${d.id}:${String(b.index)}`),
        );
        return (
          <g
            key={d.id}
            data-testid="walk-drawing"
            data-walk={d.id}
            opacity={d.placing ? undefined : DIM}
            style={{ color: d.colour }}
          >
            {d.stills.map(([x, y], i) => (
              <circle
                key={`s${String(i)}`}
                data-testid="walk-still"
                cx={num(x)}
                cy={num(y)}
                r={num((STILL_PX / 2) * k)}
                fill={d.colour}
              />
            ))}
            {d.line.map((run, i) => (
              <path
                key={`l${String(i)}`}
                className="walk-line"
                data-testid="walk-line"
                d={pathOf(run.pts)}
                stroke={d.colour}
                strokeWidth={num(LINE_PX * k)}
                {...(run.dashed
                  ? { strokeDasharray: `${num(DASH[0] * k)} ${num(DASH[1] * k)}` }
                  : {})}
              />
            ))}
            {d.now && (
              <g
                className="walk-now"
                data-testid="walk-now"
                transform={`translate(${num(d.now.at[0])} ${num(d.now.at[1])}) rotate(${num((d.now.headingRad * 180) / Math.PI)}) scale(${num(k)})`}
              >
                <line x1="0" y1="0" x2="14" y2="0" stroke={d.colour} />
                <circle r="5" fill={d.colour} />
              </g>
            )}
            {pins.map((p) => {
              const key = `${d.id}:${String(p.index)}`;
              return (
                <g
                  key={key}
                  className={[
                    'walk-pin',
                    p.active ? '' : 'inactive',
                    draggable ? 'draggable' : '',
                    hover === key ? 'raised' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-testid="walk-pin"
                  transform={`translate(${num(p.at[0])} ${num(p.at[1])}) scale(${num(k)})`}
                  onPointerEnter={() => {
                    setHover(key);
                  }}
                  onPointerLeave={() => {
                    setHover((h) => (h === key ? null : h));
                  }}
                  {...pinHandlers(d.id, p.index)}
                >
                  {!p.active && <title>{t('walk.pin.gone')}</title>}
                  <circle r={PIN_R} />
                  <text dy="0.35em">{p.n}</text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
