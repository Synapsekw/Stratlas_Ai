/**
 * One agent conversation bound to one window, in the renderer. Sends messages over `ai:send`,
 * listens to `ai:event`, runs tool calls (asking first for write and send risk), keeps undo
 * functions and the token meter. Framework-free so it can be tested without a DOM; AgentPanel
 * renders it.
 */
import {
  needsApproval,
  type AioBridge,
  type ChatMessage,
  type IpcEvent,
  type ToolRisk,
  type WindowKind,
} from '@aio/schema';
import { assembleContext } from './context';
import { runRendererTool, ToolError, type RendererToolContext } from './renderer-tools';
import { missingKeyMessage, PROVIDER_LABELS, routeFor, type ModelRoute } from './routes';
import { undoable } from './tools';

export type StepStatus =
  'running' | 'awaiting' | 'done' | 'rejected' | 'error' | 'undone' | 'cancelled';

export interface Step {
  callId: string;
  name: string;
  input: unknown;
  risk: ToolRisk;
  status: StepStatus;
  summary?: string;
  /** An undo function is held for this step. */
  canUndo: boolean;
}

export type Part = { type: 'text'; text: string } | { type: 'step'; callId: string };

export type Turn =
  | { kind: 'user'; id: string; text: string; chips: string[]; frame: boolean }
  | {
      kind: 'assistant';
      id: string;
      runId: string;
      parts: Part[];
      status: 'streaming' | 'done' | 'error' | 'stopped';
      error?: string;
    };

export type Availability =
  | { status: 'checking' }
  | { status: 'ready'; route: ModelRoute }
  | { status: 'disabled'; reason: 'no-bridge' | 'cloud-off' | 'no-key'; message: string };

export interface SessionState {
  turns: Turn[];
  steps: Record<string, Step>;
  usage: { inputTokens: number; outputTokens: number; costUsd: number; costKnown: boolean };
  busy: boolean;
  availability: Availability;
}

export interface SessionDeps {
  bridge: AioBridge | null;
  window: WindowKind;
  toolContext: () => RendererToolContext;
  newId?: () => string;
}

export const SESSION_TEXT = {
  noBridge: 'The agent runs in the desktop app.',
  cloudOff:
    'Cloud AI is off. Turn it on in Settings, AI providers, and add a key for Anthropic, OpenAI or Google Gemini.',
  failed: 'This action failed in the app.',
  noResponse: 'The agent did not answer. Try again.',
  stopped: 'Stopped.',
} as const;

type Listener = () => void;

export class AgentSession {
  private state: SessionState = {
    turns: [],
    steps: {},
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true },
    busy: false,
    availability: { status: 'checking' },
  };
  private readonly listeners = new Set<Listener>();
  private readonly undos = new Map<string, () => void>();
  private runId: string | null = null;
  private off: (() => void) | null = null;
  private readonly newId: () => string;

  constructor(private readonly deps: SessionDeps) {
    this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  }

  getState = (): SessionState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** Start listening to `ai:event`. Returns the matching disconnect (stops a running reply). */
  connect(): () => void {
    this.off?.();
    const off =
      this.deps.bridge?.on('ai:event', (e) => {
        this.onEvent(e);
      }) ?? (() => undefined);
    this.off = off;
    return () => {
      if (this.runId) this.cancel();
      off();
      if (this.off === off) this.off = null;
    };
  }

  /** Check cloud AI and the key for the chat route. Call on mount and after Settings change. */
  async refresh(): Promise<void> {
    const bridge = this.deps.bridge;
    if (!bridge) {
      this.set({
        availability: { status: 'disabled', reason: 'no-bridge', message: SESSION_TEXT.noBridge },
      });
      return;
    }
    try {
      const settings = await bridge.invoke('settings:get', {});
      if (!settings.cloudAi) {
        this.set({
          availability: { status: 'disabled', reason: 'cloud-off', message: SESSION_TEXT.cloudOff },
        });
        return;
      }
      const route = routeFor(settings.routes, 'chat');
      const { present } = await bridge.invoke('ai:hasKey', { provider: route.provider });
      this.set({
        availability: present
          ? { status: 'ready', route }
          : {
              status: 'disabled',
              reason: 'no-key',
              message: missingKeyMessage(PROVIDER_LABELS[route.provider]),
            },
      });
    } catch (e) {
      this.set({
        availability: {
          status: 'disabled',
          reason: 'no-key',
          message: e instanceof Error ? e.message : SESSION_TEXT.noResponse,
        },
      });
    }
  }

  async send(text: string, opts: { attachFrame?: boolean } = {}): Promise<void> {
    const bridge = this.deps.bridge;
    const trimmed = text.trim();
    if (!bridge || !trimmed || this.state.busy) return;
    const ctx = this.deps.toolContext();
    const context = assembleContext(ctx.workspace.getState(), this.deps.window);
    let image: string | undefined;
    if (opts.attachFrame) image = (await ctx.captureFrame(this.deps.window)) ?? undefined;
    const runId = this.newId();
    const history = this.history();
    const user: Turn = {
      kind: 'user',
      id: this.newId(),
      text: trimmed,
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
    this.set({ turns: [...this.state.turns, user, reply], busy: true });
    const messages: ChatMessage[] = [...history, { role: 'user', content: trimmed }];
    try {
      const res = await bridge.invoke('ai:send', {
        runId,
        window: this.deps.window,
        context,
        messages,
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
    await this.execute(step);
  }

  reject(callId: string): void {
    const step = this.state.steps[callId];
    if (step?.status !== 'awaiting' || !this.runId) return;
    this.patchStep(callId, { status: 'rejected', summary: 'Rejected' });
    void this.deps.bridge?.invoke('ai:toolResult', { runId: this.runId, callId, approved: false });
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

  /** Clear the conversation (not the project). */
  reset(): void {
    if (this.runId) this.cancel();
    this.undos.clear();
    this.set({
      turns: [],
      steps: {},
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true },
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
        this.set({
          usage: {
            inputTokens: u.inputTokens + e.inputTokens,
            outputTokens: u.outputTokens + e.outputTokens,
            costUsd: u.costUsd + (e.costUsd ?? 0),
            costKnown: u.costKnown && e.costUsd !== undefined,
          },
        });
        break;
      }
      case 'done':
        this.finish(e.runId, 'done');
        break;
      case 'error':
        if (turn.status === 'streaming') this.finish(e.runId, 'error', e.message);
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
    this.updateReply(e.runId, (t) => ({
      ...t,
      parts: [...t.parts, { type: 'step', callId: e.callId }],
    }));
    this.set({ steps: { ...this.state.steps, [e.callId]: step } });
    if (step.status === 'running') void this.execute(step);
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
    if (this.runId === runId) this.runId = null;
    this.set({ steps, busy: this.runId !== null });
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

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
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
