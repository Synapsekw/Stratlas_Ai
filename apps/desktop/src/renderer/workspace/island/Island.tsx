/**
 * The stage notch (the island, D1 to D10): hung from the top centre of the stage. At rest its one
 * line: the 3D / Map / Split switch, the survey date with its arrows, the live reading and the
 * chevron that opens the tools; a second live item as a bubble beside it that swaps with it. The
 * pointer resting on it, a click on it, the chevron or T opens it: the line gains Keep open and
 * Close, the group tabs and Jobs come under it, and a group's quick row under them. Unpinned it
 * closes when the pointer leaves, on Esc or a press outside, and once a group's workbench (its
 * full set, in the right sidebar) opens; kept open (pinned, on this computer) none of those
 * close it. Its size morphs between the states (instant under reduced motion).
 */
import { annotateUi } from '@aio/annotate';
import type { EngineStage } from '@aio/engine';
import { announce, Button, Icon, matchShortcut, useFocusTrap, useT } from '@aio/ui';
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
import { readIslandPin, takeTNotice, writeIslandPin } from '../stagePrefs';
import { useTimeline } from '../timeline';
import type { TabId } from '../workbench/tabsModel';
import type { GroupCtx } from './groups';
import { drawerStore } from '../workbench/drawerStore';
import { liveTab, useHasVolumeMeasurements } from '../workbench/view';
import { GROUP_TAB, openBenchFromIsland } from './islandBench';
import { IslandCalendar, IslandDate, islandDates } from './IslandDate';
import { IslandLive, LiveGlyph, liveSay, liveText } from './IslandLive';
import { IslandModes, IslandTools } from './IslandTools';
import {
  islandGroups,
  islandInitial,
  islandReducer,
  islandRest,
  pickLive,
  type GroupId,
} from './islandModel';
import { livePairKey, useIslandLive } from './useIslandLive';
import './island.css';

/** The pointer resting this long on the notch opens it (leaving sooner does not). */
const HOVER_MS = 150;
/** Unpinned, the notch closes this long after the pointer leaves it (unless it comes back). */
const LEAVE_MS = 300;
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

/** Keyboard focus in `box` (or in a popover one of its controls opened): it keeps the notch open. */
function keyboardIn(box: HTMLElement | null): boolean {
  const at = document.activeElement;
  if (!(at instanceof HTMLElement)) return false;
  if (!box?.contains(at) && !at.closest('.surface-pop')) return false;
  try {
    // a click leaves focus on the button it pressed: that is the pointer's, not the keyboard's
    return at.matches(':focus-visible');
  } catch {
    return true;
  }
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
  const [s, dispatch] = useReducer(islandReducer, false, () => islandInitial(readIslandPin()));
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
  // the stockpile kit's project, or any with a volume measurement (its piles are in the view)
  const kitVolumes = useVolumetric((x) => x.status === 'ready');
  const piles = useHasVolumeMeasurements();
  const volumes = kitVolumes || piles;
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
  const view = `${s.open}:${primary?.kind ?? ''}`;

  // the latest state, for the listeners below
  const state = useRef(s);
  useLayoutEffect(() => {
    state.current = s;
  });
  // kept open on this computer
  useEffect(() => {
    writeIslandPin(s.pinned);
  }, [s.pinned]);

  // opened from the keyboard (T, Enter on the notch, the chevron by key), focus goes to the picked
  // tab; opened by the pointer it stays where it is
  const focusOnOpen = useRef(false);
  const close = useCallback(() => {
    dispatch({ type: 'escape' });
    root.current?.focus();
  }, []);
  // a tile has opened its panel in the sidebar (D4): unpinned, the notch goes back to rest, focus
  // on it rather than lost with the tile; pinned, it stays as it is
  const done = useCallback(() => {
    if (!state.current.pinned) close();
  }, [close]);
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

  // the last focused pane of a split, for the date (D7)
  useEffect(() => {
    const stageEl = root.current?.parentElement;
    if (!stageEl) return;
    const onPane = (e: Event) => {
      const pane = e.target instanceof Element ? e.target.closest('[data-side]') : null;
      const at = pane?.getAttribute('data-side');
      if (at === 'left' || at === 'right') setSide(at);
    };
    stageEl.addEventListener('pointerdown', onPane, true);
    stageEl.addEventListener('focusin', onPane);
    return () => {
      stageEl.removeEventListener('pointerdown', onPane, true);
      stageEl.removeEventListener('focusin', onPane);
    };
  }, []);

  // hover intent: the pointer resting on the notch opens it; leaving it closes it after a grace,
  // so a pointer on its way to a row or a popover does not flicker it (unpinned, and not while
  // keyboard focus is in it)
  const hovered = useRef(false);
  const leaveSoon = useRef<() => void>(() => undefined);
  useEffect(() => {
    const el = capsule.current;
    if (!el) return;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    const stay = () =>
      hovered.current ||
      state.current.pinned ||
      keyboardIn(layer.current) ||
      document.querySelector('.surface-pop:hover') !== null;
    leaveSoon.current = () => {
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => {
        if (!stay()) dispatch({ type: 'leave' });
      }, LEAVE_MS);
    };
    const onEnter = (e: PointerEvent) => {
      hovered.current = true;
      clearTimeout(leaveTimer);
      // a drag across it (orbiting the view) is not a rest on it
      if (state.current.open !== 'rest' || e.buttons) return;
      clearTimeout(openTimer);
      openTimer = setTimeout(() => {
        if (hovered.current) dispatch({ type: 'hover' });
      }, HOVER_MS);
    };
    const onLeave = () => {
      hovered.current = false;
      clearTimeout(openTimer);
      if (state.current.open === 'tools') leaveSoon.current();
    };
    // a press on the line at rest (a view, a date step) uses it as it is: no opening after it
    const onPress = () => {
      clearTimeout(openTimer);
    };
    el.addEventListener('pointerenter', onEnter);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('pointerdown', onPress);
    return () => {
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointerdown', onPress);
      clearTimeout(openTimer);
      clearTimeout(leaveTimer);
    };
  }, []);

  // Keep open; unpinned, the notch closes once the pointer is gone (not while keyboard focus is in it)
  const setPinned = (on: boolean) => {
    dispatch({ type: 'pin', on });
    if (!on && !hovered.current) leaveSoon.current();
  };
  // Close says it outright: the notch rests, no longer kept open
  const closeOut = () => {
    dispatch({ type: 'close' });
    root.current?.focus();
  };

  // T opens the tools (D9); the video annotator and a pending annotation keep their keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (annotateUi.getState().pending) return;
      if (e.target instanceof Element && e.target.closest('.vwin')) return;
      if (matchShortcut('scene', e) !== 'scene.tools') return;
      e.preventDefault();
      const now = state.current;
      const opening = now.open !== 'tools';
      // kept open, T takes focus to the picked tab
      if (!opening && now.pinned)
        root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
      focusOnOpen.current = opening;
      dispatch({ type: 'toggleTools' });
      // said on a T that opens the tools, where it can be read
      if (opening && takeTNotice()) setNotice(true);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  // Esc with the pointer on the open notch closes it, wherever focus is (focus in it: onKeyDown)
  useEffect(() => {
    if (s.open !== 'tools' || s.pinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !hovered.current) return;
      if (root.current?.contains(document.activeElement)) return;
      e.preventDefault();
      dispatch({ type: 'escape' });
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [s.open, s.pinned]);

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

  // opened from the keyboard: focus goes to the picked tab; unpinned, a press outside closes
  useEffect(() => {
    if (s.open !== 'tools' || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [s.open]);
  useEffect(() => {
    if (!open || s.pinned) return;
    const away = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el || root.current?.contains(el) || el.closest('.surface-pop')) return;
      dispatch({ type: 'escape' });
    };
    window.addEventListener('pointerdown', away);
    return () => {
      window.removeEventListener('pointerdown', away);
    };
  }, [open, s.pinned]);
  // the calendar keeps Tab inside and gives focus back to the island
  useFocusTrap(dateBox, s.open === 'date', { onEscape: close });

  const tooling = s.open === 'tools';
  const line = (
    <div className="isl-line" data-isl-row={tooling ? '' : undefined}>
      <IslandModes mode={mode} />
      {dates && rest !== 'dots' && (
        <>
          <span className="isl-sep" aria-hidden="true" />
          <IslandDate
            dates={dates}
            steps={rest === 'dateSteps'}
            onOpen={() => {
              dispatch({ type: 'openDate' });
            }}
          />
        </>
      )}
      {primary && (
        <>
          <span className="isl-sep" aria-hidden="true" />
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
      {tooling ? (
        <span className="isl-end">
          <Button
            variant="quiet"
            className="isl-pin"
            pressed={s.pinned}
            aria-label={t('island.pin')}
            tip={t(s.pinned ? 'island.unpin' : 'island.pin')}
            onClick={() => {
              setPinned(!s.pinned);
            }}
          >
            <Icon name="pin" size={14} />
          </Button>
          <Button
            variant="quiet"
            className="isl-x"
            aria-label={t('dialog.close')}
            tip={t('dialog.close')}
            onClick={closeOut}
          >
            <span className="kbd">Esc</span>
            <Icon name="chevup" size={14} />
          </Button>
        </span>
      ) : (
        <Button
          variant="quiet"
          className="isl-open"
          aria-label={t('island.tools')}
          tip={t('island.tools')}
          shortcut="scene.tools"
          aria-expanded={false}
          onClick={(e) => {
            // by key (no pointer press: detail 0) focus goes on to the tabs
            focusOnOpen.current = e.detail === 0;
            dispatch({ type: 'toggleTools' });
          }}
        >
          <Icon name="chevdown" size={14} />
        </Button>
      )}
    </div>
  );

  let content: ReactNode;
  if (tooling) {
    content = (
      <IslandTools
        line={line}
        groups={groups}
        group={group}
        preview={s.preview}
        ctx={ctx}
        dispatch={dispatch}
        onPick={pickGroup}
      />
    );
  } else if (s.open === 'date' && dates) {
    content = (
      <div ref={dateBox} role="dialog" aria-label={t('datebar.label')}>
        <IslandCalendar dates={dates} onDone={close} onCompare={onCompare} />
      </div>
    );
  } else content = line;

  const isLinked = linked && !open && primary !== null && primary.kind !== 'connection';
  return (
    <div
      ref={root}
      className="island-wrap"
      role="toolbar"
      aria-label={t('island.label')}
      data-surface="dark"
      data-state={s.open}
      data-pinned={s.pinned ? '' : undefined}
      data-linked={isLinked ? '' : undefined}
      data-motion={motion ? 'reduce' : undefined}
      tabIndex={open ? -1 : 0}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && s.open === 'tools') {
          e.preventDefault();
          close();
          return;
        }
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          focusOnOpen.current = true;
          dispatch({ type: 'toggleTools' });
        }
      }}
    >
      <div
        ref={capsule}
        className="island"
        onClick={(e) => {
          // the notch's own buttons (the live reading brings its tab back, D10) do their own thing
          if (open || (e.target as Element).closest('button')) return;
          // with the sidebar folded the drawer took this click (Drawer.tsx, in the capture
          // phase): one gesture opens one surface, so the tools stay shut (I-R64)
          if (drawerStore.getState().opened !== null) return;
          // a click on the notch itself (not one of its buttons) opens the tools
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
