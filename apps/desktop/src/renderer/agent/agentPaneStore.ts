// The Scene's agent pane (stage island D21-D23): normal on its split, maximised over the bench, or
// minimised to one line. A survey tool going live drops it to its line unless the person sized the
// split, and it comes back when the tool stops.
import { splitPrefs, type SplitPrefsState } from '@aio/ui';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { workbench, type WorkbenchState } from '../workspace/workbench/workbenchStore';

/** The split the bench and the agent share (the foundation's, Task 7). */
export const CTX_AGENT = 'scene.ctxAgent';
/** The bench's share at rest, and where a double-click on the divider puts it back (60 / 40). */
export const AGENT_SPLIT_DEFAULT = 0.6;

export type AgentPaneMode = 'normal' | 'max' | 'min';

export interface AgentPaneState {
  mode: AgentPaneMode;
  /** The person moved the divider: a live tool leaves the agent as it is (D23). */
  userSized: boolean;
  /** The mode a live tool dropped the agent from, given back when the tools stop. */
  folded: AgentPaneMode | null;
  /** Counts the reveals that should end in the input: the pane focuses it once it shows. */
  focusSeq: number;
  /** The person's choice (the header buttons, the line, a tab): a tool no longer gives it back. */
  setMode: (mode: AgentPaneMode) => void;
  /** Ctrl+J and Ask the agent: a minimised agent opens again, so its input can take the focus. */
  reveal: () => void;
  setUserSized: (on: boolean) => void;
  toolStarted: () => void;
  toolStopped: () => void;
}

export function createAgentPaneStore(userSized = false): StoreApi<AgentPaneState> {
  return createStore<AgentPaneState>()((set, get) => ({
    mode: 'normal',
    userSized,
    folded: null,
    focusSeq: 0,
    setMode: (mode) => {
      set({ mode, folded: null });
    },
    reveal: () => {
      const s = get();
      if (s.mode === 'min') set({ mode: 'normal', folded: null, focusSeq: s.focusSeq + 1 });
    },
    setUserSized: (on) => {
      if (get().userSized !== on) set({ userSized: on });
    },
    toolStarted: () => {
      const s = get();
      if (s.userSized || s.mode === 'min') return;
      set({ mode: 'min', folded: s.mode });
    },
    toolStopped: () => {
      const s = get();
      if (s.folded === null) return;
      set({ mode: s.mode === 'min' ? s.folded : s.mode, folded: null });
    },
  }));
}

/** Sized by the person: a remembered size other than the reset's (a double-click is no sizing). */
export function sizedByPerson(prefs: Pick<SplitPrefsState, 'byId'>): boolean {
  const size = prefs.byId[CTX_AGENT]?.size;
  return size !== undefined && Math.abs(size - AGENT_SPLIT_DEFAULT) > 1e-4;
}

export const agentPane = createAgentPaneStore(sizedByPerson(splitPrefs.getState()));

export function useAgentPane<T>(selector: (s: AgentPaneState) => T): T {
  return useStore(agentPane, selector);
}

/** Live tabs that are not a tool's: a playing clip and running jobs leave the agent alone. */
const NOT_TOOLS = new Set(['jobs', 'video']);
const toolLive = (s: WorkbenchState) => s.tabs.some((t) => t.live && !NOT_TOOLS.has(t.id));

/**
 * The agent follows the tools (a tab going live, D23) and the divider (sized by the person or
 * reset). Returns unsubscribe.
 */
export function startAgentPaneFollow(
  pane: StoreApi<AgentPaneState> = agentPane,
  bench: StoreApi<WorkbenchState> = workbench,
  prefs: StoreApi<SplitPrefsState> = splitPrefs,
): () => void {
  pane.getState().setUserSized(sizedByPerson(prefs.getState()));
  const stopPrefs = prefs.subscribe((s) => {
    pane.getState().setUserSized(sizedByPerson(s));
  });
  let live = toolLive(bench.getState());
  const stopBench = bench.subscribe((s) => {
    const now = toolLive(s);
    if (now === live) return;
    live = now;
    if (now) pane.getState().toolStarted();
    else pane.getState().toolStopped();
  });
  return () => {
    stopPrefs();
    stopBench();
  };
}
