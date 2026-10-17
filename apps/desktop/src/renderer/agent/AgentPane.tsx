/**
 * The Scene's agent pane (stage island D21-D24): the workbench above and the agent below on the
 * foundation's `scene.ctxAgent` split. The agent can be maximised over the bench (the tab bar
 * stays), minimised to one line ("Ask about ‹context› · Ctrl J"), and drops to that line while a
 * tool is live unless the person sized it. With the AI off it is one row, "Agent off · Turn on",
 * until clicked.
 */
import type { AiTask, WindowKind } from '@aio/schema';
import {
  ariaKeys,
  Icon,
  Kbd,
  shortcutHint,
  SplitHandle,
  splitPrefs,
  t,
  Tip,
  useResizableSplit,
  useT,
  type MessageKey,
} from '@aio/ui';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import { AgentHost } from './AgentHost';
import {
  AGENT_SPLIT_DEFAULT,
  agentPane,
  CTX_AGENT,
  useAgentPane,
  type AgentPaneMode,
} from './agentPaneStore';
import { appAgentSession } from './session';
import './agentPane.css';

/** What the one line says the agent is about: the view it is bound to. */
const CONTEXT: Record<WindowKind, MessageKey> = {
  scene3d: 'stage.pane.3d',
  map: 'stage.pane.map',
  video: 'stage.pane.video',
  photo: 'stage.pane.photo',
  pointcloud: 'card.kind.pointcloud',
  report: 'stage.pane.report',
  issues: 'wb.tab.issues',
};

/** The agent keeps this much height on the split (the foundation's limit). */
const AGENT_MIN = 96;
const BENCH_MIN = 160;

/** The agent is off and has no conversation to show: the one row stands for it. */
function useAgentOff(): boolean {
  const session = appAgentSession();
  const state = useSyncExternalStore(session.subscribe, session.getState);
  return state.availability.status === 'disabled' && state.turns.length === 0;
}

/**
 * The first thing in the pane the cursor can go to: its message box, else the off panel's Check
 * again, else its first control.
 */
function focusIn(pane: Element | null | undefined) {
  const target =
    pane?.querySelector<HTMLElement>('textarea:not(:disabled)') ??
    pane?.querySelector<HTMLElement>('.ag-off button:not(:disabled)') ??
    pane?.querySelector<HTMLElement>('button:not(:disabled)');
  target?.focus();
}

/** One of the header's own buttons (the package's borderless `ag-btn`), its name in a Tip. */
function HeadButton({
  icon,
  label,
  pressed,
  onClick,
}: {
  icon: 'minus' | 'maximize';
  label: string;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <Tip content={label} repeatsName>
      <button
        type="button"
        className="ag-btn ghost icon"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
      >
        <Icon name={icon} />
      </button>
    </Tip>
  );
}

/** Minimise, and Maximise or Restore, at the end of the agent's header. */
function PaneActions({ mode, onMinimise }: { mode: AgentPaneMode; onMinimise: () => void }) {
  const set = agentPane.getState().setMode;
  return (
    <>
      <HeadButton icon="minus" label={t('agent.minimise')} onClick={onMinimise} />
      <HeadButton
        icon="maximize"
        label={mode === 'max' ? t('agent.restore') : t('agent.maximise')}
        pressed={mode === 'max'}
        onClick={() => {
          set(mode === 'max' ? 'normal' : 'max');
        }}
      />
    </>
  );
}

export function AgentPane({
  bench,
  window: win,
  task,
}: {
  bench: ReactNode;
  window: WindowKind;
  task?: AiTask | undefined;
}) {
  useT();
  const mode = useAgentPane((s) => s.mode);
  const focusSeq = useAgentPane((s) => s.focusSeq);
  const off = useAgentOff();
  // the off row opens the agent's own words on why it is off, and how to turn it on
  const [offOpen, setOffOpen] = useState(false);
  const layout = off && !offOpen ? 'off' : mode;
  const moved = useStore(splitPrefs, (s) => s.byId[CTX_AGENT] !== undefined);
  const [standing, setStanding] = useState(0.62);
  const agentRef = useRef<HTMLDivElement | null>(null);

  // Until the person moves the divider the bench and the agent keep the sizes they always had
  // (styles.css, `.rp-split.auto`); the divider then starts from where it stands, and once moved
  // its fraction is remembered (ruling R11). Measured only while both panes show.
  useEffect(() => {
    const el = agentRef.current;
    const split = el?.closest('.rp-split');
    if (moved || layout !== 'normal' || !el || !split || typeof ResizeObserver === 'undefined')
      return;
    const measure = () => {
      const box = split.getBoundingClientRect();
      if (box.height <= 0) return;
      const at = (el.getBoundingClientRect().top - box.top) / box.height;
      setStanding(Math.round(Math.min(1, Math.max(0, at)) * 1000) / 1000 || 0.62);
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    watch.observe(split);
    return () => {
      watch.disconnect();
    };
  }, [moved, layout]);

  const { containerRef, separatorProps } = useResizableSplit({
    id: CTX_AGENT,
    orientation: 'vertical',
    sized: 'start',
    unit: 'fraction',
    defaultSize: moved ? AGENT_SPLIT_DEFAULT : standing,
    min: BENCH_MIN,
    max: '100%',
    otherMin: AGENT_MIN,
  });
  const paneId = separatorProps['aria-controls'];

  // a reveal (Ctrl+J, Ask the agent, the one line) ends in the input once it shows; with the AI
  // off, on the off row's Turn on
  const seenFocus = useRef(focusSeq);
  const offRow = layout === 'off';
  useLayoutEffect(() => {
    if (seenFocus.current === focusSeq) return;
    seenFocus.current = focusSeq;
    const pane = agentRef.current;
    if (offRow) pane?.querySelector<HTMLElement>('.ag-line')?.focus();
    else focusIn(pane);
  }, [focusSeq, offRow]);
  // a click that hides the control it was on hands the focus on: Minimise to the one line (which
  // restores), Turn on to the opened panel
  const [handOn, setHandOn] = useState<{ to: 'line' | 'panel'; n: number } | null>(null);
  useLayoutEffect(() => {
    if (!handOn) return;
    const pane = agentRef.current;
    if (handOn.to === 'line') pane?.querySelector<HTMLElement>('.ag-line')?.focus();
    else focusIn(pane?.querySelector('.agent-body'));
  }, [handOn]);
  const handFocus = (to: 'line' | 'panel') => {
    setHandOn((h) => ({ to, n: (h?.n ?? 0) + 1 }));
  };

  const context = t(CONTEXT[win]);
  const keys = shortcutHint('global.agent');
  return (
    <div
      ref={containerRef}
      className={`split rp-split${moved ? '' : ' auto'}${layout === 'normal' ? '' : ` ag-${layout}`}`}
    >
      <div className="split-pane" id={paneId} hidden={layout === 'max'}>
        {bench}
      </div>
      <SplitHandle
        separatorProps={separatorProps}
        label={t('panel.resizeAgent')}
        hidden={layout !== 'normal'}
        // back to 60 / 40, wherever the divider stood (D21)
        onDoubleClick={() => {
          splitPrefs.getState().save(CTX_AGENT, { size: AGENT_SPLIT_DEFAULT, collapsed: false });
        }}
      />
      <div className="split-pane">
        <div className="agent" ref={agentRef}>
          {layout === 'off' && (
            <button
              type="button"
              className="ag-line"
              onClick={() => {
                setOffOpen(true);
                handFocus('panel');
              }}
            >
              <Icon name="agent" size={14} />
              <span className="ag-line-t">{t('agent.offRow')}</span>
            </button>
          )}
          {layout === 'min' && (
            <button
              type="button"
              className="ag-line"
              aria-keyshortcuts={ariaKeys('global.agent')}
              onClick={() => {
                agentPane.getState().reveal();
              }}
            >
              <Icon name="agent" size={14} />
              <span className="ag-line-t">{t('agent.askAbout', { context })}</span>
              <Kbd>{keys}</Kbd>
            </button>
          )}
          <div className="agent-body" hidden={layout === 'off' || layout === 'min'}>
            <AgentHost
              window={win}
              task={task}
              actions={
                <PaneActions
                  mode={mode}
                  onMinimise={() => {
                    agentPane.getState().setMode('min');
                    handFocus('line');
                  }}
                />
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
