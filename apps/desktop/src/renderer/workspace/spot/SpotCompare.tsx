import { PANO_FOV } from '@aio/engine';
import type { Layer } from '@aio/schema';
import { useT } from '@aio/ui';
import { DEFAULT_PHOTO_LENS, FramesCompare } from '@aio/video';
import type { DateTag } from '@aio/workspace';
import { useState } from 'react';
import { createLookLink } from '../lookLink';
import { SpotMatchView } from './SpotMatchView';
import type { SpotHistory, SpotMatch } from './spotTypes';
import { matchAt, type SpotCompareState } from './spotViewerStore';
import { SpotZoom } from './SpotZoomBox';
import { createZoomLink } from './spotZoom';

/** Width over height of a match's picture (stacked modes keep it so the swipe lines up). */
function aspectOf(layers: readonly Layer[], m: SpotMatch | undefined): number {
  const l = m ? layers.find((x) => x.id === m.item.layer) : undefined;
  if (m?.item.kind === 'photo' && l?.kind === 'photos') {
    const id = m.item.photo;
    return l.items.find((p) => p.id === id)?.lens?.aspect ?? DEFAULT_PHOTO_LENS.aspect;
  }
  if (l?.kind === 'video') return l.lens.aspect;
  return 16 / 9;
}

/**
 * Two dates of one spot (spec "Compare (B)", inside the viewer: see the plan's deviation 1): the
 * shown match on the left, another date's best on the right, side by side or swiped with
 * `FramesCompare`. 360s and walk frames share one look; photos and video frames share one zoom
 * and pan (founder, 13 Oct 2026), so in Swipe both layers stay over the same ground. The zoom
 * lives as long as Compare: a new mode or date keeps it, the next Compare starts at fit.
 */
export function SpotCompare(p: {
  history: SpotHistory;
  state: SpotCompareState;
  projectId: string;
  layers: readonly Layer[];
  tags: Readonly<Record<string, DateTag>>;
  onChange: (next: SpotCompareState) => void;
}) {
  const t = useT();
  const { history: h, state } = p;
  const left = matchAt(h, state.left);
  const right = matchAt(h, state.right);
  const [look] = useState(() =>
    createLookLink({ yawDeg: left?.lookDeg ?? 0, pitchDeg: 0, fovDeg: PANO_FOV.start }),
  );
  const dated = h.dates.filter((d) => d.matches.length > 0);
  const [zoom] = useState(createZoomLink);
  const view = (m: SpotMatch, side: 'left' | 'right') => {
    const shown = (
      <SpotMatchView
        projectId={p.projectId}
        layers={p.layers}
        match={m}
        look={look}
        playable={false}
      />
    );
    return m.kind === 'pano' || m.kind === 'walk' ? (
      shown
    ) : (
      <SpotZoom link={zoom} side={side}>
        {shown}
      </SpotZoom>
    );
  };
  const chip = (side: 'left' | 'right') => (
    <select
      className="spot-chip"
      aria-label={t(side === 'left' ? 'spot.compare.left' : 'spot.compare.right')}
      data-testid={`spot-compare-date-${side}`}
      value={(side === 'left' ? state.left : state.right)?.capture ?? ''}
      onChange={(e) => {
        const at = { capture: e.target.value, i: 0 };
        p.onChange(side === 'left' ? { ...state, left: at } : { ...state, right: at });
      }}
    >
      {dated.map((d) => (
        <option key={d.capture} value={d.capture}>
          {p.tags[d.capture]?.long ?? d.capture}
        </option>
      ))}
    </select>
  );
  return (
    <div className="spot-compare" data-testid="spot-compare-view" data-mode={state.mode}>
      <div className="spot-compare-bar">
        {chip('left')}
        <div role="group" aria-label={t('spot.compare.modes')} className="spot-modes">
          {(['side', 'swipe'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className="btn sm ghost"
              aria-pressed={state.mode === mode}
              data-testid={`spot-mode-${mode}`}
              onClick={() => {
                p.onChange({ ...state, mode });
              }}
            >
              {t(mode === 'side' ? 'spot.compare.side' : 'spot.compare.swipe')}
            </button>
          ))}
        </div>
        {chip('right')}
      </div>
      {left && (
        <FramesCompare
          className="spot-compare-frames"
          a={view(left, 'left')}
          b={right ? view(right, 'right') : null}
          mode={state.mode}
          amount={state.amount}
          onAmount={(amount) => {
            p.onChange({ ...state, amount });
          }}
          aspect={aspectOf(p.layers, left)}
          labels={{
            a: p.tags[left.capture]?.long ?? left.capture,
            b: right ? (p.tags[right.capture]?.long ?? right.capture) : '',
            handle: t('spot.compare.handle'),
            empty: t('spot.compare.empty'),
          }}
        />
      )}
    </div>
  );
}
