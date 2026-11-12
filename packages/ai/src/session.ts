/**
 * One agent conversation bound to one window, in the renderer. Sends messages over `ai:send`,
 * listens to `ai:event`, runs tool calls (asking first for write and send risk), keeps undo
 * functions and the token meters. It saves itself to the project after every change
 * (`ai:saveConversation`), lists and resumes saved conversations, shows what will leave the
 * machine before the first cloud send in a project (AI-6) and brings waiting approvals back after
 * a restart without ever running them on its own. Framework-free so it can be tested without a
 * DOM; AgentPanel renders it.
 */
import {
  CONVERSATION_SCHEMA,
  AiProvider as AiProviderSchema,
  CHAT_MESSAGES_MAX,
  needsApproval,
  type AgentFacts,
  type AgentNote,
  type AiProvider,
  type AiErrorCode,
  type AiPolicy,
  type AiTask,
  type AioBridge,
  type ChatMessage,
  type Conversation,
  type ConversationStep,
  type ConversationSummary,
  type ConversationTurn,
  type IpcEvent,
  type IpcResponse,
  type StepStatus,
  type WindowKind,
} from '@aio/schema';
import { assembleContext } from './context';
import { conversationMarkdown } from './exporting';
import { compactValue, historyFromConversation } from './history';
import { addProviderUsage, type ProviderUsageRow, type UsageTotals } from './pricing';
import {
  runRendererTool,
  ToolError,
  type RendererToolContext,
  type StepUndo,
} from './renderer-tools';
import type { ModelRoute } from './routes';
import { spatialContext } from './site';
import { viewContext } from './view-context';
import { undoable } from './tools';

export type { StepStatus };

/** One tool call in the conversation (the saved shape, so a conversation round-trips). */
export type Step = ConversationStep;
export type Turn = ConversationTurn;
export type Part = Extract<Turn, { kind: 'assistant' }>['parts'][number];

type DisabledReason = NonNullable<IpcResponse<'ai:status'>['reason']> | 'no-bridge';

export type Availability =
  | { status: 'checking' }
  | {
      status: 'ready';
      route: ModelRoute;
      cloud: boolean;
      /** Why the agent can only answer in text (a local model without tool calling). */
      notice?: string;
    }
  | { status: 'disabled'; reason: DisabledReason; message: string };

/**
 * A failed reply the panel can offer a fix for in place (the provider error's code), with the
 * message to send again once it is fixed.
 */
export interface AgentFix {
  code: AiErrorCode;
  /** The run that failed. */
  runId: string;
  /** The person's message of that run. */
  text: string;
}

/** What will leave the machine with the next message, shown before the first cloud send (AI-6). */
export interface SendPreview {
  text: string;
  /** The task chosen when this preview was prepared, unaffected by later tab changes. */
  task?: AiTask;
  /** The window context exactly as it is sent. */
  context: Record<string, unknown>;
  /** The attached frame (data URL), if any. */
  image?: string;
  route: ModelRoute;
}

export interface SessionState {
  /** Id of this conversation, also its file name in the project; empty until the first send. */
  id: string;
  createdAt: string;
  turns: Turn[];
  steps: Record<string, Step>;
  /** This conversation's tokens and estimated cost. */
  usage: UsageTotals;
  /** The project's tokens and estimated cost per provider, kept on this workstation. */
  projectUsage: ProviderUsageRow[];
  busy: boolean;
  availability: Availability;
  /** The person allowed sends for this project without the preview. */
  alwaysAllow: boolean;
  /**
   * A3: the person let Ask AI capture the view in this project without a card each time, on a
   * route that stays on this computer (a local or the bundled model).
   */
  viewCapture: boolean;
  /** A3: the same choice for cloud AI; the local one never covers it. */
  viewCaptureCloud: boolean;
  /** A3: the open project's notes (`ai/memory.json`), sent with each message as projectNotes. */
  notes: AgentNote[];
  /** The notes cannot be changed here (a package, or a read-only folder). */
  notesReadOnly: boolean;
  /** Why the notes cannot be read or changed (a file from a newer version...), or null. */
  notesProblem: string | null;
  /** The open project is a package: its notes are shown, never sent to the model. */
  notesPackage: boolean;
  /** A note is being added or deleted from the panel: the next one waits. */
  notesBusy: boolean;
  /** A batch of approvals is running: the batch card waits, a second "Approve N" is ignored. */
  batching: boolean;
  policy: AiPolicy;
  preview: SendPreview | null;
  /** Saved conversations of the project, newest first; null until listed. */
  history: ConversationSummary[] | null;
  /** Why the last save failed (read-only package, disk), or null. */
  saveError: string | null;
  /** The last reply failed with an error the panel can fix in place, or null. */
  fix: AgentFix | null;
}

export interface SessionDeps {
  bridge: AioBridge | null;
  window: WindowKind;
  toolContext: () => RendererToolContext;
  newId?: () => string;
  now?: () => Date;
  /** Delay before a change is saved; important changes (waiting approvals, end of a reply) save at once. */
  saveDelayMs?: number;
  /** The route the next message goes to (`build` while the Model builder is open); default chat. */
  task?: () => AiTask | undefined;
  /**
   * Whether the open project has a procedural or engineering model, so the modelling tools are
   * offered only when they can work; absent or undefined: unknown, they are offered.
   */
  hasModel?: () => Promise<boolean | undefined> | boolean | undefined;
}

export const SESSION_TEXT = {
  noBridge: 'The agent runs in the desktop app.',
  failed: 'This action failed in the app.',
  noResponse: 'The agent did not answer. Try again.',
  stopped: 'Stopped.',
  noProject: 'Open a project to save and list conversations.',
  notesBusy: 'A note is still being saved. Try again in a moment.',
  viewCaptureAllowed: 'Ran without asking: view capture is allowed for this project.',
} as const;

/** The tools that change the project notes: the notes are read again after them. */
const NOTE_TOOLS: ReadonlySet<string> = new Set(['remember_note', 'forget_note']);

/** What `ai:memory` may answer: an older main or a test bridge can leave fields out. */
type MemoryAnswer = Partial<IpcResponse<'ai:memory'>> | undefined;

/** A note as the model sees it in the window context. */
const noteForContext = (n: AgentNote) => ({
  id: n.id,
  text: n.text,
  ...(n.about ? { about: n.about } : {}),
});

/** The tool that sends the view to the model; once allowed for a project it runs without a card. */
const VIEW_CAPTURE_TOOL = 'capture_frame';

const EMPTY_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true };

/** Projects whose send preview the person has confirmed during this run of the app. */
const previewed = new Set<string>();

type Listener = () => void;

export class AgentSession {
  private state: SessionState;
  private readonly listeners = new Set<Listener>();
  private readonly undos = new Map<string, StepUndo>();
  /** Tool calls of the live run; any other awaiting step belongs to a run that has ended. */
  private readonly live = new Set<string>();
  private runId: string | null = null;
  /** The model step of the running reply, counted by its usage events (`Step.batch`). */
  private batch = 0;
  /**
   * Calls of the running model step. Main's usage event for the step names the provider that
   * really answered (a fallback to the local model included), and they are labelled with it.
   */
  private stepCalls: string[] = [];
  private off: (() => void) | null = null;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private window: WindowKind;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private closing = false;
  /** The project `viewCapture` was read or stored for: it never carries over to another one. */
  private viewCaptureFor: string | null = null;
  /**
   * Per tool call, whether the route main really used for it sends data off this machine (the
   * `tool-call` event's `cloud`; absent: yes). The renderer's own route guess is never used: an
   * attached frame goes to the vision route, which may be cloud while chat is local.
   */
  private readonly callCloud = new Map<string, boolean>();
  /** The project the notes in the state belong to, and the newest notes read asked (A3). */
  private notesFor: string | null = null;
  private notesAsked = 0;

  constructor(private readonly deps: SessionDeps) {
    this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
    this.now = deps.now ?? (() => new Date());
    this.window = deps.window;
    this.state = {
      id: '',
      createdAt: this.now().toISOString(),
      turns: [],
      steps: {},
      usage: EMPTY_USAGE,
      projectUsage: [],
      busy: false,
      availability: { status: 'checking' },
      alwaysAllow: false,
      viewCapture: false,
      viewCaptureCloud: false,
      notes: [],
      notesReadOnly: false,
      notesProblem: null,
      notesPackage: false,
      notesBusy: false,
      batching: false,
      policy: 'allow',
      preview: null,
      history: null,
      saveError: null,
      fix: null,
    };
  }

  getState = (): SessionState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** The window whose context travels with the next message. */
  setWindow(window: WindowKind): void {
    this.window = window;
  }

  private projectId(): string | null {
    try {
      return this.deps.toolContext().workspace.getState().project?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Start listening to `ai:event`. Returns the matching disconnect (stops a running reply). */
  connect(): () => void {
    this.off?.();
    this.closing = false;
    const off =
      this.deps.bridge?.on('ai:event', (e) => {
        this.onEvent(e);
      }) ?? (() => undefined);
    this.off = off;
    return () => {
      // Save what the person saw (waiting approvals included) before stopping the reply.
      this.flushSave();
      this.closing = true;
      if (this.runId) this.cancel();
      off();
      if (this.off === off) this.off = null;
    };
  }

  /** Check the route (cloud switch, key, local model, project policy). Call on mount and focus. */
  async refresh(): Promise<void> {
    const bridge = this.deps.bridge;
    if (!bridge) {
      this.set({
        availability: { status: 'disabled', reason: 'no-bridge', message: SESSION_TEXT.noBridge },
      });
      return;
    }
    const projectId = this.projectId();
    // another project's choice is dropped at once, even if the reads below fail
    this.dropViewCaptureOf(projectId);
    this.dropNotesOf(projectId);
    try {
      const task = this.deps.task?.();
      const status = await bridge.invoke('ai:status', {
        ...(projectId ? { projectId } : {}),
        ...(task ? { task } : {}),
      });
      const availability: Availability =
        status.ready && status.route
          ? {
              status: 'ready',
              route: status.route,
              cloud: status.cloud,
              ...(status.reason === 'answer-only' && status.message
                ? { notice: status.message }
                : {}),
            }
          : {
              status: 'disabled',
              reason: status.reason ?? 'no-provider',
              message: status.message ?? SESSION_TEXT.noResponse,
            };
      this.set({ availability });
      if (projectId) {
        const p = await bridge.invoke('ai:project', { projectId });
        if (this.projectId() !== projectId) return;
        this.viewCaptureFor = projectId;
        this.set({
          alwaysAllow: p.alwaysAllow,
          viewCapture: p.viewCapture ?? false,
          viewCaptureCloud: p.viewCaptureCloud ?? false,
          policy: p.policy,
          projectUsage: p.usage,
        });
        await this.loadNotes();
      } else {
        if (this.state.viewCapture || this.state.viewCaptureCloud)
          this.set({ viewCapture: false, viewCaptureCloud: false });
        this.dropNotesOf(null);
      }
    } catch (e) {
      this.set({
        availability: {
          status: 'disabled',
          reason: 'no-provider',
          message: e instanceof Error ? e.message : SESSION_TEXT.noResponse,
        },
      });
    }
  }

  /**
   * Send a message. Before the first cloud send in a project (unless the person chose "Always
   * allow"), this stops at a preview of what will be sent; confirmPreview sends it.
   */
  async send(text: string, opts: { attachFrame?: boolean } = {}): Promise<void> {
    const bridge = this.deps.bridge;
    const trimmed = text.trim();
    if (!bridge || !trimmed || this.state.busy || this.state.preview) return;
    const task = this.deps.task?.();
    let a = this.state.availability;
    if (a.status === 'ready' && a.route.task !== (task ?? 'chat')) {
      const projectId = this.projectId();
      const status = await bridge.invoke('ai:status', {
        ...(projectId ? { projectId } : {}),
        ...(task ? { task } : {}),
      });
      const current = this.getState();
      if (this.projectId() !== projectId || current.busy || current.preview) return;
      if (!status.ready || !status.route) {
        this.set({
          availability: {
            status: 'disabled',
            reason: status.reason ?? 'no-provider',
            message: status.message ?? SESSION_TEXT.noResponse,
          },
        });
        return;
      }
      a = { status: 'ready', route: status.route, cloud: status.cloud };
    }
    const sendingFor = this.projectId();
    const notes = await this.loadNotes();
    // the notes read took a moment: another send, a preview or a project switch may have come
    const after = this.getState();
    if (this.projectId() !== sendingFor || after.busy || after.preview) return;
    const ctx = this.deps.toolContext();
    const context = {
      ...assembleContext(ctx.workspace.getState(), this.window),
      ...spatialContext(ctx, this.window),
      ...viewContext(ctx),
      // a package's notes were not written by the person using it: they are never sent
      ...(notes.length && !this.state.notesPackage
        ? { projectNotes: notes.map(noteForContext) }
        : {}),
    };
    let image: string | undefined;
    if (opts.attachFrame) image = (await ctx.captureFrame(this.window)) ?? undefined;
    const key = this.projectId() ?? '';
    if (a.status === 'ready' && a.cloud && !this.state.alwaysAllow && !previewed.has(key)) {
      this.set({
        preview: {
          text: trimmed,
          context,
          route: a.route,
          ...(task ? { task } : {}),
          ...(image ? { image } : {}),
        },
      });
      return;
    }
    await this.dispatch(trimmed, context, image, task, a.status === 'ready' ? a : undefined);
  }

  /** Send the previewed message. `always` stores "Always allow for this project". */
  async confirmPreview(opts: { always?: boolean } = {}): Promise<void> {
    const p = this.state.preview;
    const bridge = this.deps.bridge;
    if (!p || !bridge) return;
    const projectId = this.projectId();
    previewed.add(projectId ?? '');
    this.set({ preview: null });
    if (opts.always && projectId) {
      const r = await bridge.invoke('ai:setConsent', { projectId, alwaysAllow: true });
      if (r.ok) this.set({ alwaysAllow: true });
    }
    // a preview is shown only before a cloud send
    await this.dispatch(p.text, p.context, p.image, p.task, { route: p.route, cloud: true });
  }

  /**
   * Send the message of the failed run again, after its fix (for example the workspace ID) is in
   * place. The failed exchange is replaced, so the conversation holds the message once.
   */
  async retry(): Promise<void> {
    const fix = this.state.fix;
    if (!fix || this.state.busy) return;
    const index = this.state.turns.findIndex(
      (t) => t.kind === 'assistant' && t.runId === fix.runId,
    );
    const before = index > 0 ? this.state.turns[index - 1] : undefined;
    const start = before?.kind === 'user' ? index - 1 : index;
    if (index >= 0) this.set({ turns: this.state.turns.filter((_, i) => i < start || i > index) });
    this.set({ fix: null });
    await this.send(fix.text);
  }

  /** Hide the in-place fix; the error stays in the conversation. */
  dismissFix(): void {
    if (this.state.fix) this.set({ fix: null });
  }

  cancelPreview(): void {
    if (this.state.preview) this.set({ preview: null });
  }

  /** Forget "Always allow" for this project: the next send shows the preview again. */
  async revokeConsent(): Promise<void> {
    const projectId = this.projectId();
    const bridge = this.deps.bridge;
    previewed.delete(projectId ?? '');
    if (!projectId || !bridge) return;
    const r = await bridge.invoke('ai:setConsent', { projectId, alwaysAllow: false });
    if (r.ok) this.set({ alwaysAllow: false });
  }

  /**
   * Read the open project's notes into the state (A3); answers them. A project that cannot be
   * read, or no project, has none.
   */
  async loadNotes(): Promise<AgentNote[]> {
    const projectId = this.projectId();
    const bridge = this.deps.bridge;
    this.dropNotesOf(projectId);
    if (!projectId || !bridge) return [];
    const asked = ++this.notesAsked;
    try {
      // an answer without a notes list (an older main, a test bridge) is no notes
      const r = (await bridge.invoke('ai:memory', { projectId })) as MemoryAnswer;
      if (this.projectId() !== projectId) return [];
      const notes = r?.ok && Array.isArray(r.notes) ? r.notes : [];
      // a newer read asked meanwhile: its answer is the one to show
      if (asked === this.notesAsked) {
        this.notesFor = projectId;
        this.set({
          notes,
          notesReadOnly: r?.readOnly ?? false,
          notesProblem: r?.error ?? null,
          notesPackage: r?.package ?? false,
        });
      }
      return notes;
    } catch {
      // only this project's notes, never the ones of the project open before
      return this.notesFor === projectId ? this.state.notes : [];
    }
  }

  /** The person adds a note in the project panel. Null when saved, else why not. */
  async addNote(text: string): Promise<string | null> {
    const projectId = this.projectId();
    const bridge = this.deps.bridge;
    if (!projectId || !bridge) return SESSION_TEXT.noProject;
    // one change at a time: a second click while one is saving would race it
    if (this.state.notesBusy) return SESSION_TEXT.notesBusy;
    this.set({ notesBusy: true }, false);
    try {
      const r = await bridge.invoke('ai:remember', { projectId, text, by: 'person' });
      await this.loadNotes();
      return r.ok ? null : (r.error ?? SESSION_TEXT.failed);
    } catch {
      return SESSION_TEXT.failed;
    } finally {
      this.set({ notesBusy: false }, false);
    }
  }

  /** The person deletes a note in the project panel. Null when deleted, else why not. */
  async deleteNote(id: string): Promise<string | null> {
    const projectId = this.projectId();
    const bridge = this.deps.bridge;
    if (!projectId || !bridge) return SESSION_TEXT.noProject;
    // one change at a time: a second click while one is saving would race it
    if (this.state.notesBusy) return SESSION_TEXT.notesBusy;
    this.set({ notesBusy: true }, false);
    try {
      const r = await bridge.invoke('ai:forget', { projectId, id });
      await this.loadNotes();
      return r.ok ? null : (r.error ?? SESSION_TEXT.failed);
    } catch {
      return SESSION_TEXT.failed;
    } finally {
      this.set({ notesBusy: false }, false);
    }
  }

  /** After a note tool ran or was undone, the panel and the next message see the notes as they are. */
  private notesTouched(name: string | undefined): void {
    if (name && NOTE_TOOLS.has(name)) void this.loadNotes();
  }

  /** Whether a project is open, so a choice can be stored for it. */
  hasProject(): boolean {
    return this.projectId() !== null;
  }

  /**
   * Let the agent capture the view in this project without a card each time, or stop it (stored
   * on this computer, `ai:setViewCapture`). True when stored.
   */
  async setViewCapture(allow: boolean, cloud = this.routeCloud()): Promise<boolean> {
    const projectId = this.projectId();
    const bridge = this.deps.bridge;
    if (!projectId || !bridge) return false;
    try {
      const r = await bridge.invoke('ai:setViewCapture', { projectId, allow, cloud });
      if (r.ok && this.projectId() === projectId) {
        this.viewCaptureFor = projectId;
        this.set(cloud ? { viewCaptureCloud: allow } : { viewCapture: allow });
      }
      return r.ok;
    } catch {
      return false;
    }
  }

  private async dispatch(
    text: string,
    context: Record<string, unknown>,
    image: string | undefined,
    task: AiTask | undefined,
    /** Where the message goes, when known; unknown counts as cloud for the history. */
    target?: { route: ModelRoute; cloud: boolean },
  ): Promise<void> {
    const bridge = this.deps.bridge;
    if (!bridge || this.state.busy) return;
    const runId = this.newId();
    if (!this.state.id) {
      this.state = { ...this.state, id: this.newId(), createdAt: this.now().toISOString() };
    }
    const history = this.history(target?.cloud ?? true);
    const user: Turn = {
      kind: 'user',
      id: this.newId(),
      text,
      chips: contextChips(context),
      frame: image !== undefined,
    };
    const reply: Turn = {
      kind: 'assistant',
      id: this.newId(),
      runId,
      parts: [],
      status: 'streaming',
    };
    this.runId = runId;
    this.batch = 0;
    this.stepCalls = [];
    this.live.clear();
    this.set({ turns: [...this.state.turns, user, reply], busy: true, fix: null });
    const messages: ChatMessage[] = [...history, { role: 'user', content: text }];
    const projectId = this.projectId();
    try {
      const facts = await this.facts();
      const res = await bridge.invoke('ai:send', {
        runId,
        window: this.window,
        context,
        messages,
        ...(facts ? { facts } : {}),
        ...(projectId ? { projectId } : {}),
        ...(image ? { image } : {}),
        ...(task ? { task } : {}),
      });
      if (!res.ok) this.finish(runId, 'error', res.error ?? SESSION_TEXT.noResponse);
    } catch (e) {
      this.finish(runId, 'error', e instanceof Error ? e.message : SESSION_TEXT.noResponse);
    }
  }

  /**
   * Run a waiting step. `allowViewCapture` (a capture_frame card's "Allow for this project")
   * first stores that later captures in this project need no card. True when the step ran done.
   */
  async approve(callId: string, opts: { allowViewCapture?: boolean } = {}): Promise<boolean> {
    const step = this.state.steps[callId];
    if (step?.status !== 'awaiting') return false;
    if (opts.allowViewCapture && step.name === VIEW_CAPTURE_TOOL) {
      // the choice is for the route the capture goes to, as main said; unknown counts as cloud
      await this.setViewCapture(true, this.captureCloud(callId));
    }
    const now = this.state.steps[callId];
    if (now?.status !== 'awaiting') return false;
    if (this.live.has(callId) && this.runId) return this.execute(now);
    return this.executeDetached(now);
  }

  /**
   * Approve several waiting steps from one batch card: `skip` (unticked) are declined, then
   * `callIds` run one after another in the order the model made them, each awaited. A step that
   * fails stops the batch; the steps after it stay waiting. Steps that no longer wait are left
   * alone. Each step keeps its own status and Undo.
   */
  async approveBatch(callIds: readonly string[], skip: readonly string[] = []): Promise<void> {
    // one batch at a time: a second click while the first runs must not start a second loop
    if (this.state.batching) return;
    this.set({ batching: true }, false);
    try {
      for (const id of skip) this.reject(id);
      const order = this.modelOrder();
      const run = [...new Set(callIds)]
        .filter((id) => !skip.includes(id) && this.state.steps[id]?.status === 'awaiting')
        .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      for (const id of run) {
        if (this.state.steps[id]?.status !== 'awaiting') continue;
        if (!(await this.approve(id))) break;
      }
    } finally {
      this.set({ batching: false }, false);
    }
  }

  /** Each step's place in the conversation, the order the model made the calls. */
  private modelOrder(): Map<string, number> {
    const order = new Map<string, number>();
    for (const t of this.state.turns) {
      if (t.kind !== 'assistant') continue;
      for (const p of t.parts) if (p.type === 'step') order.set(p.callId, order.size);
    }
    return order;
  }

  reject(callId: string): void {
    const step = this.state.steps[callId];
    if (step?.status !== 'awaiting') return;
    this.patchStep(callId, { status: 'rejected', summary: 'Rejected' });
    if (this.live.has(callId) && this.runId) {
      void this.deps.bridge?.invoke('ai:toolResult', {
        runId: this.runId,
        callId,
        approved: false,
      });
    }
    this.saveSoon(true);
  }

  undo(callId: string): void {
    const fn = this.undos.get(callId);
    if (!fn) return;
    this.undos.delete(callId);
    const settle = (refused: unknown) => {
      if (typeof refused === 'string' && refused !== '') {
        // the change cannot be taken back any more: the step stays done and says why
        const summary = this.state.steps[callId]?.summary;
        this.patchStep(callId, {
          canUndo: false,
          summary: summary ? `${summary} · ${refused}` : refused,
        });
      } else this.patchStep(callId, { status: 'undone', canUndo: false });
      this.notesTouched(this.state.steps[callId]?.name);
    };
    const fail = (e: unknown) => {
      settle(e instanceof ToolError ? e.message : SESSION_TEXT.failed);
    };
    try {
      const r = fn();
      if (r instanceof Promise) r.then(settle, fail);
      else settle(r);
    } catch (e) {
      fail(e);
    }
  }

  cancel(): void {
    const runId = this.runId;
    if (!runId) return;
    void this.deps.bridge?.invoke('ai:cancel', { runId });
    this.finish(runId, 'stopped');
  }

  /** Start a new conversation (not touching the project). The old one stays saved. */
  reset(): void {
    if (this.runId) this.cancel();
    this.flushSave();
    this.undos.clear();
    this.live.clear();
    this.callCloud.clear();
    this.set({
      id: '',
      createdAt: this.now().toISOString(),
      turns: [],
      steps: {},
      usage: EMPTY_USAGE,
      preview: null,
      saveError: null,
      fix: null,
      batching: false,
    });
    // a new conversation in the same project keeps its choice; a project switch drops it
    this.dropViewCaptureOf(this.projectId());
    this.dropNotesOf(this.projectId());
  }

  /** Forget the notes when they belong to a project other than `projectId`. */
  private dropNotesOf(projectId: string | null): void {
    if (this.notesFor === projectId) return;
    this.notesFor = null;
    if (
      this.state.notes.length ||
      this.state.notesReadOnly ||
      this.state.notesProblem ||
      this.state.notesPackage
    )
      this.set({ notes: [], notesReadOnly: false, notesProblem: null, notesPackage: false });
  }

  /** Forget the view-capture choice when it belongs to a project other than `projectId`. */
  private dropViewCaptureOf(projectId: string | null): void {
    if (this.viewCaptureFor === projectId) return;
    this.viewCaptureFor = null;
    if (this.state.viewCapture || this.state.viewCaptureCloud)
      this.set({ viewCapture: false, viewCaptureCloud: false });
  }

  /**
   * Whether the route in use goes to cloud AI. Unknown counts as cloud, so a choice made for this
   * computer is never used for it.
   */
  private routeCloud(): boolean {
    const a = this.state.availability;
    return a.status === 'ready' ? a.cloud : true;
  }

  // History (AI-8) -----------------------------------------------------------------------------

  /** The conversation as saved in the project. */
  toConversation(): Conversation {
    const first = this.state.turns.find((t) => t.kind === 'user');
    const title = first?.kind === 'user' ? first.text.replace(/\s+/g, ' ').slice(0, 80) : '';
    return {
      schema: CONVERSATION_SCHEMA,
      id: this.state.id,
      title,
      window: this.window,
      createdAt: this.state.createdAt,
      updatedAt: this.now().toISOString(),
      turns: this.state.turns,
      steps: this.state.steps,
      usage: this.state.usage,
    };
  }

  async listHistory(): Promise<void> {
    const bridge = this.deps.bridge;
    const projectId = this.projectId();
    if (!bridge || !projectId) {
      this.set({ history: [] });
      return;
    }
    const r = await bridge.invoke('ai:listConversations', { projectId });
    this.set({ history: r.conversations, ...(r.ok ? {} : { saveError: r.error ?? null }) });
  }

  /** Open a saved conversation. Waiting approvals come back waiting; nothing runs by itself. */
  async resume(id: string): Promise<string | null> {
    const bridge = this.deps.bridge;
    const projectId = this.projectId();
    if (!bridge || !projectId) return SESSION_TEXT.noProject;
    const r = await bridge.invoke('ai:loadConversation', { projectId, id });
    if (!r.ok || !r.conversation) return r.error ?? SESSION_TEXT.noResponse;
    this.load(r.conversation);
    return null;
  }

  /** Show a saved conversation. Runs from before are over: running steps did not finish. */
  load(c: Conversation): void {
    if (this.runId) this.cancel();
    this.flushSave();
    this.undos.clear();
    this.live.clear();
    const steps: Record<string, Step> = {};
    for (const [k, s] of Object.entries(c.steps)) {
      steps[k] = {
        ...s,
        canUndo: false,
        ...(s.status === 'running' ? { status: 'cancelled' as const } : {}),
      };
    }
    const turns: Turn[] = c.turns.map((t) =>
      t.kind === 'assistant' && t.status === 'streaming' ? { ...t, status: 'stopped' } : t,
    );
    this.window = c.window;
    this.set({
      id: c.id,
      createdAt: c.createdAt,
      turns,
      steps,
      usage: c.usage,
      preview: null,
      saveError: null,
      fix: null,
    });
  }

  /** The conversation as Markdown in a file the person picks. Returns the path, or null. */
  async exportMarkdown(): Promise<{ path: string | null; error?: string }> {
    const bridge = this.deps.bridge;
    if (!bridge) return { path: null, error: SESSION_TEXT.noBridge };
    const project = this.deps.toolContext().workspace.getState().project;
    const name = project?.manifest.name ?? 'Quadrion AI';
    const c = this.toConversation();
    const md = conversationMarkdown(c, name);
    const stamp = c.createdAt.slice(0, 16).replace(/[:T]/g, '-');
    const r = await bridge.invoke('dialog:saveFile', {
      defaultName: `${name} agent ${stamp}.md`,
      data: md,
      title: 'Export the conversation',
    });
    return r.error ? { path: r.path, error: r.error } : { path: r.path };
  }

  /** Wait for saves in flight (tests, before closing). */
  async settled(): Promise<void> {
    this.flushSave();
    await this.saving;
  }

  private saveSoon(now = false): void {
    if (this.closing || !this.state.id || this.state.turns.length === 0 || !this.projectId())
      return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (now) {
      this.saveNow();
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, this.deps.saveDelayMs ?? 400);
  }

  private flushSave(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.saveNow();
  }

  private saveNow(): void {
    const bridge = this.deps.bridge;
    const projectId = this.projectId();
    if (!bridge || !projectId || this.state.turns.length === 0) return;
    const conversation = this.toConversation();
    this.saving = this.saving.then(async () => {
      try {
        const r = await bridge.invoke('ai:saveConversation', { projectId, conversation });
        const saveError = r.ok ? null : (r.error ?? SESSION_TEXT.failed);
        if (saveError !== this.state.saveError) this.set({ saveError }, false);
      } catch (e) {
        this.set({ saveError: e instanceof Error ? e.message : SESSION_TEXT.failed }, false);
      }
    });
  }

  // internals ----------------------------------------------------------------------------------

  /**
   * Earlier turns with their tool calls and compacted results, so follow-ups can use them. For a
   * cloud send, results of a local model's steps go as their summary only (AI-6). The newest
   * messages that fit `ai:send`, from a user message on.
   */
  private history(cloud: boolean): ChatMessage[] {
    const all = historyFromConversation(this.state.turns, this.state.steps, { cloud });
    if (all.length < CHAT_MESSAGES_MAX) return all;
    let start = all.length - (CHAT_MESSAGES_MAX - 1);
    while (start < all.length && all[start]?.role !== 'user') start += 1;
    return all.slice(start);
  }

  /** What the open project has, so the model is offered only the tools that can work there. */
  private async facts(): Promise<AgentFacts | null> {
    const ctx = this.deps.toolContext();
    const project = ctx.workspace.getState().project;
    if (!project) return null;
    const layers = project.manifest.layers;
    let models: boolean | undefined;
    try {
      models = await this.deps.hasModel?.();
    } catch {
      models = undefined;
    }
    return {
      captures: project.manifest.captures.length,
      photos: layers.some((l) => l.kind === 'photos' && l.items.length > 0),
      clips: layers.some((l) => l.kind === 'video'),
      pointClouds: layers.some((l) => l.kind === 'pointcloud'),
      ...(models !== undefined ? { models } : {}),
      ...this.moreFacts(ctx),
    };
  }

  /** What the app knows beyond the manifest (A2); keys it cannot tell are left out. */
  private moreFacts(ctx: RendererToolContext): Partial<AgentFacts> {
    try {
      const more = ctx.app?.agentFacts?.() ?? {};
      const out: Partial<AgentFacts> = {};
      for (const [k, v] of Object.entries(more)) {
        if (typeof v === 'boolean') (out as Record<string, boolean>)[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  private onEvent(e: IpcEvent<'ai:event'>): void {
    const turn = this.reply(e.runId);
    if (!turn) return;
    switch (e.type) {
      case 'text':
        this.appendText(e.runId, e.delta);
        break;
      case 'tool-call':
        this.onToolCall(e);
        break;
      case 'usage': {
        // one usage event per model step: its calls get the provider main used, and later calls
        // belong to the next step
        if (e.runId === this.runId) {
          this.labelStep(e.provider);
          this.batch += 1;
        }
        const u = this.state.usage;
        const projectUsage = e.provider
          ? addProviderUsage(this.state.projectUsage, {
              provider: e.provider,
              inputTokens: e.inputTokens,
              outputTokens: e.outputTokens,
              ...(e.costUsd !== undefined ? { costUsd: e.costUsd } : {}),
            })
          : this.state.projectUsage;
        this.set({
          usage: {
            inputTokens: u.inputTokens + e.inputTokens,
            outputTokens: u.outputTokens + e.outputTokens,
            costUsd: u.costUsd + (e.costUsd ?? 0),
            costKnown: u.costKnown && e.costUsd !== undefined,
          },
          projectUsage,
        });
        break;
      }
      case 'done':
        this.finish(e.runId, 'done');
        break;
      case 'error':
        if (turn.status !== 'streaming') break;
        this.finish(e.runId, 'error', e.message);
        if (e.code) {
          const text = this.userTextBefore(e.runId);
          if (text) this.set({ fix: { code: e.code, runId: e.runId, text } }, false);
        }
        break;
    }
  }

  /** Label the calls of the step that just ended with the provider main says answered it. */
  private labelStep(name: string | undefined): void {
    const calls = this.stepCalls;
    this.stepCalls = [];
    const known = AiProviderSchema.safeParse(name);
    if (!known.success || calls.length === 0) return;
    const provider: AiProvider = known.data;
    const steps = { ...this.state.steps };
    for (const id of calls) {
      const s = steps[id];
      if (s) steps[id] = { ...s, provider };
    }
    this.set({ steps });
  }

  /** Whether a waiting call goes to cloud AI, as main reported it (unknown: yes). */
  captureCloud(callId: string): boolean {
    return this.callCloud.get(callId) ?? true;
  }

  private onToolCall(e: Extract<IpcEvent<'ai:event'>, { type: 'tool-call' }>): void {
    const cloud = e.cloud ?? true;
    this.callCloud.set(e.callId, cloud);
    // A view capture in a project that allows it on this call's route runs without its card;
    // nothing else ever does.
    const allowed =
      needsApproval(e.risk) &&
      e.name === VIEW_CAPTURE_TOOL &&
      (cloud ? this.state.viewCaptureCloud : this.state.viewCapture) &&
      this.viewCaptureFor !== null &&
      this.viewCaptureFor === this.projectId() &&
      e.runId === this.runId;
    const step: Step = {
      callId: e.callId,
      name: e.name,
      input: e.input,
      risk: e.risk,
      status: needsApproval(e.risk) && !allowed ? 'awaiting' : 'running',
      canUndo: false,
      ...(e.runId === this.runId ? { batch: this.batch } : {}),
      ...(allowed ? { note: SESSION_TEXT.viewCaptureAllowed } : {}),
    };
    if (e.runId === this.runId) this.stepCalls.push(e.callId);
    this.live.add(e.callId);
    this.updateReply(e.runId, (t) => ({
      ...t,
      parts: [...t.parts, { type: 'step', callId: e.callId }],
    }));
    this.set({ steps: { ...this.state.steps, [e.callId]: step } });
    if (step.status === 'running') void this.execute(step);
    // A waiting approval is saved at once, so it survives the app closing.
    else this.saveSoon(true);
  }

  /** Run a step of the live run and send its result to main. True when it ran done. */
  private async execute(step: Step): Promise<boolean> {
    const runId = this.runId;
    if (!runId) return false;
    this.patchStep(step.callId, { status: 'running' });
    try {
      const r = await runRendererTool(step.name, step.input, this.deps.toolContext());
      if (r.undo && undoable(step.name)) this.undos.set(step.callId, r.undo);
      this.patchStep(step.callId, {
        status: 'done',
        summary: r.summary,
        canUndo: this.undos.has(step.callId),
        result: compactValue(r.result),
      });
      this.notesTouched(step.name);
      await this.deps.bridge?.invoke('ai:toolResult', {
        runId,
        callId: step.callId,
        approved: true,
        result: r.result,
      });
      return true;
    } catch (e) {
      const message = e instanceof ToolError ? e.message : SESSION_TEXT.failed;
      this.patchStep(step.callId, { status: 'error', summary: message });
      await this.deps.bridge?.invoke('ai:toolResult', {
        runId,
        callId: step.callId,
        approved: true,
        error: message,
      });
      return false;
    }
  }

  /**
   * Approve a step whose run has ended (restored after a restart, or from a resumed
   * conversation): run the tool here and note the outcome in the reply, so the next message
   * tells the model what happened.
   */
  private async executeDetached(step: Step): Promise<boolean> {
    this.patchStep(step.callId, { status: 'running' });
    let note: string;
    let ok = false;
    try {
      const r = await runRendererTool(step.name, step.input, this.deps.toolContext());
      if (r.undo && undoable(step.name)) this.undos.set(step.callId, r.undo);
      this.patchStep(step.callId, {
        status: 'done',
        summary: r.summary,
        canUndo: this.undos.has(step.callId),
        result: compactValue(r.result),
      });
      this.notesTouched(step.name);
      note = `Approved later and run: ${step.name}, ${r.summary}.`;
      ok = true;
    } catch (e) {
      const message = e instanceof ToolError ? e.message : SESSION_TEXT.failed;
      this.patchStep(step.callId, { status: 'error', summary: message });
      note = `Approved later, but ${step.name} failed: ${message}`;
    }
    this.set({
      turns: this.state.turns.map((t) =>
        t.kind === 'assistant' && t.parts.some((p) => p.type === 'step' && p.callId === step.callId)
          ? { ...t, parts: [...t.parts, { type: 'text', text: `\n(${note})` }] }
          : t,
      ),
    });
    this.saveSoon(true);
    return ok;
  }

  private finish(runId: string, status: 'done' | 'error' | 'stopped', error?: string): void {
    const steps = { ...this.state.steps };
    const turn = this.reply(runId);
    if (turn) {
      for (const p of turn.parts) {
        const s = p.type === 'step' ? steps[p.callId] : undefined;
        if (s && (s.status === 'awaiting' || s.status === 'running')) {
          steps[s.callId] = { ...s, status: 'cancelled' };
        }
      }
    }
    this.updateReply(runId, (t) =>
      t.status !== 'streaming'
        ? t
        : {
            ...t,
            status,
            ...(status === 'error' ? { error: error ?? SESSION_TEXT.noResponse } : {}),
          },
    );
    if (this.runId === runId) {
      this.runId = null;
      this.live.clear();
    }
    this.set({ steps, busy: this.runId !== null });
    this.saveSoon(true);
  }

  /** The person's message that started a run. */
  private userTextBefore(runId: string): string | null {
    const i = this.state.turns.findIndex((t) => t.kind === 'assistant' && t.runId === runId);
    const user = i > 0 ? this.state.turns[i - 1] : undefined;
    return user?.kind === 'user' ? user.text : null;
  }

  private reply(runId: string) {
    return this.state.turns.find(
      (t): t is Extract<Turn, { kind: 'assistant' }> => t.kind === 'assistant' && t.runId === runId,
    );
  }

  private appendText(runId: string, delta: string): void {
    this.updateReply(runId, (t) => {
      const last = t.parts.at(-1);
      const parts =
        last?.type === 'text'
          ? [...t.parts.slice(0, -1), { type: 'text' as const, text: last.text + delta }]
          : [...t.parts, { type: 'text' as const, text: delta }];
      return { ...t, parts };
    });
  }

  private updateReply(
    runId: string,
    fn: (t: Extract<Turn, { kind: 'assistant' }>) => Extract<Turn, { kind: 'assistant' }>,
  ): void {
    this.set({
      turns: this.state.turns.map((t) => (t.kind === 'assistant' && t.runId === runId ? fn(t) : t)),
    });
  }

  private patchStep(callId: string, patch: Partial<Step>): void {
    const s = this.state.steps[callId];
    if (!s) return;
    this.set({ steps: { ...this.state.steps, [callId]: { ...s, ...patch } } });
  }

  /** Update state and notify. Conversation changes are saved shortly after. */
  private set(patch: Partial<SessionState>, save = true): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
    if (save && ('turns' in patch || 'steps' in patch)) this.saveSoon();
  }
}

/** Small tags under the user's message: what context travelled with it. */
export function contextChips(context: Record<string, unknown>): string[] {
  const chips: string[] = [];
  const sel = context.selection as { label?: string } | null | undefined;
  if (sel?.label) chips.push(sel.label);
  const clip = context.activeClip as { name?: string } | null | undefined;
  if (clip?.name && context.window === 'video') chips.push(clip.name);
  const time = context.time as { nowUtc?: string } | undefined;
  if (time?.nowUtc) chips.push(time.nowUtc.slice(11, 19));
  return chips;
}

/** Forget confirmed previews (tests). */
export function resetPreviewMemory(): void {
  previewed.clear();
}
