/**
 * The stage notch (the island, D1 to D10): hung from the top centre of the stage. At rest its one
 * line: the 3D / Map / Split switch, the survey date with its arrows, the live reading and the
 * chevron that opens the tools; a second live item as a bubble beside it that swaps with it. The
 * pointer resting on it, a click on it, the chevron or T opens it: the line stays exactly where it
 * was (drawn once, never again), and under it come the group tabs with Jobs, Keep open and Close,
 * then a group's quick row (or the date's calendar). Unpinned it
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
import { IslandModes, IslandTools, moveFocus } from './IslandTools';
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
  // a tool live keeps its own Esc (the window's Esc below leaves it to the tool)
  const toolLive = items.some((i) => i.kind === 'tool');
  const toolLiveRef = useRef(toolLive);
  useLayoutEffect(() => {
    toolLiveRef.current = toolLive;
  });

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
  }, [s.open, open, notice]);
  useEffect(
    () => () => {
      root.current?.parentElement?.style.removeProperty('--isl-open-b');
    },
    [],
  );
  // what hangs beside the capsule (the bubble, a comparison's controls): the line leaves room for
  // it, past the shoulder, before the right panel's toggle (--isl-aside-w, island.css)
  useEffect(() => {
    const aside = asideRef.current;
    const wrap = root.current;
    if (!aside || !wrap || typeof ResizeObserver === 'undefined') return;
    const write = () => {
      wrap.style.setProperty('--isl-aside-w', `${String(aside.offsetWidth)}px`);
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

  // the notch opens on a click (or Enter, Space, T) only, never on a pointer resting on it
  // (founder, 30 Oct 2026); the pointer on it is still known, for Esc with focus elsewhere
  const hovered = useRef(false);
  useEffect(() => {
    const el = capsule.current;
    if (!el) return;
    const onEnter = () => {
      hovered.current = true;
    };
    const onLeave = () => {
      hovered.current = false;
    };
    el.addEventListener('pointerenter', onEnter);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  // Keep open: a press outside, Esc and a pick leave it open
  const setPinned = (on: boolean) => {
    dispatch({ type: 'pin', on });
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
      // said on a T that opens the tools, or that finds them kept open, where it can be read
      // (once on this computer: takeTNotice)
      if ((opening || now.pinned) && takeTNotice()) setNotice(true);
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
      // a live tool's Esc, and an open popover's, are theirs
      if (toolLiveRef.current || document.querySelector('.surface-pop')) return;
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

  // opened from the keyboard: focus goes to the picked tab; a press outside closes (kept open,
  // only the calendar, back to the tools)
  useEffect(() => {
    if (s.open !== 'tools' || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [s.open]);
  useEffect(() => {
    if (!open || (s.pinned && s.open !== 'date')) return;
    const away = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el || root.current?.contains(el) || el.closest('.surface-pop')) return;
      dispatch({ type: 'escape' });
    };
    window.addEventListener('pointerdown', away);
    return () => {
      window.removeEventListener('pointerdown', away);
    };
  }, [open, s.pinned, s.open]);
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
      {/* open, the chevron keeps its place (the line must not move under the pointer) but is
          out of sight: Keep open and Close are at the end of the tab row */}
      {open ? (
        <span className="isl-open isl-open-held" aria-hidden="true" />
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
  // the end of the tab row: Keep open, and Close unless kept open (the lit pin lets go)
  const end = (
    <>
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
      {!s.pinned && (
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
      )}
    </>
  );

  // under the line, which is drawn once and never again (it keeps its place and its focus)
  let body: ReactNode = null;
  if (tooling) {
    body = (
      <IslandTools
        groups={groups}
        group={group}
        preview={s.preview}
        ctx={ctx}
        dispatch={dispatch}
        onPick={pickGroup}
        end={end}
      />
    );
  } else if (s.open === 'date' && dates) {
    body = (
      <div ref={dateBox} role="dialog" aria-label={t('datebar.label')}>
        <IslandCalendar dates={dates} onDone={close} onCompare={onCompare} />
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
      <div className="isl-notch">
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
          <div
            ref={layer}
            className="isl-layer"
            onKeyDown={(e) => {
              // arrows and Tab move along and between the line and the open rows
              if (!tooling) return;
              if (e.target instanceof HTMLElement && e.target.closest('.surface-pop')) return;
              if (moveFocus(e.currentTarget, e)) e.preventDefault();
            }}
          >
            {line}
            {body && (
              <div className="isl-body" key={s.open}>
                {body}
              </div>
            )}
          </div>
        </div>
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
      {notice && (
        <p ref={noticeRef} className="isl-notice" role="status" data-testid="t-notice">
          {t('island.tNotice')}
        </p>
      )}
    </div>
  );
}
