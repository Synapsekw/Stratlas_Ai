import {
  FULL_SPHERE,
  PANO_FOV,
  dragLook,
  parsePanoIndex,
  startLook,
  zoomLook,
  type PanoCoverage,
  type PanoLook,
} from '@aio/engine';
import { Icon, useT } from '@aio/ui';
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useStore } from 'zustand';
import { captureLabel, useCaptureIndex } from './compare';
import { DateBadge } from './DatesOnScreen';
import { fromShared, panoLookLink, toShared } from './lookLink';
import {
  PAIR_MAX_M,
  findPano,
  followCandidates,
  followPano,
  pairPano,
  panoKey,
  panosOf,
  stepPano,
  type PanoAt,
} from './panoPair';
import { createPanoImageView, type PanoImageView, type PanoViewStatus } from './panoView';
import type { Side, SplitPref } from './splitModel';

/*
 * The split's Panoramas pane (timeline T3): one survey date's panorama per side. The left side
 * leads (selected, remembered or first panorama of its date, stepped with its bar); the right side
 * shows the panorama of its date nearest on the ground. A right pane leads itself when it is the
 * only Panoramas pane, or when the left date has no panoramas. Linked panes share one look through
 * `panoLookLink` (panoramas carry their heading, so the shared yaw is a compass bearing).
 */

const START: PanoLook = { yawDeg: 0, pitchDeg: 0, fovDeg: PANO_FOV.start };
const TURN_DEG = 5;
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
function useCoverage(projectId: string | undefined): ReadonlyMap<string, PanoCoverage> {
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

const metres = (m: number) => (m < 10 ? m.toFixed(1) : String(Math.round(m)));
const bearing = (yaw: number) => String(Math.round(((yaw % 360) + 360) % 360) % 360);

type SurfaceStatus = PanoViewStatus | 'no-graphics';

/** The look-around view: the WebGL sphere, drag to look, wheel and keys to turn and zoom. */
function PanoSurface(p: {
  url: string;
  headingDeg: number;
  cov: PanoCoverage | null;
  look: PanoLook;
  label: string;
  onLook: (look: PanoLook) => void;
  onStep?: (dir: 1 | -1) => void;
}) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<PanoImageView | null>(null);
  const live = useRef({ look: p.look, onLook: p.onLook });
  const drag = useRef<{ x: number; y: number } | null>(null);
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
    if (e.key === 'ArrowLeft') next = { ...l, yawDeg: l.yawDeg - TURN_DEG };
    else if (e.key === 'ArrowRight') next = { ...l, yawDeg: l.yawDeg + TURN_DEG };
    else if (e.key === 'ArrowUp') next = { ...l, pitchDeg: Math.min(89, l.pitchDeg + TURN_DEG) };
    else if (e.key === 'ArrowDown') next = { ...l, pitchDeg: Math.max(-89, l.pitchDeg - TURN_DEG) };
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
  const onUp = () => {
    drag.current = null;
    setDragging(false);
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
      className={`fill-col walk-view${dragging ? ' dragging' : ''}`}
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

/**
 * One side of two Panoramas panes. It gets its side's dates, the saved split and the link state
 * from the split (SplitPanes.tsx) and reports the leading panorama through `onPick`.
 */
export function PanoPane(p: {
  side: Side;
  capture: string | undefined;
  otherCapture: string | undefined;
  sides: SplitPref;
  linked: boolean;
  onPick: (key: string) => void;
}) {
  const t = useT();
  const { side, capture, otherCapture, sides, linked, onPick } = p;
  const projectId = useWorkspace((s) => s.project?.id);
  const manifestLayers = useWorkspace((s) => s.project?.manifest.layers);
  const selection = useWorkspace((s) => s.selection);
  const index = useCaptureIndex();
  const coverage = useCoverage(projectId);
  const shared = useStore(panoLookLink, (s) => s.look);

  const leftCapture = side === 'left' ? capture : otherCapture;
  const leftList = useMemo(
    () => panosOf(manifestLayers ?? [], index, leftCapture),
    [manifestLayers, index, leftCapture],
  );
  const list = useMemo(
    () => (side === 'left' ? leftList : panosOf(manifestLayers ?? [], index, capture)),
    [side, leftList, manifestLayers, index, capture],
  );
  // the pane that steps and follows: the left, or a right pane with no Panoramas to follow
  const leads = side === 'left' || sides.left !== 'pano' || leftList.length === 0;
  const leadList = leads ? list : leftList;
  const leadPano = findPano(leadList, sides.pano) ?? leadList[0];
  const leadKey = leadPano ? panoKey(leadPano) : undefined;

  // the right side's "show the nearest anyway", for the left panorama it was asked for
  const [nearestFor, setNearestFor] = useState<string | undefined>(undefined);
  // what the following side may pair: never the lead's own picture under the other date
  const candidates = useMemo(
    () => (leads || !leadPano ? list : followCandidates(list, leadPano, index)),
    [leads, leadPano, list, index],
  );
  const pair = !leads && leadPano ? pairPano(leadPano.pano, candidates) : null;
  let shown: PanoAt | undefined;
  if (leads) shown = leadPano;
  else if (pair && (pair.within || nearestFor === leadKey)) shown = pair.at;
  const shownKey = shown ? panoKey(shown) : undefined;
  const cov = shown ? (coverage.get(shown.pano.id) ?? null) : null;
  const start = shown ? startLook(shown.pano.headingDeg, cov ?? FULL_SPHERE) : START;

  // unlinked: a look of its own, back to the panorama's start when the panorama changes
  const [local, setLocal] = useState<{ key: string | undefined; look: PanoLook } | null>(null);
  const look = linked
    ? fromShared(shared, 0)
    : local && local.key === shownKey
      ? local.look
      : start;
  const onLook = (next: PanoLook) => {
    if (linked) panoLookLink.getState().set(toShared(next, 0));
    else setLocal({ key: shownKey, look: next });
  };

  // linked: the first panorama of the split sets where both look
  const seeded = useRef(false);
  const startYaw = start.yawDeg;
  const startPitch = start.pitchDeg;
  useEffect(() => {
    if (!leads || !linked || !shownKey || seeded.current) return;
    seeded.current = true;
    panoLookLink
      .getState()
      .set(toShared({ yawDeg: startYaw, pitchDeg: startPitch, fovDeg: PANO_FOV.start }, 0));
  }, [leads, linked, shownKey, startYaw, startPitch]);

  // what a leading side takes from a selection elsewhere: the left any panorama of the project
  // (its date follows, decision 10), a leading right only those of its own date
  const takes = useMemo(
    () => (side === 'left' ? panosOf(manifestLayers ?? [], index, undefined) : list),
    [side, manifestLayers, index, list],
  );

  // the leading side keeps its spot when its date changes, unless the new panorama was chosen too
  const live = useRef({ onPick, shown, list, pano: sides.pano, takes });
  useEffect(() => {
    live.current = { onPick, shown, list, pano: sides.pano, takes };
  });
  const followed = useRef<{ capture: string | undefined; at: PanoAt | undefined } | null>(null);
  useEffect(() => {
    const prev = followed.current;
    followed.current = { capture, at: live.current.shown };
    if (!leads || !prev || prev.capture === capture) return;
    const now = live.current;
    if (findPano(now.list, now.pano)) return;
    const next = followPano(prev.at?.pano, now.list);
    if (next) now.onPick(panoKey(next));
  }, [leads, capture]);
  useEffect(() => {
    if (followed.current) followed.current = { capture, at: shown };
  });

  // a panorama selected elsewhere (a 3D marker, the Media screen) after the pane opened goes on
  // the leading side (the left moves to its date; a leading right only takes its own date's)
  const seenSelection = useRef(selection);
  useEffect(() => {
    if (selection === seenSelection.current) return;
    seenSelection.current = selection;
    if (!leads || selection?.kind !== 'pano' || !selection.layer) return;
    const key = `${selection.layer}/${selection.id}`;
    const now = live.current;
    if (now.shown && panoKey(now.shown) === key) return;
    if (findPano(now.takes, key)) now.onPick(key);
  }, [leads, selection]);

  const date = index ? captureLabel(index, capture) : '';
  const common = {
    'data-testid': 'pane-pano',
    'data-side': side,
    'data-capture': capture ?? '',
    'data-pano': shownKey ?? '',
    'data-yaw': look.yawDeg.toFixed(1),
  };

  if (!projectId) return null;
  if (candidates.length === 0)
    return (
      <p className="pane-empty" {...common}>
        {t('pano.compare.noneOnDate', { date })}
      </p>
    );

  const step = (dir: 1 | -1) => {
    const next = stepPano(leadList, leadKey, dir);
    if (next) onPick(panoKey(next));
  };
  const at = leads ? leadList.findIndex((a) => panoKey(a) === leadKey) : -1;
  const badgeLayer = shown?.layer ?? candidates[0]?.layer;
  const distance = !leads && pair && shown ? pair.distanceM : undefined;

  return (
    <div
      className="pane-col"
      {...common}
      {...(distance !== undefined ? { 'data-distance': distance.toFixed(1) } : {})}
    >
      <div className="pane-bar">
        {badgeLayer && <DateBadge layerId={badgeLayer} />}
        {leads && (
          <button
            type="button"
            className="btn icon sm ghost"
            aria-label={t('pano.compare.prev')}
            title={t('pano.compare.prevTip')}
            disabled={leadList.length < 2}
            onClick={() => {
              step(-1);
            }}
          >
            <Icon name="back" size={14} />
          </button>
        )}
        {shown && <span className="mono">{shown.pano.id}</span>}
        {leads && (
          <span className="mono faint">
            {t('pano.compare.count', { n: at + 1, total: leadList.length })}
          </span>
        )}
        {leads && (
          <button
            type="button"
            className="btn icon sm ghost"
            aria-label={t('pano.compare.next')}
            title={t('pano.compare.nextTip')}
            disabled={leadList.length < 2}
            onClick={() => {
              step(1);
            }}
          >
            <Icon name="fwd" size={14} />
          </button>
        )}
        {distance !== undefined && (
          <span className="mono faint">{t('pano.compare.away', { m: metres(distance) })}</span>
        )}
        <span className="grow" />
        {shown && (
          <span className="mono faint">
            {t('pano.compare.heading', { deg: bearing(look.yawDeg) })}
          </span>
        )}
      </div>
      {shown ? (
        <PanoSurface
          url={assetUrl(projectId, shown.pano.src)}
          headingDeg={shown.pano.headingDeg}
          cov={cov}
          look={look}
          label={t('pano.compare.label', { id: shown.pano.id, date })}
          onLook={onLook}
          {...(leads ? { onStep: step } : {})}
        />
      ) : (
        <div className="pane-empty">
          <p>{t('pano.compare.noMatch', { date, m: PAIR_MAX_M })}</p>
          {pair && (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setNearestFor(leadKey);
              }}
            >
              {t('pano.compare.showNearest', { m: metres(pair.distanceM) })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
