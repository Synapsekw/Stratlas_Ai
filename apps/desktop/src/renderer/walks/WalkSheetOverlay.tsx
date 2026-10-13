import { useT } from '@aio/ui';
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PinRole, SheetPreview, SheetPx, WalkDrawing, WalkNow } from './walkOverlay';
import './walkOverlay.css';

/** Line width, dash and still dot diameter on screen, px (non-scaling strokes). */
const LINE_PX = 2;
const DASH = '6 4';
const STILL_PX = 3;
/** Pin radius on screen, px (an 18 px marker). */
const PIN_R = 9;
/** Opacity of a walk outside Place walk (and of the walks not being placed). */
const DIM = 0.6;
/** Opacity of the ghost (the shape before the first click). */
const GHOST_OPACITY = 0.45;

const num = (v: number): string => String(Math.round(v * 1000) / 1000);
const pathOf = (pts: readonly SheetPx[]): string =>
  pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${num(x)} ${num(y)}`).join('');
/** Every still as a zero length segment: round caps draw it as a dot of the stroke width. */
const dotsOf = (pts: readonly SheetPx[]): string =>
  pts.map(([x, y]) => `M${num(x)} ${num(y)}h0`).join('');

type Px = [number, number];

/**
 * The walks on a drawing (design "What the surface shows"), as SVG in the picture's pixels inside
 * `RasterView`'s overlay. The path line in the date colour (dashed across a stretch without a pin)
 * and the still dots use non-scaling strokes, so they are built once per `drawings` and a zoom
 * redraws nothing of them; only the numbered pins and the current position (`now`, apart so a
 * time tick does not touch the path) follow `1 / scale`.
 *
 * Pins of the walk being placed can be dragged when `onPinDrag` and `toImage` (from the overlay
 * context of `RasterView`) are given: `onPinDrag` on every move, `onPinDragEnd` once on release,
 * with `i` the pin's index in the calibration's `pins` and the pixel kept on the picture (`size`).
 * An inactive pin (its drawing is gone) is not draggable.
 */
export function WalkSheetOverlay({
  drawings,
  scale,
  now = null,
  preview = null,
  size,
  onPinDrag,
  onPinDragEnd,
  toImage,
}: {
  drawings: readonly WalkDrawing[];
  scale: number;
  now?: WalkNow | null;
  /** The shape being placed under the pointer (ghost, live line, or a spot too close). */
  preview?: SheetPreview | null;
  /** The picture's size: dragged pins stay on it. */
  size?: { width: number; height: number } | undefined;
  onPinDrag?: ((layerId: string, i: number, px: Px, role: PinRole) => void) | undefined;
  onPinDragEnd?: ((layerId: string, i: number, px: Px, role: PinRole) => void) | undefined;
  toImage?: ((clientX: number, clientY: number, from: Element) => Px) | undefined;
}) {
  const t = useT();
  const k = 1 / (Number.isFinite(scale) && scale > 0 ? scale : 1);
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{
    id: number;
    layer: string;
    index: number;
    role: PinRole;
    last: Px | null;
  } | null>(null);
  const draggable = onPinDrag !== undefined && toImage !== undefined;

  // the path and stills: rebuilt only when the drawings change, never on a zoom
  const paths = useMemo(
    () =>
      drawings.map((d) => (
        <g
          key={d.id}
          data-testid="walk-drawing"
          data-walk={d.id}
          opacity={d.placing ? undefined : DIM}
        >
          {d.stills.length > 0 && (
            <path
              className="walk-stills"
              data-testid="walk-stills"
              d={dotsOf(d.stills)}
              stroke={d.colour}
              strokeWidth={STILL_PX}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {d.line.map((run, i) => (
            <path
              key={`l${String(i)}`}
              className="walk-line"
              data-testid="walk-line"
              d={pathOf(run.pts)}
              stroke={d.colour}
              strokeWidth={LINE_PX}
              vectorEffect="non-scaling-stroke"
              {...(run.dashed ? { strokeDasharray: DASH } : {})}
            />
          ))}
        </g>
      )),
    [drawings],
  );

  const clamp = (px: Px): Px =>
    size
      ? [Math.min(size.width, Math.max(0, px[0])), Math.min(size.height, Math.max(0, px[1]))]
      : px;

  const pinHandlers = (layer: string, index: number, role: PinRole) =>
    draggable
      ? {
          onPointerDown: (e: ReactPointerEvent<SVGGElement>) => {
            if (e.button !== 0) return;
            // the picture under the pin does not pan or pick
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { id: e.pointerId, layer, index, role, last: null };
          },
          onPointerMove: (e: ReactPointerEvent<SVGGElement>) => {
            const d = drag.current;
            if (d?.id !== e.pointerId) return;
            // the picture under the handle sees no hover while it is dragged
            e.stopPropagation();
            const px = toImage(e.clientX, e.clientY, e.currentTarget);
            if (!px.every(Number.isFinite)) return;
            d.last = clamp(px);
            onPinDrag(d.layer, d.index, d.last, d.role);
          },
          onPointerUp: (e: ReactPointerEvent<SVGGElement>) => {
            const d = drag.current;
            if (d?.id !== e.pointerId) return;
            drag.current = null;
            if (d.last) onPinDragEnd?.(d.layer, d.index, d.last, d.role);
          },
          onPointerCancel: () => {
            drag.current = null;
          },
        }
      : {};

  return (
    <svg className="walk-overlay" data-testid="walk-overlay" aria-hidden="true">
      {paths}
      {preview && preview.pts.length > 1 && (
        <path
          className="walk-line walk-preview"
          data-testid="walk-preview"
          data-ghost={preview.ghost ? 'true' : 'false'}
          data-too-close={preview.tooClose ? 'true' : 'false'}
          d={pathOf(preview.pts)}
          stroke="var(--acc)"
          strokeWidth={LINE_PX}
          vectorEffect="non-scaling-stroke"
          opacity={preview.ghost ? GHOST_OPACITY : undefined}
          {...(preview.ghost || preview.tooClose ? { strokeDasharray: DASH } : {})}
        />
      )}
      {now && (
        <g
          className="walk-now"
          data-testid="walk-now"
          data-walk={now.id}
          transform={`translate(${num(now.at[0])} ${num(now.at[1])}) rotate(${num((now.headingRad * 180) / Math.PI)}) scale(${num(k)})`}
        >
          <line x1="0" y1="0" x2="14" y2="0" stroke={now.colour} />
          <circle r="5" fill={now.colour} />
        </g>
      )}
      {drawings.map((d) => {
        if (d.pins.length === 0) return null;
        // the pin under the pointer is drawn last, above the others
        const pins = [...d.pins].sort(
          (a, b) =>
            Number(hover === `${d.id}:${String(a.index)}`) -
            Number(hover === `${d.id}:${String(b.index)}`),
        );
        return (
          <g key={`${d.id}-pins`} style={{ color: d.colour }}>
            {pins.map((p) => {
              const key = `${d.id}:${String(p.index)}`;
              const canDrag = draggable && p.active;
              const handle = p.role !== 'pin';
              const label = p.role === 'start' ? 'Start' : 'End';
              return (
                <g
                  key={key}
                  className={[
                    'walk-pin',
                    handle ? `walk-handle ${p.role}` : '',
                    p.active ? '' : 'inactive',
                    canDrag ? 'draggable' : '',
                    hover === key ? 'raised' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-testid={handle ? `walk-handle-${p.role}` : 'walk-pin'}
                  transform={`translate(${num(p.at[0])} ${num(p.at[1])}) scale(${num(k)})`}
                  onPointerEnter={() => {
                    setHover(key);
                  }}
                  onPointerLeave={() => {
                    setHover((h) => (h === key ? null : h));
                  }}
                  {...(canDrag ? pinHandlers(d.id, p.index, p.role) : {})}
                >
                  {!p.active ? (
                    <title>{t('walk.pin.gone')}</title>
                  ) : (
                    handle && <title>{label}</title>
                  )}
                  <circle r={PIN_R} />
                  {!handle && <text dy="0.35em">{p.n}</text>}
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
