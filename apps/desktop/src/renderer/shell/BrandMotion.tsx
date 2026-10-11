import { QUARTER, quarterBounds } from '@aio/brand';
import { useEffect, useMemo, useRef } from 'react';
import {
  frameAt,
  getMotion,
  motionLength,
  restFrame,
  STROKE,
  type MotionName,
  type PieceFrame,
} from './brandMotionEngine';
import './brandMotion.css';

export type { MotionName };

const BOUNDS = quarterBounds(QUARTER);
/** The square the mark occupies ('4 4 52 52'), so the mark fills whatever box it is given. */
const VIEW_BOX = [BOUNDS.x, BOUNDS.y, BOUNDS.w, BOUNDS.h].join(' ');
/** A single pass that loops rests this long on the mark before it plays again. */
const REPEAT_AFTER = 2400;

/** Settings or the operating system ask for no motion (theme.ts puts both on <html>). */
function reduced(): boolean {
  if (document.documentElement.dataset.motion === 'reduce') return true;
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Put one frame on the paths of a mark: the halo first, then the shape, per piece. */
function draw(svg: SVGSVGElement, pieces: readonly PieceFrame[]): void {
  const halos = svg.querySelectorAll<SVGPathElement>('.bm-halo');
  const shapes = svg.querySelectorAll<SVGPathElement>('.bm-shape');
  pieces.forEach((piece, i) => {
    const halo = halos[i];
    const shape = shapes[i];
    if (!halo || !shape) return;
    const turn = +(piece.rot % 360).toFixed(2);
    const transform =
      turn === 0 ? null : `rotate(${String(turn)} ${String(QUARTER.c)} ${String(QUARTER.c)})`;
    for (const path of [halo, shape]) {
      path.setAttribute('d', piece.d);
      if (transform) path.setAttribute('transform', transform);
      else path.removeAttribute('transform');
    }
    shape.setAttribute('opacity', String(+piece.opacity.toFixed(3)));
    halo.setAttribute('stroke-width', (STROKE + 2 * piece.halo).toFixed(2));
    halo.style.display = piece.halo > 0.02 ? '' : 'none';
  });
}

export interface BrandMotionProps {
  motion: MotionName;
  /** Sizes the mark (`brand-loader`, `lockup-mark`, ...); `bm` is always there. */
  className?: string;
  /** Stand on the mark and do not move. */
  still?: boolean;
  /** Play again and again: a looping motion runs on, a single pass rests between plays. */
  loop?: boolean;
  /** Makes the mark an image with this accessible name; without it the mark is decoration. */
  label?: string;
  /** The first pass has ended, or the mark stands still (`still`, reduced motion). */
  onDone?: () => void;
}

/**
 * The Quarter mark in motion: four pieces, each a group `g[data-piece]` (0 north-west, 1
 * north-east, 2 south-west, 3 the tail) holding a halo path and the shape path. It plays its
 * motion once when it mounts and again when `motion` changes; `loop` keeps it going. The first
 * paint is already the first frame of the motion (Step out: the closed ring), so the finished
 * mark never flashes before its own intro. Where it will not play (`still`, reduced motion) the
 * first paint and every frame after it are the mark itself.
 *
 * The frames are written straight to the paths (`d`, `opacity`, `transform`), never to the
 * groups: a caller may move the groups itself, as the launch screen does. Colours come from the
 * theme through `.mark-piece` and `.mark-tail`.
 */
export function BrandMotion({
  motion,
  className,
  still = false,
  loop = false,
  label,
  onDone,
}: BrandMotionProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  // read through a ref, so a new function does not start the motion again
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });
  // what the mark last stood still for: effects run twice in development (StrictMode), and a
  // still mark says it is done once
  const stoodFor = useRef<string | null>(null);
  // decided while rendering, so the markup itself starts right: the first frame of the motion
  // where it will play, the mark where it will not
  const plays = !still && !reduced();
  const first = useMemo(
    () => (plays ? frameAt(getMotion(motion), 0).pieces : restFrame()),
    [motion, plays],
  );

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const rest = restFrame();
    const key = `${motion}|${String(loop)}`;
    if (!plays) {
      draw(svg, rest);
      if (stoodFor.current !== key) {
        stoodFor.current = key;
        onDoneRef.current?.();
      }
      return;
    }
    stoodFor.current = null;

    const m = getMotion(motion);
    const length = motionLength(m);
    const endless = m.loops && loop;
    // from the first frame, whatever an earlier motion left on the paths (a turn, a halo)
    draw(svg, frameAt(m, 0).pieces);
    let raf = 0;
    /** Time of the motion's first frame; unknown until a frame comes, and again after a pause. */
    let start: number | null = null;
    /** How far into the motion the last frame was. */
    let elapsed = 0;
    let ended = false;
    let said = false;
    const finish = () => {
      ended = true;
      draw(svg, rest);
      if (!said) onDoneRef.current?.();
      said = true;
    };
    const tick = (now: number) => {
      raf = 0;
      // a hidden window gets no frames; visibilitychange picks the motion up again
      if (document.hidden) {
        start = null;
        return;
      }
      if (document.documentElement.dataset.motion === 'reduce') {
        // the next render finds the mark standing still: it has said so already
        stoodFor.current = key;
        finish();
        return;
      }
      start ??= now - elapsed;
      elapsed = now - start;
      if (endless || elapsed < length) draw(svg, frameAt(m, elapsed).pieces);
      else {
        if (!ended) finish();
        if (!loop) return;
        if (elapsed >= length + REPEAT_AFTER) {
          start = now;
          elapsed = 0;
          ended = false;
          draw(svg, frameAt(m, 0).pieces);
        }
      }
      raf = window.requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (raf) window.cancelAnimationFrame(raf);
        raf = 0;
        start = null;
      } else if (!raf && (loop || !ended)) raf = window.requestAnimationFrame(tick);
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) raf = window.requestAnimationFrame(tick);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [motion, plays, loop]);

  return (
    <svg
      ref={svgRef}
      className={className ? `bm ${className}` : 'bm'}
      viewBox={VIEW_BOX}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {first.map((piece, i) => (
        <g key={i} data-piece={i}>
          <path
            className="bm-halo"
            d={piece.d}
            strokeWidth={STROKE}
            strokeLinejoin="round"
            style={{ display: 'none' }}
          />
          <path
            className={i === 3 ? 'bm-shape mark-tail' : 'bm-shape mark-piece'}
            d={piece.d}
            strokeWidth={STROKE}
            strokeLinejoin="round"
          />
        </g>
      ))}
    </svg>
  );
}

/** The loader: the mark turning a quarter at a time, for as long as the work takes. */
export function BrandLoader(props: { className?: string; label?: string }) {
  return <BrandMotion motion="turns" loop {...props} />;
}
