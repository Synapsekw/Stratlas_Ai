import type { AioBridge, WindowKind } from '@aio/schema';
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
import { formatMeter } from './pricing';
import { WINDOW_LABELS } from './prompt';
import { defaultToolContext } from './renderer-tools';
import { modelLabel, PROVIDER_LABELS } from './routes';
import { AgentSession, type Availability, type Step, type Turn } from './session';
import { SUGGESTIONS } from './suggestions';
import { getToolSpec } from './tools';

export interface AgentPanelProps {
  /** The window this agent is bound to; its context travels with every message. */
  window: WindowKind;
  className?: string;
}

const CAPTURE_WINDOWS: readonly WindowKind[] = ['video', 'scene3d', 'pointcloud', 'photo', 'map'];

function getBridge(): AioBridge | null {
  return (globalThis as { aio?: AioBridge }).aio ?? null;
}

/**
 * Agent panel: conversation, tool steps with approve, reject and undo, cost meter. Sends through
 * window.aio 'ai:send', executes renderer tools on 'ai:event' tool calls. Owner: stream S9.
 */
export function AgentPanel({ window: win, className }: AgentPanelProps) {
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
  const [draft, setDraft] = useState('');
  const [attach, setAttach] = useState(false);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const disconnect = session.connect();
    void session.refresh();
    const onFocus = () => {
      void session.refresh();
    };
    globalThis.addEventListener('focus', onFocus);
    return () => {
      globalThis.removeEventListener('focus', onFocus);
      disconnect();
    };
  }, [session]);

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.turns, state.steps]);

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
  const route = state.availability.status === 'ready' ? state.availability.route : null;

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
            title="New conversation"
            aria-label="New conversation"
            disabled={state.turns.length === 0}
            onClick={() => {
              session.reset();
            }}
          >
            <Icon name="new" />
          </button>
        </div>
      </header>

      <div className="ag-log" ref={log} aria-live="polite">
        {state.availability.status === 'disabled' ? (
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
          state.turns.map((t) => (
            <TurnView
              key={t.id}
              turn={t}
              steps={state.steps}
              who={
                route ? `${modelLabel(route.model)} · ${PROVIDER_LABELS[route.provider]}` : 'Agent'
              }
              session={session}
            />
          ))
        )}
      </div>

      <footer className="ag-in">
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
          <span>{route ? `${modelLabel(route.model)} · cloud` : 'Cloud AI off'}</span>
          <span className="sp" />
          <span
            className="ag-mono"
            title={`${state.usage.inputTokens} input and ${state.usage.outputTokens} output tokens this session; cost is an estimate`}
          >
            {formatMeter(tokens, state.usage.costKnown ? state.usage.costUsd : undefined)}
          </span>
        </div>
      </footer>
    </section>
  );
}

function Disabled({ availability, onRetry }: { availability: Availability; onRetry: () => void }) {
  if (availability.status !== 'disabled') return null;
  return (
    <div className="ag-off" role="status">
      <b>The agent is off</b>
      <p>{availability.message}</p>
      {availability.reason !== 'no-bridge' && (
        <ol>
          <li>Open Settings, AI providers.</li>
          <li>Switch on Allow cloud AI.</li>
          <li>Add an API key for Anthropic, OpenAI or Google Gemini.</li>
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
  const description = getToolSpec(step.name)?.meta.description;
  return description ?? `Runs ${step.name}`;
}

type IconName = 'agent' | 'check' | 'clock' | 'x' | 'undo' | 'send' | 'stop' | 'camera' | 'new';

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
