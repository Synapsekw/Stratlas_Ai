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
  needsApproval,
  type AiErrorCode,
  type AiPolicy,
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
import { addProviderUsage, type ProviderUsageRow, type UsageTotals } from './pricing';
import { runRendererTool, ToolError, type RendererToolContext } from './renderer-tools';
import type { ModelRoute } from './routes';
import { spatialContext } from './site';
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
}

export const SESSION_TEXT = {
  noBridge: 'The agent runs in the desktop app.',
  failed: 'This action failed in the app.',
  noResponse: 'The agent did not answer. Try again.',
  stopped: 'Stopped.',
  noProject: 'Open a project to save and list conversations.',
} as const;

const EMPTY_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true };

/** Projects whose send preview the person has confirmed during this run of the app. */
const previewed = new Set<string>();

type Listener = () => void;

export class AgentSession {
  private state: SessionState;
  private readonly listeners = new Set<Listener>();
  private readonly undos = new Map<string, () => void>();
  /** Tool calls of the live run; any other awaiting step belongs to a run that has ended. */
  private readonly live = new Set<string>();
  private runId: string | null = null;
  private off: (() => void) | null = null;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private window: WindowKind;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private closing = false;

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
    try {
      const status = await bridge.invoke('ai:status', projectId ? { projectId } : {});
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
        this.set({ alwaysAllow: p.alwaysAllow, policy: p.policy, projectUsage: p.usage });
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
    const ctx = this.deps.toolContext();
    const context = {
      ...assembleContext(ctx.workspace.getState(), this.window),
      ...spatialContext(ctx, this.window),
    };
    let image: string | undefined;
    if (opts.attachFrame) image = (await ctx.captureFrame(this.window)) ?? undefined;
    const a = this.state.availability;
    const key = this.projectId() ?? '';
    if (a.status === 'ready' && a.cloud && !this.state.alwaysAllow && !previewed.has(key)) {
      this.set({
        preview: { text: trimmed, context, route: a.route, ...(image ? { image } : {}) },
      });
      return;
    }
    await this.dispatch(trimmed, context, image);
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
    await this.dispatch(p.text, p.context, p.image);
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

  private async dispatch(
    text: string,
    context: Record<string, unknown>,
    image: string | undefined,
  ): Promise<void> {
    const bridge = this.deps.bridge;
    if (!bridge || this.state.busy) return;
    const runId = this.newId();
    if (!this.state.id) {
      this.state = { ...this.state, id: this.newId(), createdAt: this.now().toISOString() };
    }
    const history = this.history();
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
    this.live.clear();
    this.set({ turns: [...this.state.turns, user, reply], busy: true, fix: null });
    const messages: ChatMessage[] = [...history, { role: 'user', content: text }];
    const projectId = this.projectId();
    try {
      const res = await bridge.invoke('ai:send', {
        runId,
        window: this.window,
        context,
        messages,
        ...(projectId ? { projectId } : {}),
        ...(image ? { image } : {}),
      });
      if (!res.ok) this.finish(runId, 'error', res.error ?? SESSION_TEXT.noResponse);
    } catch (e) {
      this.finish(runId, 'error', e instanceof Error ? e.message : SESSION_TEXT.noResponse);
    }
  }

  async approve(callId: string): Promise<void> {
    const step = this.state.steps[callId];
    if (step?.status !== 'awaiting') return;
    if (this.live.has(callId) && this.runId) await this.execute(step);
    else await this.executeDetached(step);
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
    fn();
    this.patchStep(callId, { status: 'undone', canUndo: false });
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
    this.set({
      id: '',
      createdAt: this.now().toISOString(),
      turns: [],
      steps: {},
      usage: EMPTY_USAGE,
      preview: null,
      saveError: null,
      fix: null,
    });
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
    const name = project?.manifest.name ?? 'Stratlas';
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

  private history(): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const t of this.state.turns) {
      if (t.kind === 'user') out.push({ role: 'user', content: t.text });
      else {
        const text = t.parts
          .map((p) => (p.type === 'text' ? p.text : ''))
          .join('')
          .trim();
        if (text) out.push({ role: 'assistant', content: text });
      }
    }
    return out;
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

  private onToolCall(e: Extract<IpcEvent<'ai:event'>, { type: 'tool-call' }>): void {
    const step: Step = {
      callId: e.callId,
      name: e.name,
      input: e.input,
      risk: e.risk,
      status: needsApproval(e.risk) ? 'awaiting' : 'running',
      canUndo: false,
    };
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

  private async execute(step: Step): Promise<void> {
    const runId = this.runId;
    if (!runId) return;
    this.patchStep(step.callId, { status: 'running' });
    try {
      const r = await runRendererTool(step.name, step.input, this.deps.toolContext());
      if (r.undo && undoable(step.name)) this.undos.set(step.callId, r.undo);
      this.patchStep(step.callId, {
        status: 'done',
        summary: r.summary,
        canUndo: this.undos.has(step.callId),
      });
      await this.deps.bridge?.invoke('ai:toolResult', {
        runId,
        callId: step.callId,
        approved: true,
        result: r.result,
      });
    } catch (e) {
      const message = e instanceof ToolError ? e.message : SESSION_TEXT.failed;
      this.patchStep(step.callId, { status: 'error', summary: message });
      await this.deps.bridge?.invoke('ai:toolResult', {
        runId,
        callId: step.callId,
        approved: true,
        error: message,
      });
    }
  }

  /**
   * Approve a step whose run has ended (restored after a restart, or from a resumed
   * conversation): run the tool here and note the outcome in the reply, so the next message
   * tells the model what happened.
   */
  private async executeDetached(step: Step): Promise<void> {
    this.patchStep(step.callId, { status: 'running' });
    let note: string;
    try {
      const r = await runRendererTool(step.name, step.input, this.deps.toolContext());
      if (r.undo && undoable(step.name)) this.undos.set(step.callId, r.undo);
      this.patchStep(step.callId, {
        status: 'done',
        summary: r.summary,
        canUndo: this.undos.has(step.callId),
      });
      note = `Approved later and run: ${step.name}, ${r.summary}.`;
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
