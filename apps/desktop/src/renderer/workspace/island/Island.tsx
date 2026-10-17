/**
 * The stage island (D1 to D10): one capsule at the top centre of the stage. At rest the survey
 * date; near the pointer the date's arrows, the view and Tools; a live reading beside the date;
 * a second live item as a bubble that swaps with it; open, the view switch, the group tabs and a
 * group's quick row. Its size morphs between the states (instant under reduced motion). A group's
 * full set is its workbench in the right sidebar; the island goes back to rest when it opens one.
 */
import { annotateUi } from '@aio/annotate';
import type { EngineStage } from '@aio/engine';
import { announce, Button, Icon, matchShortcut, shortcutHint, useFocusTrap, useT } from '@aio/ui';
import { useVolumetric } from '@aio/volumetric';
import { useWorkspace } from '@aio/workspace';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { isTyping } from '../../keys';
import { useRoad } from '../../road/store';
import { useShell } from '../../shell';
import type { StageMode } from '../../store';
import { CompareButton, useCompareDates } from '../CompareControls';
import { focusedSide, type Side } from '../splitModel';
import { paneCapture, type SplitModel } from '../SplitPanes';
import { takeTNotice } from '../stagePrefs';
import { useTimeline } from '../timeline';
import type { TabId } from '../workbench/tabsModel';
import { MODES, type GroupCtx } from './groups';
import { drawerStore } from '../workbench/drawerStore';
import { liveTab } from '../workbench/view';
import { GROUP_TAB, openBenchFromIsland } from './islandBench';
import { IslandCalendar, IslandDate, islandDates } from './IslandDate';
import { IslandLive, LiveGlyph, liveSay, liveText } from './IslandLive';
import { IslandTools } from './IslandTools';
import {
  islandGroups,
  islandReducer,
  islandRest,
  pickLive,
  type GroupId,
  type IslandState,
} from './islandModel';
import { livePairKey, useIslandLive } from './useIslandLive';
import './island.css';

const INITIAL: IslandState = { open: 'rest', group: 'view', preview: null, swapped: false };
/** The pointer within this many px of the stage's top edge wakes the island. */
const NEAR_PX = 88;
/** The one-time T notice stays this long at most. */
const NOTICE_MS = 8000;
/** Live readings are said at most once a second, and only when what is said changes. */
const SAY_MS = 1000;

const REDUCE = '(prefers-reduced-motion: reduce)';
function subscribeMotion(cb: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const mq = window.matchMedia(REDUCE);
  mq.addEventListener('change', cb);
  return () => {
    mq.removeEventListener('change', cb);
  };
}
const reducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia(REDUCE).matches;

/** Say `text` politely, at most once every SAY_MS (the latest text wins). */
function useSayLive(text: string): void {
  const last = useRef({ at: Number.NEGATIVE_INFINITY, said: '' });
  useEffect(() => {
    if (!text || text === last.current.said) return;
    const wait = last.current.at + SAY_MS - Date.now();
    const say = () => {
      last.current = { at: Date.now(), said: text };
      announce(text);
    };
    if (wait <= 0) {
      say();
      return;
    }
    const timer = setTimeout(say, wait);
    return () => {
      clearTimeout(timer);
    };
  }, [text]);
}

export interface IslandProps {
  stage: EngineStage | null;
  /** The stage view (3D, map or split). */
  mode: StageMode;
  /** The panes the tools work on (a split may show neither the 3D view nor the map). */
  tools: StageMode;
  /** The split stage's sides and dates (the stage's own, not fetched again). */
  split: SplitModel;
  /** The sidebar's front tab is the island's live item (D10). */
  linked: boolean;
}

export function Island({ stage, mode, tools, split, linked }: IslandProps) {
  const t = useT();
  const [s, dispatch] = useReducer(islandReducer, INITIAL);
  const [side, setSide] = useState<Side>('left');
  // the first T on this computer says the timeline moved to View
  const [notice, setNotice] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const capsule = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const dateBox = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const asideRef = useRef<HTMLDivElement>(null);
  // the app's own Reduce motion setting, or the system's
  const osStill = useSyncExternalStore(subscribeMotion, reducedMotion, () => false);
  const appStill = useShell((x) => x.settings.motion === 'reduce');
  const motion = osStill || appStill;

  // which groups the project has data for (D6)
  const map = tools === 'map';
  const pkg = useShell((x) => x.pkg !== null);
  const clouds = useWorkspace((x) =>
    (x.project?.manifest.layers ?? []).some((l) => l.kind === 'pointcloud'),
  );
  const video = useWorkspace((x) =>
    (x.project?.manifest.layers ?? []).some((l) => l.kind === 'video'),
  );
  const volumes = useVolumetric((x) => x.status === 'ready');
  const road = useRoad((x) => x.status === 'ready');
  const groups = islandGroups({ map, mode: tools, clouds, volumes, video, road, pkg });
  const group = groups.includes(s.group) ? s.group : 'view';

  // the date: the date bar's, or the last focused pane's in Split (D7)
  const index = useTimeline((x) => x.index);
  const focus = useTimeline((x) => x.focus);
  const splitting = mode === 'split';
  const dateSide = splitting ? focusedSide(split.sides, side, split.dates) : null;
  const dates = islandDates(index, focus, dateSide ? split : null, dateSide ?? 'left');
  // in Split, Alt+Left / Alt+Right step the pane the date follows, before the app steps the
  // date bar's survey (App.tsx); elsewhere the app's shortcut does it
  const paneStep = useRef<((dir: -1 | 1) => void) | null>(null);
  useEffect(() => {
    paneStep.current = dateSide && dates ? dates.step : null;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = paneStep.current;
      if (!step || e.defaultPrevented || isTyping(e.target)) return;
      const id = matchShortcut('global', e);
      if (id !== 'global.prevSurvey' && id !== 'global.nextSurvey') return;
      e.preventDefault();
      step(id === 'global.prevSurvey' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  const rest = islandRest(dates ? dates.order.length : 0);
  const compareDates = useCompareDates(split);
  const left = splitting ? paneCapture(split, 'left') : undefined;
  const right = splitting ? paneCapture(split, 'right') : undefined;
  const onCompare =
    compareDates.available && !compareDates.twin
      ? () => {
          compareDates.open(left && right && left !== right ? [left, right] : undefined);
        }
      : null;

  // what is live, the top two by priority; a swap lasts as long as its pair (D2, D3)
  const items = useIslandLive();
  const pair = pickLive(items);
  const pairKey = livePairKey(items);
  const seenPair = useRef(pairKey);
  useEffect(() => {
    if (seenPair.current === pairKey) return;
    seenPair.current = pairKey;
    dispatch({ type: 'liveChanged' });
  }, [pairKey]);
  const primary = s.swapped && pair.secondary ? pair.secondary : pair.primary;
  const secondary = s.swapped && pair.secondary ? pair.primary : pair.secondary;
  // the tab the live reading brings back (none for the connection)
  const primaryTab = primary ? liveTab(primary) : null;
  useSayLive(primary ? liveSay(primary) : '');

  const open = s.open === 'tools' || s.open === 'date';
  const expanded = s.open === 'ready';
  const view = `${s.open}:${primary?.kind ?? ''}`;

  // focus handed back on close does not wake the island again
  const returning = useRef(false);
  // Shift+Tab woke the island from a control of the line at rest (onFocus): focus its end
  const wakeToEnd = useRef(false);
  // when Shift+Tab was last pressed: focus it moves is the person's, not a program's
  const shiftTabAt = useRef(-Infinity);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey) shiftTabAt.current = performance.now();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  useLayoutEffect(() => {
    if (!wakeToEnd.current || s.open !== 'ready') return;
    wakeToEnd.current = false;
    const all = layer.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
    all?.[all.length - 1]?.focus();
  }, [s.open]);
  const close = useCallback(() => {
    dispatch({ type: 'escape' });
    returning.current = true;
    root.current?.focus();
    returning.current = false;
  }, []);
  // the island goes back to rest once a tile has opened its panel in the sidebar (D4), focus
  // back on the island rather than lost with the tile
  const done = close;
  const showBench = useCallback(
    (tab: TabId) => {
      openBenchFromIsland(tab);
      done();
    },
    [done],
  );
  // a group tab: the group is picked, and its workbench opens (View has none: its row stays)
  const pickGroup = useCallback(
    (g: GroupId) => {
      dispatch({ type: 'pickGroup', group: g });
      const tab = GROUP_TAB[g];
      if (tab) showBench(tab);
    },
    [showBench],
  );
  const ctx: GroupCtx = { stage, map, openBench: showBench, done, compare: compareDates };

  // size morph: the capsule takes its content's size (CSS animates width and height)
  useLayoutEffect(() => {
    const el = layer.current;
    const box = capsule.current;
    if (!el || !box) return;
    const stageEl = root.current?.parentElement;
    const fit = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      // open, the stage's overlays under it (.stage-under) move below its bottom edge, and below
      // the T notice under it (I-R18)
      // (the capsule is still at its old size here, so the notice is placed by the new height h:
      // its gap above it is the same at every size)
      if (open) {
        const wrap = root.current;
        const top = wrap?.offsetTop ?? 0;
        const note = noticeRef.current;
        const gap = note && wrap ? note.offsetTop - wrap.offsetHeight : 0;
        const bottom = top + h + (note ? gap + note.offsetHeight : 0);
        stageEl?.style.setProperty('--isl-open-b', `${String(bottom)}px`);
      } else stageEl?.style.removeProperty('--isl-open-b');
      if (!w || !h) return;
      box.style.width = `${String(w)}px`;
      box.style.height = `${String(h)}px`;
      box.style.setProperty('--isl-h', `${String(h)}px`);
      box.dataset.sized = '';
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [view, open, notice]);
  useEffect(
    () => () => {
      root.current?.parentElement?.style.removeProperty('--isl-open-b');
    },
    [],
  );
  // what hangs beside the capsule (the bubble, a comparison's controls) and its gap: the line
  // leaves room for it before the right panel's toggle (--isl-aside-w, island.css)
  useEffect(() => {
    const aside = asideRef.current;
    const wrap = root.current;
    if (!aside || !wrap || typeof ResizeObserver === 'undefined') return;
    const write = () => {
      const w = aside.offsetWidth;
      // the aside stands the wrap's gap away from the capsule
      const gap = Number.parseFloat(getComputedStyle(wrap).columnGap) || 0;
      wrap.style.setProperty('--isl-aside-w', `${String(w > 0 ? w + gap : 0)}px`);
    };
    write();
    const ro = new ResizeObserver(write);
    ro.observe(aside);
    return () => {
      ro.disconnect();
    };
  }, []);

  // the pointer near the top of the stage wakes the island
  useEffect(() => {
    const stageEl = root.current?.parentElement;
    if (!stageEl) return;
    const onMove = (e: PointerEvent) => {
      if (root.current?.contains(e.target as Node)) return;
      const top = stageEl.getBoundingClientRect().top;
      if (e.clientY - top < NEAR_PX) dispatch({ type: 'near' });
      // keyboard focus on a control of the open line keeps it
      else if (!layer.current?.contains(document.activeElement)) dispatch({ type: 'leave' });
    };
    const onLeave = () => {
      if (!layer.current?.contains(document.activeElement)) dispatch({ type: 'leave' });
    };
    // the last focused pane of a split, for the date (D7)
    const onPane = (e: Event) => {
      const pane = e.target instanceof Element ? e.target.closest('[data-side]') : null;
      const at = pane?.getAttribute('data-side');
      if (at === 'left' || at === 'right') setSide(at);
    };
    stageEl.addEventListener('pointermove', onMove);
    stageEl.addEventListener('pointerleave', onLeave);
    stageEl.addEventListener('pointerdown', onPane, true);
    stageEl.addEventListener('focusin', onPane);
    return () => {
      stageEl.removeEventListener('pointermove', onMove);
      stageEl.removeEventListener('pointerleave', onLeave);
      stageEl.removeEventListener('pointerdown', onPane, true);
      stageEl.removeEventListener('focusin', onPane);
    };
  }, []);

  // T opens the tools (D9); the video annotator and a pending annotation keep their keys
  const state = useRef(s.open);
  useLayoutEffect(() => {
    state.current = s.open;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (annotateUi.getState().pending) return;
      if (e.target instanceof Element && e.target.closest('.vwin')) return;
      if (matchShortcut('scene', e) !== 'scene.tools') return;
      e.preventDefault();
      const opening = state.current !== 'tools';
      dispatch({ type: 'toggleTools' });
      // said on a T that opens the tools, where it can be read
      if (opening && takeTNotice()) setNotice(true);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // the notice goes with the tools, or after a while
  if (notice && s.open !== 'tools') setNotice(false);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => {
      setNotice(false);
    }, NOTICE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);

  // open: focus goes to the picked tab; a press outside closes
  useEffect(() => {
    if (s.open === 'tools')
      root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [s.open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el || root.current?.contains(el) || el.closest('.surface-pop')) return;
      dispatch({ type: 'escape' });
    };
    window.addEventListener('pointerdown', away);
    return () => {
      window.removeEventListener('pointerdown', away);
    };
  }, [open]);
  // the calendar keeps Tab inside and gives focus back to the island
  useFocusTrap(dateBox, s.open === 'date', { onEscape: close });

  const modeInfo = MODES.find((m) => m.mode === mode) ?? MODES[0];
  const steps = open || expanded;

  let content: ReactNode;
  if (s.open === 'tools') {
    content = (
      <IslandTools
        mode={mode}
        groups={groups}
        group={group}
        preview={s.preview}
        ctx={ctx}
        dispatch={dispatch}
        onPick={pickGroup}
        onClose={close}
      />
    );
  } else if (s.open === 'date' && dates) {
    content = (
      <div ref={dateBox} role="dialog" aria-label={t('datebar.label')}>
        <IslandCalendar dates={dates} onDone={close} onCompare={onCompare} />
      </div>
    );
  } else {
    content = (
      <div className={`isl-line${expanded ? ' ready' : ''}`}>
        {dates && rest !== 'dots' ? (
          <IslandDate
            dates={dates}
            steps={steps && rest === 'dateSteps'}
            onOpen={() => {
              dispatch({ type: 'openDate' });
            }}
          />
        ) : (
          !primary && (
            <span className="isl-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          )
        )}
        {primary && (
          <>
            {dates && rest !== 'dots' && <span className="isl-sep" aria-hidden="true" />}
            {primaryTab ? (
              // a button, so Enter and Space bring the tab back as a click does (D10, I-R44)
              <button
                type="button"
                className="isl-live-open"
                aria-label={t('island.liveOpen', { item: liveText(primary) })}
                onClick={() => {
                  openBenchFromIsland(primaryTab);
                }}
                onKeyDown={(e) => {
                  // Space on a plain button is the app's play and pause (keys.ts): this one opens
                  if (e.key !== ' ') return;
                  e.preventDefault();
                  e.stopPropagation();
                  openBenchFromIsland(primaryTab);
                }}
              >
                <IslandLive item={primary} />
              </button>
            ) : (
              <IslandLive item={primary} />
            )}
          </>
        )}
        {expanded && (
          <>
            <span className="isl-sep" aria-hidden="true" />
            <Button
              variant="quiet"
              className="isl-open"
              aria-label={t('island.tools')}
              tip={t('island.tools')}
              shortcut="scene.tools"
              aria-expanded={false}
              onClick={() => {
                dispatch({ type: 'toggleTools' });
              }}
            >
              <Icon name={modeInfo?.icon ?? 'scene'} size={14} className="isl-acc" />
              <span className="isl-mode">{modeInfo && t(modeInfo.label)}</span>
              <span className="isl-name">{t('island.tools')}</span>
              <Icon name="chevdown" size={12} />
              <span className="kbd" aria-hidden="true">
                {shortcutHint('scene.tools')}
              </span>
            </Button>
          </>
        )}
      </div>
    );
  }

  const isLinked = linked && !open && primary !== null && primary.kind !== 'connection';
  return (
    <div
      ref={root}
      className="island-wrap"
      role="toolbar"
      aria-label={t('island.label')}
      data-surface="dark"
      data-state={s.open}
      data-linked={isLinked ? '' : undefined}
      data-motion={motion ? 'reduce' : undefined}
      tabIndex={open ? -1 : 0}
      onPointerMove={() => {
        dispatch({ type: 'near' });
      }}
      onFocus={(e) => {
        if (returning.current) return;
        if (layer.current?.contains(e.target)) {
          // focus that lands straight on a control of the line at rest (the live reading, the
          // date) keeps it: waking would draw the line again without that control (I-R44).
          // Shift+Tab from after the island lands there too: it wakes, and focus goes on to the
          // woken line's last control, as Shift+Tab would reach it (T20 M7)
          const from = e.relatedTarget;
          const back = performance.now() - shiftTabAt.current < 500;
          if (
            back &&
            s.open === 'rest' &&
            from instanceof Node &&
            !e.currentTarget.contains(from)
          ) {
            wakeToEnd.current = true;
            dispatch({ type: 'near' });
          }
          return;
        }
        dispatch({ type: 'near' });
      }}
      onBlur={(e) => {
        // the line at rest leaving for the woken one takes its focused control with it
        if (wakeToEnd.current) return;
        if (!e.currentTarget.contains(e.relatedTarget)) dispatch({ type: 'leave' });
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && s.open === 'tools') {
          e.preventDefault();
          close();
          return;
        }
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          dispatch({ type: 'toggleTools' });
        }
      }}
    >
      <div
        ref={capsule}
        className="island"
        onClick={(e) => {
          // the live reading is a button of its own: it brings its tab back (D10)
          if (open || (e.target as Element).closest('button')) return;
          // with the sidebar folded the drawer took this click (Drawer.tsx, in the capture
          // phase): one gesture opens one surface, so the tools stay shut (I-R64)
          if (drawerStore.getState().opened !== null) return;
          // a click on the capsule itself (not one of its buttons) opens the tools
          dispatch({ type: 'toggleTools' });
        }}
      >
        <div ref={layer} className="isl-layer" key={view}>
          {content}
        </div>
      </div>
      {notice && (
        <p ref={noticeRef} className="isl-notice" role="status" data-testid="t-notice">
          {t('island.tNotice')}
        </p>
      )}
      {/* beside the capsule, outside the centring: the bubble and a comparison's controls */}
      <div ref={asideRef} className="isl-aside">
        {secondary && !open && (
          <Button
            variant="quiet"
            className="isl-bubble"
            aria-label={t('island.swap')}
            tip={liveText(secondary)}
            onClick={() => {
              dispatch({ type: 'swap' });
            }}
          >
            <LiveGlyph item={secondary} />
          </Button>
        )}
        {/* Compare dates itself is the View tile; while comparing, Leave and its tools show here */}
        <CompareButton split={split} whileComparing />
      </div>
    </div>
  );
}
