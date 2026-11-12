import {
  AGENT_MEMORY_MAX_NOTES,
  AGENT_NOTE_MAX_CHARS,
  type AgentNote,
  type AiTask,
  type AioBridge,
  type ConversationSummary,
  type WindowKind,
} from '@aio/schema';
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
import { WINDOW_LABELS, WINDOW_SUBJECTS } from './prompt';
import { defaultToolContext } from './renderer-tools';
import { describedByApp } from './tool-kit';
import { modelLabel, PROVIDER_LABELS } from './routes';
import { SendDialog } from './SendDialog';
import {
  AgentSession,
  type AgentFix,
  type Availability,
  type SendPreview,
  type Step,
  type Turn,
} from './session';
import { suggestionsFor } from './suggestions';
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
  /** The route the messages go to (`build` while the Model builder is open); default chat. */
  task?: AiTask | undefined;
  /**
   * Changes when the AI settings change (cloud switch, routes, local model): the panel checks its
   * route again, as it does when the window gets the focus.
   */
  settingsKey?: string | undefined;
  /**
   * A session owned by the app, so the conversation outlives this panel. The owner connects it,
   * resets it when the project changes and keeps its tool context; the panel only shows it.
   */
  session?: AgentSession | undefined;
  /** A status beside the binding in the header, as the app has it (cloud AI on or off). */
  status?: ReactNode;
  /** The app's own buttons at the end of the header (the Scene's Minimise and Maximise). */
  actions?: ReactNode;
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
export function AgentPanel({
  window: win,
  className,
  renderFix,
  task,
  settingsKey,
  session: given,
  status,
  actions,
}: AgentPanelProps) {
  const taskRef = useRef(task);
  useEffect(() => {
    taskRef.current = task;
  }, [task]);
  // A given session is not ours to start or stop: leaving this screen must not cancel its run.
  const shared = given !== undefined;
  const [session] = useState(
    () =>
      given ??
      new AgentSession({
        bridge: getBridge(),
        window: win,
        toolContext: () => defaultToolContext(win),
        task: () => taskRef.current,
      }),
  );
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const binding = useWorkspace((s) => bindingLabel(win, s));
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  // booleans, so the panel does not render again on every store change
  const hasPhotos = useWorkspace(
    (s) =>
      s.project?.manifest.layers.some((l) => l.kind === 'photos' && l.items.length > 0) ?? false,
  );
  const hasIssues = useWorkspace((s) => s.issues.length > 0);
  const hasAssets = useWorkspace(
    (s) =>
      s.project?.manifest.layers.some((l) => l.kind === 'mesh' && (l.tags?.length ?? 0) > 0) ??
      false,
  );
  const hasClips = useWorkspace(
    (s) => s.project?.manifest.layers.some((l) => l.kind === 'video') ?? false,
  );
  const [draft, setDraft] = useState('');
  const [attach, setAttach] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // A3: the project panel (notes, view capture, sending without the preview)
  const [showProject, setShowProject] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    session.setWindow(win);
  }, [session, win]);

  useEffect(() => {
    const disconnect = shared ? undefined : session.connect();
    const onFocus = () => {
      void session.refresh();
    };
    globalThis.addEventListener('focus', onFocus);
    return () => {
      globalThis.removeEventListener('focus', onFocus);
      disconnect?.();
    };
  }, [session, shared]);

  // The AI settings changed (cloud AI turned on from the palette, a route): check again.
  const seenKey = useRef(settingsKey);
  useEffect(() => {
    if (seenKey.current === settingsKey) return;
    seenKey.current = settingsKey;
    void session.refresh();
  }, [session, settingsKey]);

  // A different project: a fresh conversation, its consent, policy and meter. A session the app
  // owns is reset by the app (mounting a second screen must not wipe it); only the meter is read.
  useEffect(() => {
    if (!shared) session.reset();
    setShowHistory(false);
    setShowProject(false);
    void session.refresh();
  }, [session, shared, projectId]);

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.turns, state.steps, state.fix, state.availability.status]);

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
    setShowProject(false);
    void session.listHistory();
  };
  const openProject = () => {
    setShowProject((v) => !v);
    setShowHistory(false);
    void session.loadNotes();
  };
  const exportChat = async () => {
    const r = await session.exportMarkdown();
    setNotice(r.error ?? (r.path ? `Saved to ${r.path}` : null));
  };

  return (
    <section
      className={['aio-agent', className].filter(Boolean).join(' ')}
      aria-label="Ask AI chat"
    >
      <style href="aio-agent-panel" precedence="default">
        {PANEL_CSS}
      </style>
      <header className="ag-h">
        <h3>
          <Icon name="agent" />
          Ask AI
        </h3>
        <span className="ag-bind" title={`Ask AI sees the ${WINDOW_LABELS[win]} window`}>
          {binding}
        </span>
        {status}
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
            title="This project: notes and permissions"
            aria-label="This project: notes and permissions"
            aria-pressed={showProject}
            disabled={!projectId}
            onClick={openProject}
          >
            <Icon name="note" />
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
              setShowProject(false);
            }}
          >
            <Icon name="new" />
          </button>
          {actions}
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
        aria-label="Ask AI conversation"
      >
        {showProject && projectId ? (
          <ProjectPanel
            notes={state.notes}
            readOnly={state.notesReadOnly}
            problem={state.notesProblem}
            viewCapture={state.viewCapture}
            alwaysAllow={state.alwaysAllow}
            onAdd={(text) => session.addNote(text)}
            onDelete={(id) => session.deleteNote(id)}
            onViewCapture={(allow) => void session.setViewCapture(allow)}
            onRevoke={() => void session.revokeConsent()}
          />
        ) : showHistory ? (
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
            <p>Ask about {WINDOW_SUBJECTS[win]} or tell the agent what to do.</p>
            {suggestionsFor(win, { hasPhotos, hasIssues, hasAssets, hasClips }).map((s) => (
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
                  route ? `${modelLabel(route.model)} · ${providerName(route.provider)}` : 'Ask AI'
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
            {/* a conversation the app kept across screens outlives the agent being on: the reason
                it is off is said under it, where an empty panel says it instead of the requests */}
            <Disabled availability={state.availability} onRetry={() => void session.refresh()} />
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
            placeholder={ready ? 'Ask about this view, or tell Ask AI what to do' : 'Ask AI is off'}
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
                ? `Ask AI: local (offline) · ${modelLabel(route.model)} on this machine`
                : `${modelLabel(route.model)} · ${cloud ? 'cloud' : 'on this machine'}`
              : 'Ask AI off'}
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
    <SendDialog
      titleId="ag-prev-h"
      title={<>Send to {providerName(preview.route.provider)}?</>}
      onCancel={onCancel}
      actions={
        <>
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
        </>
      }
    >
      <p className="ag-sub">
        This is the first message to a cloud provider in {projectName}. This is exactly what leaves
        this workstation:
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
      <p className="ag-sub">Later frames and other data-sending steps still ask before they run.</p>
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
    </SendDialog>
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

/**
 * A3: what the agent keeps and may do in this project: the notes it follows (each deletable,
 * and the person can add one), view capture without asking, and sending without the preview.
 */
function ProjectPanel({
  notes,
  readOnly,
  problem,
  viewCapture,
  alwaysAllow,
  onAdd,
  onDelete,
  onViewCapture,
  onRevoke,
}: {
  notes: AgentNote[];
  readOnly: boolean;
  problem: string | null;
  viewCapture: boolean;
  alwaysAllow: boolean;
  onAdd: (text: string) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
  onViewCapture: (allow: boolean) => void;
  onRevoke: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const full = notes.length >= AGENT_MEMORY_MAX_NOTES;
  const add = async () => {
    if (!text.trim()) return;
    const e = await onAdd(text);
    setError(e);
    if (!e) setText('');
  };
  return (
    <div className="ag-pp" aria-label="This project">
      <section className="ag-pp-sec" aria-label="Project notes">
        <div className="ag-pp-head">
          <b>Notes the agent follows</b>
          <span className="ag-mono">
            {String(notes.length)} of {String(AGENT_MEMORY_MAX_NOTES)}
          </span>
        </div>
        {readOnly && (
          <p className="ag-faint">
            {problem ??
              'These notes cannot be changed here: the project is a read-only package or its folder is read only.'}
          </p>
        )}
        {notes.length === 0 ? (
          <p className="ag-faint">
            No notes yet. Ask the agent to remember something, or add a note here.
          </p>
        ) : (
          <ul className="ag-notes" aria-label="Notes">
            {notes.map((n) => (
              <li key={n.id}>
                <span className="ag-notes-text">{n.text}</span>
                <span className="ag-mono">
                  {n.by === 'agent' ? 'Saved by the agent' : 'Added by you'} ·{' '}
                  {n.createdAt.slice(0, 10)}
                </span>
                {!readOnly && (
                  <button
                    type="button"
                    className="ag-btn ghost icon"
                    title="Delete this note"
                    aria-label={`Delete note: ${n.text}`}
                    onClick={() => {
                      void onDelete(n.id).then(setError);
                    }}
                  >
                    <Icon name="x" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!readOnly && (
          <form
            className="ag-pp-add"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <input
              type="text"
              aria-label="Add a note"
              placeholder={full ? 'Delete a note to add another' : 'Add a note'}
              maxLength={AGENT_NOTE_MAX_CHARS}
              value={text}
              disabled={full}
              onChange={(e) => {
                setText(e.target.value);
              }}
            />
            <button type="submit" className="ag-btn sm" disabled={full || !text.trim()}>
              Add
            </button>
          </form>
        )}
        {error && (
          <p className="ag-err" role="alert">
            {error}
          </p>
        )}
      </section>
      <section className="ag-pp-sec" aria-label="Permissions">
        <label className="ag-pp-switch">
          <input
            type="checkbox"
            role="switch"
            checked={viewCapture}
            onChange={(e) => {
              onViewCapture(e.target.checked);
            }}
          />
          <span>Let the agent look at the view without asking</span>
        </label>
        {alwaysAllow && (
          <div className="ag-pp-row">
            <span className="ag-faint">Messages go to the cloud without the send preview.</span>
            <button type="button" className="ag-btn sm" onClick={onRevoke}>
              Stop sending without the preview
            </button>
          </div>
        )}
      </section>
    </div>
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
  // Two or more writes of this run waiting at once are approved from one card, shown under the
  // step box that holds the last of them. A view capture keeps its own card (its own choices).
  const waiting = turn.parts.flatMap((p) => {
    const s = p.type === 'step' ? steps[p.callId] : undefined;
    return s?.status === 'awaiting' && s.name !== VIEW_CAPTURE ? [s] : [];
  });
  const batch = waiting.length >= 2 ? waiting : null;
  const lastWaiting = batch?.at(-1)?.callId;
  // Group consecutive steps into one box, keep text in between.
  const blocks: ReactNode[] = [];
  let group: Step[] = [];
  const flush = (key: string) => {
    if (group.length === 0) return;
    const here = batch && group.some((s) => s.callId === lastWaiting) ? batch : null;
    blocks.push(<Steps key={key} steps={group} session={session} batch={batch} batchHere={here} />);
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

/** The tool whose card offers to allow it for the project (A3). */
const VIEW_CAPTURE = 'capture_frame';

function Steps({
  steps,
  session,
  batch,
  batchHere,
}: {
  steps: Step[];
  session: AgentSession;
  /** The waiting steps of this run approved from one card, or null. */
  batch: Step[] | null;
  /** This box shows that card (it holds the last of them). */
  batchHere: Step[] | null;
}) {
  const inBatch = new Set(batch?.map((s) => s.callId));
  return (
    <div className="steps">
      {steps.map((s) => (
        <StepRow key={s.callId} step={s} session={session} batched={inBatch.has(s.callId)} />
      ))}
      {batchHere && (
        <BatchCard
          key={batchHere.map((s) => s.callId).join(' ')}
          steps={batchHere}
          session={session}
        />
      )}
    </div>
  );
}

/**
 * One card for several waiting writes of a run: each item ticked, untick to leave it out.
 * "Approve N" runs the ticked ones in the model's order and declines the rest.
 */
function BatchCard({ steps, session }: { steps: Step[]; session: AgentSession }) {
  const [left, setLeft] = useState<ReadonlySet<string>>(() => new Set());
  const ticked = steps.filter((s) => !left.has(s.callId)).map((s) => s.callId);
  const unticked = steps.filter((s) => left.has(s.callId)).map((s) => s.callId);
  // while the batch runs (an item already running), the card waits: no second "Approve N"
  const batching = useSyncExternalStore(session.subscribe, () => session.getState().batching);
  const busy = batching || steps.some((s) => s.status === 'running');
  return (
    <div className="approve batch" role="group" aria-label="Actions waiting for approval">
      <b className="batch-head">{steps.length} actions waiting for you</b>
      <ul className="batch-list">
        {steps.map((s) => (
          <li key={s.callId}>
            <label>
              <input
                type="checkbox"
                disabled={busy}
                checked={!left.has(s.callId)}
                onChange={() => {
                  setLeft((prev) => {
                    const next = new Set(prev);
                    if (next.has(s.callId)) next.delete(s.callId);
                    else next.add(s.callId);
                    return next;
                  });
                }}
              />
              <span>{describeStep(s)}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="batch-actions">
        <button
          type="button"
          className="ag-btn sm"
          disabled={busy}
          onClick={() =>
            void session.approveBatch(
              [],
              steps.map((s) => s.callId),
            )
          }
        >
          Reject all
        </button>
        <button
          type="button"
          className="ag-btn sm primary"
          disabled={busy || ticked.length === 0}
          onClick={() => void session.approveBatch(ticked, unticked)}
        >
          <Icon name="check" size={12} />
          Approve {ticked.length}
        </button>
      </div>
    </div>
  );
}

function StepRow({
  step,
  session,
  batched = false,
}: {
  step: Step;
  session: AgentSession;
  /** Approved from the batch card, so the row has no card of its own. */
  batched?: boolean;
}) {
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
      <div
        className={`step ${step.status}`}
        {...(step.batch !== undefined ? { 'data-batch': String(step.batch) } : {})}
      >
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
      {step.note && <div className="step-note">{step.note}</div>}
      {step.status === 'awaiting' && !batched && (
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
          {step.name === VIEW_CAPTURE ? (
            <>
              <button
                type="button"
                className="ag-btn sm"
                onClick={() => void session.approve(step.callId)}
              >
                Just this once
              </button>
              {session.hasProject() && (
                <button
                  type="button"
                  className="ag-btn sm primary"
                  title="Later captures in this project run without asking. Turn it off under This project (the note button at the top of the agent)."
                  onClick={() => void session.approve(step.callId, { allowViewCapture: true })}
                >
                  <Icon name="check" size={12} />
                  Allow for this project
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="ag-btn sm primary"
              onClick={() => void session.approve(step.callId)}
            >
              <Icon name="check" size={12} />
              Approve
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** What an approval will do, in one line. */
export function describeStep(step: Pick<Step, 'name' | 'input'>): string {
  const byApp = describedByApp(step.name, step.input);
  if (byApp) return byApp;
  const input = (step.input ?? {}) as Record<string, unknown>;
  if (step.name === 'propose_class') {
    const label = typeof input.label === 'string' ? input.label : 'untitled';
    return `Create class '${label}'?`;
  }
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
  const layer = typeof input.layer === 'string' ? input.layer : 'the model';
  if (step.name === 'place_on_model') {
    const n = Array.isArray(input.ids) ? input.ids.length : 0;
    return `Place ${String(n)} ${n === 1 ? 'finding' : 'findings'} on ${layer}`;
  }
  if (step.name === 'add_sighting') {
    const issue = typeof input.issue === 'string' ? input.issue : 'the issue';
    return `Add a place to ${issue} on ${layer}`;
  }
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
  | 'note'
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
  note: 'M5 3h10v14l-5-3.5L5 17z',
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
