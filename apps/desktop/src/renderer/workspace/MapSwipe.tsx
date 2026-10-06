/**
 * Swipe and blend of two survey dates (M8 C2, REV-3). While Compare dates shows two maps or two
 * orthos, a small bar offers **Side by side**, **Swipe** and **Blend**: in Swipe both date panes
 * fill the stage, the later one on top, shown right of a divider the person drags; in Blend the
 * later one fades over the earlier with a slider. The two panes stay linked, so they line up.
 * Also the legends of the change heat maps on show (`ChangeLegends`, `ChangeLegend`).
 *
 * Self-contained: `CompareViewControls` sits on C1's `COMPARE_TOOLS` mount point beside Compare
 * dates (registered in `m8Mounts.tsx`) and works on the stage panes through attributes and CSS
 * variables (`mapSwipe.css`), so neither the stage nor the split model changes.
 */
import {
  blendOpacity,
  clampSwipe,
  defaultLegend,
  isChangeHeatMap,
  legendGradient,
  legendTicks,
  parseChangeLegend,
  stepValue,
  swipeAt,
  swipeClip,
  type ChangeLegend as Legend,
  type CompareView,
} from '@aio/maps';
import type { Layer } from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import './mapSwipe.css';
import type { SplitModel } from './SplitPanes';

export interface CompareViewState {
  view: CompareView;
  /** Divider position, 0 (left) to 1 (right). */
  at: number;
  /** Blend, 0 (earlier date) to 1 (later date). */
  blend: number;
  set: (next: Partial<Pick<CompareViewState, 'view' | 'at' | 'blend'>>) => void;
}

/** The session's choice (not remembered across restarts: a comparison opens side by side). */
export const useCompareView = create<CompareViewState>()((set) => ({
  view: 'side',
  at: 0.5,
  blend: 0.5,
  set: (next) => {
    set((s) => ({
      ...next,
      at: next.at === undefined ? s.at : clampSwipe(next.at),
      blend: next.blend === undefined ? s.blend : blendOpacity(next.blend),
    }));
  },
}));

/** Two maps or two orthos of different dates: the views swipe and blend can apply to. */
export function canSwipe(split: SplitModel): boolean {
  const { left, right, leftCapture, rightCapture } = split.sides;
  return (
    left === right &&
    (left === 'map' || left === 'raster') &&
    !!split.dates &&
    leftCapture !== undefined &&
    rightCapture !== undefined &&
    leftCapture !== rightCapture
  );
}

/** Put the stage panes in the chosen view (attribute and CSS variables), undone on unmount. */
function useStageView(panes: HTMLElement | null, view: CompareView, at: number, blend: number) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!panes) return;
    const ro = new ResizeObserver(() => {
      setWidth(panes.clientWidth);
    });
    // the observer reports the first size at once
    ro.observe(panes);
    return () => {
      ro.disconnect();
    };
  }, [panes]);
  useLayoutEffect(() => {
    if (!panes) return;
    if (view === 'side') panes.removeAttribute('data-compare-view');
    else panes.setAttribute('data-compare-view', view);
    panes.style.setProperty('--compare-clip', swipeClip(at, width).clipPath);
    panes.style.setProperty('--compare-blend', String(blendOpacity(blend)));
  }, [panes, view, at, blend, width]);
  useEffect(
    () => () => {
      if (!panes) return;
      panes.removeAttribute('data-compare-view');
      panes.style.removeProperty('--compare-clip');
      panes.style.removeProperty('--compare-blend');
    },
    [panes],
  );
  return width;
}

/**
 * The Side by side, Swipe and Blend bar with the divider and the blend slider, drawn over the
 * stage panes. Renders nothing unless two maps or two orthos of two dates are shown.
 */
export function CompareViewControls({ split }: { split: SplitModel }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [panes, setPanes] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    // the bar's anchor sits in the stage toolbar, beside the panes
    setPanes(
      anchor.current?.closest<HTMLElement>('.stage')?.querySelector<HTMLElement>('.stage-panes') ??
        null,
    );
  }, []);
  const on = canSwipe(split);
  return (
    <>
      <span ref={anchor} hidden />
      {on && panes && <CompareViewBar panes={panes} split={split} />}
    </>
  );
}

function CompareViewBar({ panes, split }: { panes: HTMLElement; split: SplitModel }) {
  const t = useT();
  const { view, at, blend, set } = useCompareView();
  const width = useStageView(panes, view, at, blend);
  const drag = useRef<number | null>(null);
  // leaving the comparison puts the stage back side by side
  useEffect(
    () => () => {
      useCompareView.getState().set({ view: 'side' });
    },
    [],
  );
  const choose = (v: CompareView) => {
    // swiped or blended views must move together
    if (v !== 'side' && split.sides.unlinked) split.set({ ...split.sides, unlinked: false });
    set({ view: v });
  };
  const views: [CompareView, 'imgChange.side' | 'imgChange.swipe' | 'imgChange.blend'][] = [
    ['side', 'imgChange.side'],
    ['swipe', 'imgChange.swipe'],
    ['blend', 'imgChange.blend'],
  ];
  return createPortal(
    <>
      <div className="compare-view overlay-box" data-surface="dark" data-testid="compare-view">
        <div className="seg" role="group" aria-label={t('imgChange.view')}>
          {views.map(([v, key]) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              data-testid={`compare-view-${v}`}
              onClick={() => {
                choose(v);
              }}
            >
              {t(key)}
            </button>
          ))}
        </div>
        {view === 'blend' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="faint">{t('imgChange.earlier')}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(blend * 100)}
              aria-label={t('imgChange.blendAmount')}
              data-testid="compare-blend"
              onChange={(e) => {
                set({ blend: Number(e.target.value) / 100 });
              }}
            />
            <span className="faint">{t('imgChange.later')}</span>
          </label>
        )}
      </div>
      {view === 'swipe' && (
        <div
          className="compare-divider"
          role="slider"
          tabIndex={0}
          aria-label={t('imgChange.divider')}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(at * 100)}
          data-testid="compare-divider"
          style={{ left: swipeClip(at, width).hiddenPx }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = e.pointerId;
          }}
          onPointerMove={(e) => {
            if (drag.current !== e.pointerId) return;
            set({ at: swipeAt(e.clientX, panes.getBoundingClientRect()) });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(e) => {
            const next = stepValue(at, e.key, e.shiftKey);
            if (next === null) return;
            e.preventDefault();
            set({ at: next });
          }}
        >
          <span>
            <Icon name="back" size={12} />
          </span>
        </div>
      )}
      {split.sides.left === 'map' && <ChangeLegends />}
    </>,
    panes,
  );
}

type RasterLayer = Extract<Layer, { kind: 'raster' }>;

/** A heat map's legend, read from its tile index (the pipeline's colours). */
function useLegend(projectId: string | undefined, layer: RasterLayer): Legend | null {
  const [legend, setLegend] = useState<Legend | null>(null);
  const path = 'path' in layer.src ? layer.src.path : null;
  useEffect(() => {
    if (!projectId || !path) return;
    let live = true;
    fetch(assetUrl(projectId, { path }))
      .then((r) => (r.ok ? r.json() : null))
      .then((json: unknown) => {
        if (!live) return;
        setLegend(parseChangeLegend(json) ?? defaultLegend('score'));
      })
      .catch(() => {
        if (live) setLegend(null);
      });
    return () => {
      live = false;
    };
  }, [projectId, path]);
  return legend;
}

/** The legend of one change heat map: its label, the colour bar and its ends in metres or %. */
export function ChangeLegend({ layer }: { layer: RasterLayer }) {
  const t = useT();
  const projectId = useWorkspace((s) => s.project?.id);
  const legend = useLegend(projectId, layer);
  if (!legend) return null;
  return (
    <div
      className="change-legend overlay-box"
      data-surface="dark"
      data-testid="change-legend"
      data-layer={layer.id}
      role="img"
      aria-label={t('imgChange.legend', { name: layer.name })}
    >
      <span>{legend.label}</span>
      <div className="bar" style={{ background: legendGradient(legend) }} />
      <div className="ticks">
        {legendTicks(legend).map((tick) => (
          <span key={tick.value}>{tick.text}</span>
        ))}
      </div>
    </div>
  );
}

/** Legends of the visible change heat maps (the first one; they share a scale per kind). */
export function ChangeLegends() {
  const layer = useWorkspace((s) =>
    s.project?.manifest.layers.find((l) => isChangeHeatMap(l) && l.visible),
  );
  return layer && isChangeHeatMap(layer) ? <ChangeLegend layer={layer} /> : null;
}
