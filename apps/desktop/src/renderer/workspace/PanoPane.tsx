import { FULL_SPHERE, PANO_FOV, startLook, type PanoLook } from '@aio/engine';
import { wrap360 } from '@aio/geo';
import { Icon, useT } from '@aio/ui';
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { usePanoPick } from './panoPickHook';
import { PanoSurface, metres, panoFrame, useCoverage } from './panoSurface';
import type { Side, SplitPref } from './splitModel';

/*
 * The split's Panoramas pane (timeline T3): one survey date's panorama per side. The left side
 * leads (selected, remembered or first panorama of its date, stepped with its bar); the right side
 * shows the panorama of its date nearest on the ground. A right pane leads itself when it is the
 * only Panoramas pane, or when the left date has no panoramas. Linked panes share one look through
 * `panoLookLink` (panoramas carry their heading, so the shared yaw is a compass bearing).
 */

const START: PanoLook = { yawDeg: 0, pitchDeg: 0, fovDeg: PANO_FOV.start };
const bearing = (yaw: number) => String(Math.round(((yaw % 360) + 360) % 360) % 360);

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
  const pick = usePanoPick();

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
  // the compiler keeps the frame stable between renders, so the surface does not reload the image
  const frame = shown ? panoFrame(shown.pano, coverage) : null;
  const start = frame ? startLook(frame.headingDeg, frame.cov ?? FULL_SPHERE) : START;

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

  // the same panorama getting a new heading (a line-up saved one): turn the compass look with it so
  // the picture stays still under the view; a different panorama is not a heading change
  const headingNow = frame?.headingDeg;
  const prevHeading = useRef<{ key: string | undefined; deg: number | undefined }>({
    key: shownKey,
    deg: headingNow,
  });
  const ownLook = linked || local?.key === shownKey;
  const lookNow = useRef({ look, onLook, ownLook });
  useEffect(() => {
    lookNow.current = { look, onLook, ownLook };
  });
  useEffect(() => {
    const prev = prevHeading.current;
    prevHeading.current = { key: shownKey, deg: headingNow };
    if (!shownKey || prev.key !== shownKey || prev.deg === undefined || headingNow === undefined)
      return;
    const delta = headingNow - prev.deg;
    if (Math.abs(delta) < 1e-9) return;
    const cur = lookNow.current;
    // an untouched unlinked look is the start look, which already follows the new heading
    if (!cur.ownLook) return;
    cur.onLook({ ...cur.look, yawDeg: wrap360(cur.look.yawDeg + delta) });
  }, [shownKey, headingNow]);

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
          headingDeg={frame?.headingDeg ?? shown.pano.headingDeg}
          cov={frame?.cov ?? null}
          look={look}
          label={t('pano.compare.label', { id: shown.pano.id, date })}
          onLook={onLook}
          {...(leads ? { onStep: step } : {})}
          {...(pick
            ? {
                onPickBearing: (compassDeg: number) => {
                  pick({
                    layerId: shown.layer,
                    panoId: shown.pano.id,
                    offsetDeg: wrap360(compassDeg - (frame?.headingDeg ?? shown.pano.headingDeg)),
                  });
                },
              }
            : {})}
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
