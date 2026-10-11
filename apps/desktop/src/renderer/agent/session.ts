/**
 * The one agent conversation of the app. The renderer owns it, so it outlives the panel that shows
 * it: the Scene's right panel and the agent column of Issues, Media, Detections and Reports
 * (AgentDock) show the same conversation, and a reply keeps running while the person moves between
 * those screens. `AgentHost` is the panel on it; `startAgentSession` (App) connects it for as long
 * as the app runs.
 *
 * The session is a module singleton, bound to the bridge that is there at its first use: a module
 * instance never gets a second bridge, which is why the app without one is tested in its own file
 * (sessionNoBridge.test.ts).
 */
import { AgentSession, defaultToolContext, type RendererToolContext } from '@aio/ai';
import type { AiTask, AioBridge, WindowKind } from '@aio/schema';
import { workspace, type Workspace } from '@aio/workspace';
import { shell } from '../shell';
import type { Screen } from '../store';
import { isDockScreen } from './dockScreens';

let session: AgentSession | null = null;
/** The window of the screen that shows the panel now: the tools run against it. */
let current: WindowKind = 'scene3d';
let currentTask: AiTask | undefined;
/** The workspace as it was before the project changed, while the session is reset for it. */
let leaving: Workspace | null = null;

function toolContext(): RendererToolContext {
  const ctx = defaultToolContext(current);
  const before = leaving;
  return before ? { ...ctx, workspace: { ...ctx.workspace, getState: () => before } } : ctx;
}

/** The one session, made on first use. Without the app bridge (tests) it says the agent is off. */
export function appAgentSession(): AgentSession {
  session ??= new AgentSession({
    bridge: (globalThis as { aio?: AioBridge }).aio ?? null,
    window: current,
    toolContext,
    task: () => currentTask,
  });
  return session;
}

/** The window the tool context uses, and whose context travels with the next message. */
export function setAgentWindow(window: WindowKind): void {
  current = window;
  session?.setWindow(window);
}

/** The route the next message goes to (`build` while the Model builder is open); default chat. */
export function setAgentTask(task: AiTask | undefined): void {
  currentTask = task;
}

/** The screens that show the conversation, and with it Stop: Scene and the ones with the column. */
const showsAgent = (screen: Screen) => screen === 'scene' || isDockScreen(screen);

/**
 * Connect the session, reset it when the project changes, stop a reply on a screen without the
 * agent, refresh on window focus. Returns a stop function, for tests and hot reload: the app never
 * stops it, so no change between the screens of a project ends a reply.
 */
export function startAgentSession(): () => void {
  const s = appAgentSession();
  const disconnect = s.connect();
  // On Settings, the Globe, the project list and Welcome there is no panel and no Stop: a reply
  // must not run on there, changing the screen under the person with its next step. It ends as
  // it did when leaving Scene took the panel away, also when a step of its own went there
  // (show_on_globe). The conversation stays; nothing is stopped when no reply is running.
  const stopScreen = shell.subscribe((state, prev) => {
    if (state.screen !== prev.screen && !showsAgent(state.screen)) s.cancel();
  });
  const stopProject = workspace.subscribe((state, prev) => {
    if (state.project?.id === prev.project?.id) return;
    // A different project: a fresh conversation. The reset saves the one it leaves, and the store
    // already holds the new project, so the session sees the old one until the reset is done:
    // the conversation goes into the project it was held in, never into the one just opened.
    leaving = prev;
    try {
      s.reset();
    } finally {
      leaving = null;
    }
    void s.refresh();
  });
  // no panel may be mounted (Settings, Projects): the route is still checked on coming back
  const onFocus = () => {
    void s.refresh();
  };
  globalThis.addEventListener('focus', onFocus);
  return () => {
    globalThis.removeEventListener('focus', onFocus);
    stopScreen();
    stopProject();
    disconnect();
  };
}
