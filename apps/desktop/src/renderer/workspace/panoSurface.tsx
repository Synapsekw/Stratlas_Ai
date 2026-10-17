import {
  dragLook,
  imageCentreDeg,
  itemCoverage,
  parsePanoIndex,
  zoomLook,
  type PanoCoverage,
  type PanoLook,
} from '@aio/engine';
import { lookClickBearingDeg } from '@aio/geo';
import { useT } from '@aio/ui';
import { assetUrl } from '@aio/workspace';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPanoImageView, type PanoImageView, type PanoViewStatus } from './panoView';

/*
 * The look-around surface shared by the split's Panoramas pane and the spot viewer: the WebGL
 * sphere with drag, wheel and key controls, and the partial coverage of a project's panoramas.
 */

const TURN_DEG = 5;
const PICK_SLOP_PX = 4;
const EMPTY_COVERAGE: ReadonlyMap<string, PanoCoverage> = new Map();

/** Partial coverage from `panoramas/panoramas.json`, read once per project (missing: none). */
const coverageCache = new Map<string, Promise<ReadonlyMap<string, PanoCoverage>>>();
function loadCoverage(projectId: string): Promise<ReadonlyMap<string, PanoCoverage>> {
  let p = coverageCache.get(projectId);
  if (!p) {
    p = Promise.resolve()
      .then(() => fetch(assetUrl(projectId, { path: 'panoramas/panoramas.json' })))
      .then(async (res) => (res.ok ? parsePanoIndex(await res.json()) : EMPTY_COVERAGE))
      .catch(() => EMPTY_COVERAGE);
    coverageCache.set(projectId, p);
  }
  return p;
}
export function useCoverage(projectId: string | undefined): ReadonlyMap<string, PanoCoverage> {
  const [got, setGot] = useState<{ id: string; map: ReadonlyMap<string, PanoCoverage> } | null>(
    null,
  );
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    void loadCoverage(projectId).then((map) => {
      if (live) setGot({ id: projectId, map });
    });
    return () => {
      live = false;
    };
  }, [projectId]);
  return got && got.id === projectId ? got.map : EMPTY_COVERAGE;
}

/**
 * What a panorama shows and where its image centre looks: the item's own `cov` (the stitcher's
 * coverage, a wide panorama's yaw range included) wins, `panoramas.json` is the fallback, as in
 * the 3D view. `headingDeg` is the north correction, moved to the centre of a wide panorama.
 */
export function panoFrame(
  pano: {
    id: string;
    headingDeg: number;
    cov?:
      | { top: number; bottom: number; left?: number | undefined; right?: number | undefined }
      | undefined;
  },
  fromFile: ReadonlyMap<string, PanoCoverage>,
): { headingDeg: number; cov: PanoCoverage | null } {
  return {
    headingDeg: imageCentreDeg(pano.headingDeg, pano.cov),
    cov: itemCoverage(pano.cov) ?? fromFile.get(pano.id) ?? null,
  };
}

/** A distance for the words: one decimal below 10 m, whole metres above. */
export const metres = (m: number) => (m < 10 ? m.toFixed(1) : String(Math.round(m)));

export type SurfaceStatus = PanoViewStatus | 'no-graphics';

/** The look-around view: the WebGL sphere, drag to look, wheel and keys to turn and zoom. */
export function PanoSurface(p: {
  url: string;
  headingDeg: number;
  cov: PanoCoverage | null;
  look: PanoLook;
  label: string;
  onLook: (look: PanoLook) => void;
  onStep?: (dir: 1 | -1) => void;
  /** Arrow keys turn the view (default true); off where the arrows step something else. */
  arrowKeys?: boolean;
  /** Opt-in landmark click: the compass bearing of a click that is not a drag. */
  onPickBearing?: (compassDeg: number) => void;
}) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<PanoImageView | null>(null);
  const live = useRef({ look: p.look, onLook: p.onLook });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const [status, setStatus] = useState<SurfaceStatus>('loading');
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    live.current = { look: p.look, onLook: p.onLook };
  });
  const turn = (next: PanoLook) => {
    live.current = { ...live.current, look: next };
    live.current.onLook(next);
  };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let v: PanoImageView | null = null;
    try {
      v = createPanoImageView(el, live.current.look, setStatus);
      view.current = v;
    } catch {
      queueMicrotask(() => {
        setStatus('no-graphics');
      });
    }
    // the wheel zooms the view and must not scroll the page behind it
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      turn(zoomLook(live.current.look, e.deltaY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      v?.dispose();
      view.current = null;
    };
  }, []);

  const { url, headingDeg, cov } = p;
  useEffect(() => {
    view.current?.setImage(url, headingDeg, cov);
  }, [url, headingDeg, cov]);

  const { yawDeg, pitchDeg, fovDeg } = p.look;
  useEffect(() => {
    view.current?.setLook({ yawDeg, pitchDeg, fovDeg });
  }, [yawDeg, pitchDeg, fovDeg]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const l = live.current.look;
    let next: PanoLook | null = null;
    const arrows = p.arrowKeys !== false;
    if (arrows && e.key === 'ArrowLeft') next = { ...l, yawDeg: l.yawDeg - TURN_DEG };
    else if (arrows && e.key === 'ArrowRight') next = { ...l, yawDeg: l.yawDeg + TURN_DEG };
    else if (arrows && e.key === 'ArrowUp')
      next = { ...l, pitchDeg: Math.min(89, l.pitchDeg + TURN_DEG) };
    else if (arrows && e.key === 'ArrowDown')
      next = { ...l, pitchDeg: Math.max(-89, l.pitchDeg - TURN_DEG) };
    else if (e.key === '+' || e.key === '=') next = zoomLook(l, -1);
    else if (e.key === '-') next = zoomLook(l, 1);
    else if ((e.key === 'PageDown' || e.key === 'PageUp') && p.onStep) {
      e.preventDefault();
      e.stopPropagation();
      p.onStep(e.key === 'PageDown' ? 1 : -1);
      return;
    }
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    turn({ ...next, yawDeg: ((next.yawDeg % 360) + 360) % 360 });
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.focus();
    if (typeof e.currentTarget.setPointerCapture === 'function')
      e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
    downAt.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from) return;
    turn(
      dragLook(
        live.current.look,
        e.clientX - from.x,
        e.clientY - from.y,
        e.currentTarget.clientHeight,
      ),
    );
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const down = downAt.current;
    drag.current = null;
    downAt.current = null;
    setDragging(false);
    // a landmark click: released within a few pixels of where it went down (a drag only looks)
    if (!p.onPickBearing || !down || e.type !== 'pointerup') return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > PICK_SLOP_PX) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    p.onPickBearing(
      lookClickBearingDeg(
        live.current.look,
        e.clientX - r.left,
        e.clientY - r.top,
        r.width,
        r.height,
      ),
    );
  };

  const message =
    status === 'missing'
      ? t('pano.compare.missing')
      : status === 'no-graphics'
        ? t('pano.compare.noGraphics')
        : null;

  return (
    <div
      ref={host}
      className={`fill-col walk-view${dragging ? ' dragging' : ''}${p.onPickBearing ? ' aiming' : ''}`}
      {...(p.onPickBearing ? { 'data-picking': 'true' } : {})}
      tabIndex={0}
      role="img"
      aria-label={p.label}
      data-status={status}
      onKeyDown={onKey}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {message && (
        <div className="walk-status" role="status">
          {message}
        </div>
      )}
    </div>
  );
}
