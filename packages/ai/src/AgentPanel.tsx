import type { AioBridge, ConversationSummary, WindowKind } from '@aio/schema';
import { useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { bindingLabel } from './context';
import { PANEL_CSS } from './panel-css';
import { formatMeter, totalUsage } from './pricing';
import { WINDOW_LABELS } from './prompt';
import { defaultToolContext } from './renderer-tools';
import { modelLabel, PROVIDER_LABELS } from './routes';
import {
  AgentSession,
  type AgentFix,
  type Availability,
  type SendPreview,
  type Step,
  type Turn,
} from './session';
import { SUGGESTIONS } from './suggestions';
import { getToolSpec } from './tools';

/** What the app's fix card gets when a reply failed with an error it can fix in place. */
export interface AgentFixControls {
  fix: AgentFix;
  /** Send the failed message again (call once the fix is in place). */
  retry: () => Promise<void>;
  /** Hide the card; the error stays in the conversation. */
  dismiss: () => void;
}

export interface AgentPanelProps {
  /** The window this agent is bound to; its context travels with every message. */
  window: WindowKind;
  className?: string;
  /**
   * An inline card under a reply that failed with a fixable provider error (AiErrorCode), for
   * example the Anthropic workspace ID. The app renders it, so it can use its settings and strings.
   */
  renderFix?: (controls: AgentFixControls) => ReactNode;
}

const CAPTURE_WINDOWS: readonly WindowKind[] = ['video', 'scene3d', 'pointcloud', 'photo', 'map'];

function getBridge(): AioBridge | null {
  return (globalThis as { aio?: AioBridge }).aio ?? null;
}

function providerName(provider: string): string {
  return provider in PROVIDER_LABELS
    ? PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS]
    : provider;
}

/**
 * Agent panel: conversation, tool steps with approve, reject and undo, history, send preview and
 * the session and project meters. Sends through window.aio 'ai:send', executes renderer tools on
 * 'ai:event' tool calls. Owner: stream S9.
 */
export function AgentPanel({ window: win, className, renderFix }: AgentPanelProps) {
  const [session] = useState(
    () =>
      new AgentSession({
        bridge: getBridge(),
        window: win,
        toolContext: () => defaultToolContext(win),
      }),
  );
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const binding = useWorkspace((s) => bindingLabel(win, s));
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const [draft, setDraft] = useState('');
  const [attach, setAttach] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    session.setWindow(win);
  }, [session, win]);

  useEffect(() => {
    const disconnect = session.connect();
    const onFocus = () => {
      void session.refresh();
    };
    globalThis.addEventListener('focus', onFocus);
    return () => {
      globalThis.removeEventListener('focus', onFocus);
      disconnect();
    };
  }, [session]);

  // A different project: a fresh conversation, its consent, policy and meter.
  useEffect(() => {
    session.reset();
    setShowHistory(false);
    void session.refresh();
  }, [session, projectId]);

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.turns, state.steps, state.fix]);

  const ready = state.availability.status === 'ready';
  const canCapture = CAPTURE_WINDOWS.includes(win);
  const submit = (text: string) => {
    if (!ready || state.busy || !text.trim()) return;
    void session.send(text, { attachFrame: attach && canCapture });
    setDraft('');
    setAttach(false);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(draft);
    } else if (e.key === 'Escape' && state.busy) {
      session.cancel();
    }
  };
  const tokens = state.usage.inputTokens + state.usage.outputTokens;
  const project = totalUsage(state.projectUsage);
  const projectTokens = project.inputTokens + project.outputTokens;
  const route = state.availability.status === 'ready' ? state.availability.route : null;
  const cloud = state.availability.status === 'ready' && state.availability.cloud;
  const answerOnly = state.availability.status === 'ready' ? state.availability.notice : undefined;
  const openHistory = () => {
    setShowHistory((v) => !v);
    void session.listHistory();
  };
  const exportChat = async () => {
    const r = await session.exportMarkdown();
    setNotice(r.error ?? (r.path ? `Saved to ${r.path}` : null));
  };

  return (
    <section className={['aio-agent', className].filter(Boolean).join(' ')} aria-label="Agent">
      <style href="aio-agent-panel" precedence="default">
        {PANEL_CSS}
      </style>
      <header className="ag-h">
        <h3>
          <Icon name="agent" />
          Agent
        </h3>
        <span className="ag-bind" title={`This agent sees the ${WINDOW_LABELS[win]} window`}>
          {binding}
        </span>
        <div className="acts">
          <button
            type="button"
            className="ag-btn ghost icon"
            title="Conversations in this project"
            aria-label="Conversations in this project"
            aria-pressed={showHistory}
            disabled={!projectId}
            onClick={openHistory}
          >
            <Icon name="history" />
          </button>
          <button
            type="button"
            className="ag-btn ghost icon"
            title="Export this conversation as Markdown"
            aria-label="Export this conversation as Markdown"
            disabled={state.turns.length === 0}
            onClick={() => void exportChat()}
          >
            <Icon name="download" />
          </button>
          <button
            type="button"
            className="ag-btn ghost icon"
            title="New conversation"
            aria-label="New conversation"
            disabled={state.turns.length === 0}
            onClick={() => {
              session.reset();
              setShowHistory(false);
            }}
          >
            <Icon name="new" />
          </button>
        </div>
      </header>

      {/* a log: new messages are read as they arrive; busy holds a streaming reply back until it
          is complete, so it is read once and whole */}
      <div
        className="ag-log"
        ref={log}
        role="log"
        aria-live="polite"
        aria-busy={state.busy}
        aria-label="Agent conversation"
      >
        {showHistory ? (
          <History
            items={state.history}
            current={state.id}
            onOpen={(id) => {
              void session.resume(id).then((error) => {
                setNotice(error);
                if (!error) setShowHistory(false);
              });
            }}
          />
        ) : state.availability.status === 'disabled' && state.turns.length === 0 ? (
          <Disabled availability={state.availability} onRetry={() => void session.refresh()} />
        ) : state.turns.length === 0 ? (
          <div className="ag-empty">
            <p>Ask about this {WINDOW_LABELS[win].toLowerCase()} or tell the agent what to do.</p>
            {SUGGESTIONS[win].map((s) => (
              <button
                key={s}
                type="button"
                className="ag-sug"
                disabled={!ready}
                onClick={() => {
                  submit(s);
                }}
              >
                {s}
              </button>
            ))}
          </div>
        ) : (
          <>
            {state.turns.map((t) => (
              <TurnView
                key={t.id}
                turn={t}
                steps={state.steps}
                who={
                  route ? `${modelLabel(route.model)} · ${providerName(route.provider)}` : 'Agent'
                }
                session={session}
              />
            ))}
            {state.fix &&
              renderFix?.({
                fix: state.fix,
                retry: () => session.retry(),
                dismiss: () => {
                  session.dismissFix();
                },
              })}
          </>
        )}
      </div>

      <footer className="ag-in">
        {answerOnly && (
          <div className="ag-note" role="status" data-testid="agent-answer-only">
            {answerOnly}
          </div>
        )}
        {(notice ?? state.saveError) && (
          <div className="ag-note" role="status">
            {state.saveError ? `History is not saved: ${state.saveError}` : notice}
            <button
              type="button"
              className="ag-btn ghost icon"
              aria-label="Dismiss"
              onClick={() => {
                setNotice(null);
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        )}
        <div className="ag-box">
          <textarea
            value={draft}
            placeholder={
              ready ? 'Ask about this view, or tell the agent what to do' : 'Agent is off'
            }
            aria-label="Message the agent"
            disabled={!ready}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
            onKeyDown={onKey}
          />
          <div className="ag-row">
            <span className="ag-tag">{WINDOW_LABELS[win]}</span>
            <span className="sp" />
            {canCapture && (
              <button
                type="button"
                className="ag-btn ghost icon"
                title="Attach the current frame to the next message"
                aria-label="Attach the current frame"
                aria-pressed={attach}
                disabled={!ready || state.busy}
                onClick={() => {
                  setAttach((a) => !a);
                }}
              >
                <Icon name="camera" />
              </button>
            )}
            {state.busy ? (
              <button
                type="button"
                className="ag-btn icon"
                title="Stop (Esc)"
                aria-label="Stop"
                onClick={() => {
                  session.cancel();
                }}
              >
                <Icon name="stop" />
              </button>
            ) : (
              <button
                type="button"
                className="ag-btn primary icon"
                title="Send (Enter)"
                aria-label="Send"
                disabled={!ready || !draft.trim()}
                onClick={() => {
                  submit(draft);
                }}
              >
                <Icon name="send" />
              </button>
            )}
          </div>
        </div>
        <div className="ag-row">
          <span>
            {route
              ? route.provider === 'local'
                ? `Agent: local (offline) · ${modelLabel(route.model)} on this machine`
                : `${modelLabel(route.model)} · ${cloud ? 'cloud' : 'on this machine'}`
              : 'Agent off'}
          </span>
          <span className="sp" />
          <span
            className="ag-mono"
            title={`${String(state.usage.inputTokens)} input and ${String(state.usage.outputTokens)} output tokens in this conversation; cost is an estimate`}
          >
            {formatMeter(tokens, state.usage.costKnown ? state.usage.costUsd : undefined)}
          </span>
        </div>
        {projectId && (
          <div className="ag-row ag-proj">
            <span>This project</span>
            <span className="sp" />
            <span
              className="ag-mono"
              title={`${String(project.inputTokens)} input and ${String(project.outputTokens)} output tokens in this project on this workstation; cost is an estimate`}
            >
              {formatMeter(projectTokens, project.costKnown ? project.costUsd : undefined)}
            </span>
          </div>
        )}
      </footer>
      {state.preview && (
        <PreviewDialog
          preview={state.preview}
          projectName={projectNameOf(state.preview)}
          onCancel={() => {
            session.cancelPreview();
          }}
          onSend={(always) => void session.confirmPreview({ always })}
        />
      )}
    </section>
  );
}

function projectNameOf(p: SendPreview): string {
  const project = p.context.project as { name?: unknown } | null | undefined;
  return typeof project?.name === 'string' ? project.name : 'this project';
}

/** AI-6: exactly what leaves the machine with this message, before the first send in a project. */
function PreviewDialog({
  preview,
  projectName,
  onCancel,
  onSend,
}: {
  preview: SendPreview;
  projectName: string;
  onCancel: () => void;
  onSend: (always: boolean) => void;
}) {
  const [always, setAlways] = useState(false);
  const sendRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    sendRef.current?.focus();
  }, []);
  return (
    <div
      className="ag-modal-back"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div className="ag-modal" role="dialog" aria-modal="true" aria-labelledby="ag-prev-h">
        <h4 id="ag-prev-h">Send to {providerName(preview.route.provider)}?</h4>
        <p className="ag-sub">
          This is the first message to a cloud provider in {projectName}. This is exactly what
          leaves this workstation:
        </p>
        <dl className="ag-sent">
          <dt>Provider and model</dt>
          <dd className="ag-mono">
            {providerName(preview.route.provider)} · {preview.route.model}
          </dd>
          <dt>Your message</dt>
          <dd>{preview.text}</dd>
          <dt>Window context (text)</dt>
          <dd>
            <pre>{JSON.stringify(preview.context, null, 2)}</pre>
          </dd>
          <dt>Attached frame</dt>
          <dd>
            {preview.image ? (
              <img src={preview.image} alt="The frame that will be sent" />
            ) : (
              <span className="ag-faint">None</span>
            )}
          </dd>
        </dl>
        <p className="ag-sub">
          Later frames and other data-sending steps still ask before they run.
        </p>
        <label className="ag-check">
          <input
            type="checkbox"
            checked={always}
            onChange={(e) => {
              setAlways(e.target.checked);
            }}
          />
          Always allow for this project
        </label>
        <div className="ag-modal-acts">
          <button type="button" className="ag-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={sendRef}
            type="button"
            className="ag-btn primary"
            onClick={() => {
              onSend(always);
            }}
          >
            <Icon name="send" size={12} />
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function History({
  items,
  current,
  onOpen,
}: {
  items: ConversationSummary[] | null;
  current: string;
  onOpen: (id: string) => void;
}) {
  if (items === null) return <p className="ag-faint">Loading conversations</p>;
  if (items.length === 0) {
    return (
      <div className="ag-empty">
        <p>No saved conversations in this project yet. Conversations save as you go.</p>
      </div>
    );
  }
  return (
    <ul className="ag-hist" aria-label="Saved conversations">
      {items.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            aria-current={c.id === current}
            onClick={() => {
              onOpen(c.id);
            }}
          >
            <b>{c.title || 'Untitled conversation'}</b>
            <span className="ag-mono">
              {c.updatedAt.slice(0, 16).replace('T', ' ')} · {WINDOW_LABELS[c.window]} ·{' '}
              {String(c.turns)} messages
            </span>
            {c.pending > 0 && (
              <span className="ag-pending">
                {c.pending === 1 ? '1 approval waiting' : `${String(c.pending)} approvals waiting`}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

const OFF_HELP: Partial<Record<string, string[]>> = {
  'cloud-off': [
    'Open Settings, Privacy and cloud.',
    'Switch on Allow cloud AI.',
    'Add an API key for Anthropic, OpenAI or Google Gemini in Settings, AI providers.',
  ],
  'no-key': ['Open Settings, AI providers.', 'Add an API key for the provider of Agent chat.'],
  'local-off': ['Open Settings, AI providers.', 'Turn on the local model and check its address.'],
};

function Disabled({ availability, onRetry }: { availability: Availability; onRetry: () => void }) {
  if (availability.status !== 'disabled') return null;
  const help = OFF_HELP[availability.reason];
  return (
    <div className="ag-off" role="status">
      <b>The agent is off</b>
      <p>{availability.message}</p>
      {help && (
        <ol>
          {help.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ol>
      )}
      {availability.reason !== 'no-bridge' && (
        <div>
          <button type="button" className="ag-btn sm" onClick={onRetry}>
            Check again
          </button>
        </div>
      )}
    </div>
  );
}

function TurnView({
  turn,
  steps,
  who,
  session,
}: {
  turn: Turn;
  steps: Record<string, Step>;
  who: string;
  session: AgentSession;
}) {
  if (turn.kind === 'user') {
    return (
      <div className="ag-msg user">
        {turn.text}
        {(turn.chips.length > 0 || turn.frame) && (
          <div className="ag-ctx">
            {turn.frame && (
              <span className="ag-tag">
                <Icon name="camera" size={11} />
                frame
              </span>
            )}
            {turn.chips.map((c) => (
              <span key={c} className="ag-tag">
                {c}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  // Group consecutive steps into one box, keep text in between.
  const blocks: ReactNode[] = [];
  let group: Step[] = [];
  const flush = (key: string) => {
    if (group.length === 0) return;
    blocks.push(<Steps key={key} steps={group} session={session} />);
    group = [];
  };
  turn.parts.forEach((p, i) => {
    if (p.type === 'step') {
      const s = steps[p.callId];
      if (s) group.push(s);
    } else {
      flush(`g${i}`);
      blocks.push(<span key={`t${i}`}>{p.text}</span>);
    }
  });
  flush('gend');
  return (
    <div className="ag-msg">
      <div className="ag-who">
        <Icon name="agent" size={12} />
        <b>{who}</b>
      </div>
      {blocks}
      {turn.status === 'streaming' && turn.parts.length === 0 && (
        <span className="typing" aria-label="Working">
          <i />
          <i />
          <i />
        </span>
      )}
      {turn.status === 'error' && <div className="ag-err">{turn.error}</div>}
      {turn.status === 'stopped' && <div className="ag-stopped">Stopped.</div>}
    </div>
  );
}

const STATUS_TEXT: Record<Step['status'], string> = {
  running: 'running',
  awaiting: 'needs approval',
  done: 'done',
  rejected: 'rejected',
  error: 'failed',
  undone: 'undone',
  cancelled: 'not run',
};

function Steps({ steps, session }: { steps: Step[]; session: AgentSession }) {
  return (
    <div className="steps">
      {steps.map((s) => (
        <StepRow key={s.callId} step={s} session={session} />
      ))}
    </div>
  );
}

function StepRow({ step, session }: { step: Step; session: AgentSession }) {
  const icon =
    step.status === 'done'
      ? 'check'
      : step.status === 'awaiting' || step.status === 'running'
        ? 'clock'
        : step.status === 'undone'
          ? 'undo'
          : 'x';
  return (
    <>
      <div className={`step ${step.status}`}>
        <span className="si">
          <Icon name={icon} size={14} />
        </span>
        <code title={JSON.stringify(step.input)}>{step.name}</code>
        <span className="sr">
          <span title={step.summary}>{step.summary ?? STATUS_TEXT[step.status]}</span>
          {step.canUndo && step.status === 'done' && (
            <button
              type="button"
              className="ag-btn ghost sm"
              onClick={() => {
                session.undo(step.callId);
              }}
            >
              <Icon name="undo" size={12} />
              Undo
            </button>
          )}
        </span>
      </div>
      {step.status === 'awaiting' && (
        <div className="approve">
          <span className="note">{describeStep(step)}</span>
          <button
            type="button"
            className="ag-btn sm"
            onClick={() => {
              session.reject(step.callId);
            }}
          >
            Reject
          </button>
          <button
            type="button"
            className="ag-btn sm primary"
            onClick={() => void session.approve(step.callId)}
          >
            <Icon name="check" size={12} />
            Approve
          </button>
        </div>
      )}
    </>
  );
}

/** What an approval will do, in one line. */
export function describeStep(step: Pick<Step, 'name' | 'input'>): string {
  const input = (step.input ?? {}) as Record<string, unknown>;
  if (step.name === 'create_issue_draft') {
    const title = typeof input.title === 'string' ? input.title : 'untitled';
    const sev =
      typeof input.severity === 'number' || typeof input.severity === 'string'
        ? input.severity
        : '?';
    return `Adds draft issue "${title}", severity ${String(sev)}`;
  }
  if (step.name === 'capture_frame') return 'Sends the current frame to the AI provider';
  if (step.name === 'export_issues') return 'Writes the matching issues to a CSV file you choose';
  const description = getToolSpec(step.name)?.meta.description;
  return description ?? `Runs ${step.name}`;
}

type IconName =
  | 'agent'
  | 'check'
  | 'clock'
  | 'x'
  | 'undo'
  | 'send'
  | 'stop'
  | 'camera'
  | 'new'
  | 'history'
  | 'download';

const PATHS: Record<IconName, string> = {
  agent:
    'M10 2.5c.6 3.9 3.6 6.9 7.5 7.5-3.9.6-6.9 3.6-7.5 7.5-.6-3.9-3.6-6.9-7.5-7.5 3.9-.6 6.9-3.6 7.5-7.5z',
  check: 'M4 10.5l4 4 8-9',
  clock: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM10 6v4l3 2',
  x: 'M5 5l10 10M15 5L5 15',
  undo: 'M7 5L3 9l4 4M3 9h9a5 5 0 0 1 0 10h-2',
  send: 'M3 10l14-6-6 14-2-6-6-2z',
  stop: 'M6 6h8v8H6z',
  camera: 'M3 7h3l1.5-2h5L14 7h3v9H3zM10 9a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  new: 'M10 4v12M4 10h12',
  history: 'M3.5 10a6.5 6.5 0 1 0 2-4.7M3 3v3h3M10 6.5V10l2.5 1.5',
  download: 'M10 3v9M6 8.5l4 4 4-4M4 15.5h12',
};

function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill={name === 'agent' || name === 'stop' ? 'currentColor' : 'none'}
      stroke={name === 'agent' || name === 'stop' ? 'none' : 'currentColor'}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
