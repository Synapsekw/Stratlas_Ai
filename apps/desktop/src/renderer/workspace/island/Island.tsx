/**
 * The stage island (D1 to D10): one capsule at the top centre of the stage. At rest the survey
 * date; near the pointer the date's arrows, the view and Tools; a live reading beside the date;
 * a second live item as a bubble that swaps with it; open, the view switch, the group tabs and a
 * group's quick row. Its size morphs between the states (instant under reduced motion).
 */
import type { EngineStage } from '@aio/engine';
import {
  announce,
  Button,
  Icon,
  IconButton,
  matchShortcut,
  Popover,
  shortcutHint,
  useFocusTrap,
  useT,
} from '@aio/ui';
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
import { EnvironmentTool } from '../../environment/EnvironmentTool';
import { isTyping } from '../../keys';
import { useRoad } from '../../road/store';
import { useShell } from '../../shell';
import type { StageMode } from '../../store';
import { CompareButton, useCompareDates } from '../CompareControls';
import type { Side } from '../splitModel';
import { paneCapture, useSplit } from '../SplitPanes';
import { useTimeline } from '../timeline';
import { fullGroup, GROUP_NAME, MODES, type GroupCtx } from './groups';
import { IslandCalendar, IslandDate, islandDates } from './IslandDate';
import { IslandLive, LiveGlyph, liveText } from './IslandLive';
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
/** Live readings are said at most once a second. */
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
  /** The sidebar's front tab is the island's live item (D10). */
  linked: boolean;
}

export function Island({ stage, mode, tools, linked }: IslandProps) {
  const t = useT();
  const [s, dispatch] = useReducer(islandReducer, INITIAL);
  const [full, setFull] = useState<GroupId | null>(null);
  const [side, setSide] = useState<Side>('left');
  const root = useRef<HTMLDivElement>(null);
  const capsule = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const dateBox = useRef<HTMLDivElement>(null);
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
  const split = useSplit();
  const splitting = mode === 'split';
  const dates = islandDates(index, focus, splitting ? split : null, side);
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
  useSayLive(primary ? liveText(primary) : '');

  const open = s.open === 'tools' || s.open === 'date';
  const expanded = s.open === 'ready';
  const view = `${s.open}:${primary?.kind ?? ''}`;

  const openFull = useCallback((g: GroupId) => {
    dispatch({ type: 'pickGroup', group: g });
    setFull(g);
  }, []);
  const ctx: GroupCtx = { stage, map, openFull, compare: compareDates };

  // size morph: the capsule takes its content's size (CSS animates width and height)
  useLayoutEffect(() => {
    const el = layer.current;
    const box = capsule.current;
    if (!el || !box) return;
    const fit = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
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
  }, [view]);

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

  // T opens the tools (D9)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (matchShortcut('scene', e) !== 'scene.tools') return;
      e.preventDefault();
      dispatch({ type: 'toggleTools' });
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

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
  // focus handed back on close does not wake the island again
  const returning = useRef(false);
  const close = () => {
    dispatch({ type: 'escape' });
    returning.current = true;
    root.current?.focus();
    returning.current = false;
  };
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
            <IslandLive item={primary} />
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
              <span className="isl-mode">{modeInfo?.label}</span>
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
      onFocus={() => {
        if (!returning.current) dispatch({ type: 'near' });
      }}
      onBlur={(e) => {
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
          // a click on the capsule itself (not one of its buttons) opens the tools
          if (!open && !(e.target as Element).closest('button')) dispatch({ type: 'toggleTools' });
        }}
      >
        <div ref={layer} className="isl-layer" key={view}>
          {content}
        </div>
      </div>
      {/* beside the capsule, outside the centring: the bubble and a comparison's controls */}
      <div className="isl-aside">
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
      <Popover
        open={full !== null}
        onClose={() => {
          setFull(null);
        }}
        opener={root}
        className="isl-full"
      >
        {full && (
          <>
            <div className="pop-head">
              <h2 className="pop-title">{t(GROUP_NAME[full])}</h2>
              <IconButton
                icon="x"
                label={t('dialog.close')}
                onClick={() => {
                  setFull(null);
                }}
              />
            </div>
            <div className="tgroup-h isl-full-row">
              {fullGroup(full, { stage, map })}
              {/* the toolbar kept Environment and time of day beside the groups */}
              {full === 'view' && !map && stage && <EnvironmentTool stage={stage} />}
            </div>
          </>
        )}
      </Popover>
    </div>
  );
}
