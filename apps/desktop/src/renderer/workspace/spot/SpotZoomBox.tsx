import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { FIT, panBy, viewCss, ZOOM, zoomAt, type ZoomLinkState, type ZoomView } from './spotZoom';

/**
 * A box whose picture zooms and pans with the linked view: wheel about the pointer, drag to pan,
 * double click, `0` or `F` to fit, `+` and `-` about the centre. The arrow keys, `C` and Esc are
 * left to the viewer. Both sides of Compare use one link, so they move together. At fit a drag is
 * left alone, so in Swipe it moves the divider; zoomed, it pans.
 */
export function SpotZoom(p: {
  link: StoreApi<ZoomLinkState>;
  side: 'left' | 'right';
  children: ReactNode;
}) {
  const view = useStore(p.link, (st) => st.view);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const set = (v: ZoomView) => {
    p.link.getState().set(v);
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // the wheel zooms and must not scroll the dialog behind it
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = r.width > 0 ? (e.clientX - r.left) / r.width - 0.5 : 0;
      const py = r.height > 0 ? (e.clientY - r.top) / r.height - 0.5 : 0;
      const factor = e.deltaY < 0 ? ZOOM.step : 1 / ZOOM.step;
      p.link.getState().set(zoomAt(p.link.getState().view, factor, px, py));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [p.link]);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    // at fit there is nothing to pan: the drag belongs to the swipe divider
    if (e.button !== 0 || p.link.getState().view.s <= ZOOM.min) return;
    e.stopPropagation();
    if (typeof e.currentTarget.setPointerCapture === 'function')
      e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    const r = box.current?.getBoundingClientRect();
    if (!from || !r || r.width === 0 || r.height === 0) return;
    e.stopPropagation();
    set(
      panBy(
        p.link.getState().view,
        (e.clientX - from.x) / r.width,
        (e.clientY - from.y) / r.height,
      ),
    );
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onUp = () => {
    drag.current = null;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const v = p.link.getState().view;
    if (e.key === '+' || e.key === '=') set(zoomAt(v, ZOOM.step, 0, 0));
    else if (e.key === '-') set(zoomAt(v, 1 / ZOOM.step, 0, 0));
    else if (e.key === '0' || e.key === 'f' || e.key === 'F') set(FIT);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={box}
      className={`spot-zoom${view.s > 1 ? ' zoomed' : ''}`}
      tabIndex={0}
      data-testid={`spot-zoom-${p.side}`}
      data-scale={view.s.toFixed(2)}
      data-x={view.x.toFixed(3)}
      data-y={view.y.toFixed(3)}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => {
        set(FIT);
      }}
      onKeyDown={onKey}
    >
      <div className="spot-zoom-pic" style={{ transform: viewCss(view) }}>
        {p.children}
      </div>
    </div>
  );
}
