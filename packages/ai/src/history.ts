/**
 * The conversation as the model sees it on the next message: user and assistant text plus the tool
 * calls the agent made and what they returned, compacted, so a follow-up ("now the second one",
 * "do the same for tank 4") can use the ids, positions and figures of earlier turns. The renderer
 * builds it from the saved turns and steps (`historyFromConversation`); main repairs the pairing
 * (`pairToolHistory`) and, for small local models, flattens it to text (`flattenHistory`).
 */
import type {
  ChatMessage,
  ChatToolCall,
  ChatToolResult,
  ConversationStep,
  ConversationTurn,
} from '@aio/schema';
import type { PlainMessage } from './local';

/** About how much of one tool result travels with later messages. */
export const RESULT_MAX = 2048;
/** A tool input larger than this (as JSON) is cut the same way. */
const INPUT_MAX = 2048;
/** Hard cap of one output in a `ChatToolResult`. */
const OUTPUT_HARD_MAX = 8000;

interface Level {
  /** Longest string kept whole. */
  str: number;
  /** Items kept of a long array. */
  arr: number;
  /** Deepest nesting kept. */
  depth: number;
}

/** Tighter and tighter cuts until the text fits. Short scalars (ids, numbers) survive them all. */
const LEVELS: readonly Level[] = [
  { str: 400, arr: 40, depth: 8 },
  { str: 200, arr: 20, depth: 6 },
  { str: 120, arr: 10, depth: 5 },
  { str: 80, arr: 6, depth: 4 },
  { str: 48, arr: 3, depth: 3 },
];

function shrink(v: unknown, lvl: Level, depth: number): unknown {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? Number(v.toPrecision(9)) : null;
  if (typeof v === 'string') {
    if (v.startsWith('data:')) return '[image]';
    return v.length > lvl.str ? `${v.slice(0, lvl.str)}...` : v;
  }
  if (typeof v !== 'object') return null;
  if (depth >= lvl.depth) return Array.isArray(v) ? `[${String(v.length)} items]` : '{...}';
  if (Array.isArray(v)) {
    const kept = v.slice(0, lvl.arr).map((x) => shrink(x, lvl, depth + 1));
    if (v.length > lvl.arr) kept.push(`... ${String(v.length - lvl.arr)} more`);
    return kept;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined || typeof x === 'function') continue;
    out[k] = shrink(x, lvl, depth + 1);
  }
  return out;
}

/** JSON text of a value; a top-level `undefined` or function reads as null. */
const json = (v: unknown): string =>
  v === undefined || typeof v === 'function' ? 'null' : JSON.stringify(v);

/** Nothing cut, only images replaced: the first try of `compactValue`. */
const WHOLE: Level = { str: Number.POSITIVE_INFINITY, arr: Number.POSITIVE_INFINITY, depth: 64 };

/**
 * A tool result as compact text of at most about `max` characters: JSON with images always
 * removed, long strings cut, long arrays shortened ("... 12 more"), cut tighter until it fits. A
 * string result stays text. Ids, names, positions and numbers are short scalars, so they are kept.
 * A value that cannot be written as JSON (a cycle, a bigint) reads "Done.".
 */
export function compactValue(value: unknown, max = RESULT_MAX): string {
  try {
    if (value === undefined) return 'Done.';
    if (typeof value === 'string') {
      const s = value.startsWith('data:') ? '[image]' : value;
      return s.length > max ? `${s.slice(0, max - 3)}...` : s;
    }
    let text = json(shrink(value, WHOLE, 0));
    if (text.length <= max) return text;
    for (const lvl of LEVELS) {
      text = json(shrink(value, lvl, 0));
      if (text.length <= max) return text;
    }
    return `${text.slice(0, max - 9)}... (cut)`;
  } catch {
    return 'Done.';
  }
}

/** A tool input for the history: an object (as providers need), cut like a result when large. */
export function compactInput(input: unknown): Record<string, unknown> {
  const obj =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : input === undefined
        ? {}
        : { value: input };
  if (json(obj).length <= INPUT_MAX) return obj;
  for (const lvl of LEVELS) {
    const cut = shrink(obj, lvl, 0) as Record<string, unknown>;
    if (json(cut).length <= INPUT_MAX) return cut;
  }
  return { note: 'input too large to repeat' };
}

const cap = (s: string) =>
  s.length > OUTPUT_HARD_MAX ? `${s.slice(0, OUTPUT_HARD_MAX - 3)}...` : s;

/**
 * What one step returned, for the history. Conversations saved before results were kept have no
 * `result`: their `summary` stands in, so an older conversation still reads back complete.
 */
export function stepResult(step: ConversationStep): ChatToolResult {
  const base = { callId: step.callId, name: step.name };
  const done = step.result ?? step.summary ?? 'Done.';
  switch (step.status) {
    case 'done':
      return { ...base, status: 'ok', output: cap(done) };
    case 'undone':
      return { ...base, status: 'ok', output: cap(`${done} (The person undid this later.)`) };
    case 'error':
      return { ...base, status: 'error', output: cap(step.summary ?? 'This action failed.') };
    case 'rejected':
      return { ...base, status: 'declined', output: 'The person declined this action.' };
    case 'cancelled':
      return { ...base, status: 'error', output: 'Not run: the reply stopped before it ran.' };
    case 'awaiting':
      return {
        ...base,
        status: 'error',
        output: 'Not run yet: it waits for the person to approve it.',
      };
    case 'running':
      return { ...base, status: 'error', output: 'No result recorded.' };
  }
}

type AssistantTurn = Extract<ConversationTurn, { kind: 'assistant' }>;

/** A short closing line for a reply that ended on tool calls, by how it ended. */
function closing(t: AssistantTurn): string {
  if (t.status === 'stopped') return '(The person stopped this reply here.)';
  if (t.status === 'error') return `(This reply failed: ${t.error ?? 'no answer'}.)`;
  return '(The reply ended here.)';
}

/** The most calls one assistant message of the history carries (`ChatMessage` allows 64). */
export const CALLS_PER_MESSAGE = 64;

export interface HistoryOptions {
  /**
   * The next message goes to a cloud provider: results of steps a local model made are replaced by
   * their summary, so what stayed on this machine stays here (AI-6).
   */
  cloud?: boolean;
}

/**
 * The messages for `ai:send` from a saved conversation: user text, assistant text with the tool
 * calls it made, and a `tool` message with their results after each model step (at most 64 calls
 * per message).
 */
export function historyFromConversation(
  turns: readonly ConversationTurn[],
  steps: Readonly<Record<string, ConversationStep>>,
  options: HistoryOptions = {},
): ChatMessage[] {
  const resultOf = (s: ConversationStep): ChatToolResult =>
    options.cloud && s.provider === 'local'
      ? stepResult({ ...s, result: s.summary ?? 'Done.' })
      : stepResult(s);
  const out: ChatMessage[] = [];
  for (const t of turns) {
    if (t.kind === 'user') {
      out.push({ role: 'user', content: t.text });
      continue;
    }
    let text = '';
    let calls: ConversationStep[] = [];
    let endedOnCalls = false;
    const flush = () => {
      const toolCalls: ChatToolCall[] = calls.map((s) => ({
        callId: s.callId,
        name: s.name,
        input: compactInput(s.input),
      }));
      out.push({ role: 'assistant', content: text.trim(), toolCalls });
      out.push({ role: 'tool', results: calls.map(resultOf) });
      text = '';
      calls = [];
    };
    for (const p of t.parts) {
      if (p.type === 'text') {
        if (calls.length > 0) flush();
        text += p.text;
        endedOnCalls = false;
      } else {
        const s = steps[p.callId];
        if (!s) continue;
        // a new model step, or a full message: the calls so far get their results first
        const last = calls.at(-1);
        if (last && (last.batch !== s.batch || calls.length >= CALLS_PER_MESSAGE)) flush();
        calls.push(s);
        endedOnCalls = true;
      }
    }
    if (calls.length > 0) flush();
    if (endedOnCalls) out.push({ role: 'assistant', content: closing(t) });
    else if (text.trim()) out.push({ role: 'assistant', content: text.trim() });
  }
  return out;
}

/** Characters for a tool id the providers accept (Anthropic: letters, digits, _ and -). */
export const safeCallId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

/**
 * Clean tool ids for one whole history: each call gets an id the providers accept and no other
 * call has (a repeat gets `_2`, `_3`...); `result` gives the id of the call a result answers.
 */
export function callIdRenamer(): { call(id: string): string; result(id: string): string } {
  const used = new Set<string>();
  const latest = new Map<string, string>();
  return {
    call(id) {
      const base = safeCallId(id) || 'call';
      let clean = base;
      for (let n = 2; used.has(clean); n++) clean = `${base.slice(0, 58)}_${String(n)}`;
      used.add(clean);
      latest.set(id, clean);
      return clean;
    },
    result(id) {
      return latest.get(id) ?? safeCallId(id);
    },
  };
}

/** Characters per token, roughly, for English text and JSON. */
const CHARS_PER_TOKEN = 4;

/** How big one message is, in characters of JSON. */
const sizeOf = (m: ChatMessage) => json(m).length;

/**
 * The history cut to about `budgetTokens`: the oldest groups go first, whole (a user message, an
 * assistant text, or an assistant message with its calls together with their results; a pair is
 * never split), until it fits. The newest user message always stays, and what is left starts with
 * a user message.
 */
export function trimHistory(messages: readonly ChatMessage[], budgetTokens: number): ChatMessage[] {
  const groups: ChatMessage[][] = [];
  for (const m of messages) {
    const prev = groups.at(-1);
    if (m.role === 'tool' && prev?.[0]?.role === 'assistant' && prev.length === 1) prev.push(m);
    else groups.push([m]);
  }
  const budget = budgetTokens * CHARS_PER_TOKEN;
  let total = groups.reduce((n, g) => n + g.reduce((k, m) => k + sizeOf(m), 0), 0);
  let first = 0;
  const lastUser = groups.findLastIndex((g) => g[0]?.role === 'user');
  while (first < lastUser && total > budget) {
    total -= groups[first]?.reduce((k, m) => k + sizeOf(m), 0) ?? 0;
    first += 1;
  }
  while (first < lastUser && groups[first]?.[0]?.role !== 'user') first += 1;
  return groups.slice(first).flat();
}

const ENDED = '(The reply ended here.)';

/**
 * The history made safe to send: every tool call has exactly one result right after its message
 * (a missing one says "No result recorded"), a result without its call is dropped, and a reply that
 * ended on tool results is closed with a short line before the next user message, so a provider
 * with thinking on always sees complete earlier turns.
 */
export function pairToolHistory(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'tool') continue; // a result without its call message
    if (m.role === 'user' || !m.toolCalls?.length) {
      const prev = out.at(-1);
      if (m.role === 'user' && prev?.role === 'tool')
        out.push({ role: 'assistant', content: ENDED });
      out.push(m);
      continue;
    }
    const seen = new Set<string>();
    const calls = m.toolCalls.filter((c) => !seen.has(c.callId) && seen.add(c.callId));
    const next = messages[i + 1];
    const given = new Map<string, ChatToolResult>();
    if (next?.role === 'tool') {
      for (const r of next.results) if (!given.has(r.callId)) given.set(r.callId, r);
      i += 1;
    }
    out.push({ ...m, toolCalls: calls });
    out.push({
      role: 'tool',
      results: calls.map(
        (c) =>
          given.get(c.callId) ?? {
            callId: c.callId,
            name: c.name,
            status: 'error',
            output: 'No result recorded.',
          },
      ),
    });
  }
  return out;
}

/** How much of a tool result a small local model gets. */
const LOCAL_RESULT_MAX = 600;

/**
 * The history as text for small local models: each tool call and its result become a line in the
 * assistant's message ("[fly_to {...}: ...]"), consecutive assistant messages are joined.
 */
export function flattenHistory(messages: readonly ChatMessage[]): PlainMessage[] {
  const out: PlainMessage[] = [];
  const say = (text: string) => {
    if (!text) return;
    const last = out.at(-1);
    if (last?.role === 'assistant') last.content = `${last.content}\n${text}`.trim();
    else out.push({ role: 'assistant', content: text });
  };
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      say(m.content);
      for (const c of m.toolCalls ?? []) {
        names.set(c.callId, `${c.name} ${json(c.input)}`);
      }
    } else {
      for (const r of m.results) {
        const call = names.get(r.callId) ?? r.name;
        const output =
          r.output.length > LOCAL_RESULT_MAX
            ? `${r.output.slice(0, LOCAL_RESULT_MAX)}...`
            : r.output;
        say(`[Called ${call}: ${r.status === 'ok' ? '' : `${r.status}, `}${output}]`);
      }
    }
  }
  return out;
}
