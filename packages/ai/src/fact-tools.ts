/**
 * Executors of the fact index tools (M1): `query_facts` and `history_of`. The index is main's
 * (`@aio/facts`, SQLite with FTS5); this side asks for it through `window.aio` (`facts:query`,
 * `facts:history`) and hands the model a compact view. Specs in fact-tool-specs.ts.
 */
import {
  FACT_KINDS,
  type AioBridge,
  type Fact,
  type FactHistory,
  type FactQuery,
  type FactsUnavailable,
} from '@aio/schema';
import { factToolInputs, type FactToolInput, type FactToolName } from './fact-tool-specs';
import { captureRef } from './survey-tools';
import {
  plural,
  project,
  registerRendererTool,
  say,
  ToolError,
  type RendererToolContext,
  type ToolRunResult,
} from './tool-kit';

function bridge(): AioBridge {
  const aio = (globalThis as { aio?: AioBridge }).aio;
  if (!aio) throw new ToolError('The fact index is read by the desktop app only.');
  return aio;
}

function define<N extends FactToolName>(
  name: N,
  run: (input: FactToolInput<N>, ctx: RendererToolContext) => Promise<ToolRunResult>,
): void {
  registerRendererTool(name, (input, ctx) =>
    run(factToolInputs[name].parse(input) as FactToolInput<N>, ctx),
  );
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** A fact as the model reads it: what, about which subject, when, its figure and where from. */
export function factRow(f: Fact) {
  return {
    kind: f.kind,
    subject: f.subject,
    label: f.label,
    ...(f.date ? { date: f.date } : f.at ? { at: f.at } : {}),
    ...(f.value !== undefined
      ? { value: round(f.value), ...(f.unit ? { unit: f.unit } : {}) }
      : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.source ? { source: f.source } : {}),
    evidence: f.evidence,
  };
}

/** A journal op as the model reads it. */
const eventRow = (f: Fact) => ({
  label: f.label,
  ...(f.at ? { at: f.at } : f.date ? { date: f.date } : {}),
  ...(f.source ? { source: f.source } : {}),
});

/** Main's failure in the model's words: why the index cannot answer, and what to do. */
export function unavailable(r: {
  error: string;
  reason?: FactsUnavailable | undefined;
}): ToolError {
  if (r.reason === 'not-built')
    return new ToolError(
      'The fact index is still being built for this project. Try again shortly.',
    );
  if (r.reason === 'package')
    return new ToolError('Packages have no fact index: open the project itself to search it.');
  return new ToolError(r.error);
}

/** Why an outside app gets no project notes (the founder's call, 12 Nov 2026). */
export const NOTES_STAY_IN_APP =
  'The notes saved for this project stay in the app: outside apps cannot read them.';

/** Every kind but the project's notes (A3), for a call from an outside app. */
const OUTSIDE_KINDS = FACT_KINDS.filter((k) => k !== 'note');

async function query(projectId: string, q: FactQuery, outside = false) {
  let sent = q;
  if (outside) {
    const kinds = (q.kinds ?? OUTSIDE_KINDS).filter((k) => k !== 'note');
    if (kinds.length === 0) throw new ToolError(NOTES_STAY_IN_APP);
    sent = { ...q, kinds };
  }
  const r = await bridge().invoke('facts:query', { projectId, query: sent });
  if (!r.ok) throw unavailable(r);
  return r;
}

define('query_facts', async (input, ctx) => {
  const projectId = project(ctx).id;
  const capture = input.date ? captureRef(ctx, input.date) : undefined;
  const text = input.text?.trim();
  const q: FactQuery = {
    ...(text ? { text } : {}),
    ...(input.kinds ? { kinds: input.kinds } : {}),
    ...(capture ? { capture: capture.id } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
    ...(input.status ? { status: input.status } : {}),
    limit: input.limit,
  };
  const r = await query(projectId, q, ctx.outside);
  const rows = r.facts.slice(0, input.limit).map(factRow);
  return {
    result: {
      ...(capture ? { survey: { captureId: capture.id, date: capture.date } } : {}),
      total: r.total,
      shown: rows.length,
      ...(r.total === 0
        ? { note: 'Nothing in the fact index matches. Try fewer words or no filters.' }
        : r.total > rows.length
          ? { note: 'More facts match: narrow the search or raise limit.' }
          : {}),
      facts: rows,
    },
    summary: say('agentTool.summary.facts', { count: r.total }, plural(r.total, 'fact')),
  };
});

/** `issue:I1`, `measurement:m-3`, `photo:<layer>/<photo>`: a subject id, not a name. */
const KINDS: ReadonlySet<string> = new Set(FACT_KINDS);
export function isSubjectId(ref: string): boolean {
  const m = /^([a-z][a-z-]*):(\S.*)$/.exec(ref);
  return !!m?.[1] && KINDS.has(m[1]);
}

/** Hits read to find which subject a name means, and candidates listed when it fits several. */
const RESOLVE_HITS = 50;
const RESOLVE_LISTED = 8;

/**
 * The one subject a name means, from a text search of the index, judged on distinct subjects:
 * the subject every hit shares, else the one whose name is exactly the name. Several subjects:
 * refused, each listed with its id, so nothing is read on a guess.
 */
export async function resolveSubject(
  projectId: string,
  name: string,
  outside = false,
): Promise<string> {
  const r = await query(projectId, { text: name, limit: RESOLVE_HITS }, outside);
  const subjects = new Map<string, Fact[]>();
  for (const f of r.facts) {
    const hits = subjects.get(f.subject);
    if (hits) hits.push(f);
    else subjects.set(f.subject, [f]);
  }
  if (subjects.size === 0)
    throw new ToolError(
      `Nothing in the fact index is called "${name}". Use query_facts to find its subject id.`,
    );
  const [only] = subjects.keys();
  if (subjects.size === 1 && only) return only;
  const q = name.trim().toLowerCase();
  const exact = [...subjects.entries()].filter(([, hits]) =>
    hits.some((h) => h.label.trim().toLowerCase() === q),
  );
  if (exact.length === 1 && exact[0]) return exact[0][0];
  const all = [...subjects.values()];
  const list = all
    .slice(0, RESOLVE_LISTED)
    .map(([f]) => (f ? `${f.subject} (${f.kind} "${f.label}")` : ''));
  const more = all.length - RESOLVE_LISTED;
  throw new ToolError(
    `"${name}" fits ${String(all.length)} things: ${list.join(', ')}` +
      (more > 0 ? ` and ${String(more)} more` : '') +
      '. Ask history_of again with one subject id.',
  );
}

/** A history with the project's notes linked to it left out, for an outside app. */
function withoutNotes(h: FactHistory): FactHistory {
  const linked = h.linked.filter((l) => l.fact.kind !== 'note');
  const dropped = h.linked.length - linked.length;
  return { ...h, linked, totals: { ...h.totals, linked: Math.max(0, h.totals.linked - dropped) } };
}

/** At most this many of each list reach the model; the most recent are kept. */
const HISTORY_ROWS = 60;

const LISTS = { facts: 'facts', linked: 'linked facts', events: 'events' } as const;

define('history_of', async (input, ctx) => {
  const projectId = project(ctx).id;
  const ref = input.subject.trim();
  const subject = isSubjectId(ref) ? ref : await resolveSubject(projectId, ref, ctx.outside);
  if (ctx.outside && subject.startsWith('note:')) throw new ToolError(NOTES_STAY_IN_APP);
  const r = await bridge().invoke('facts:history', { projectId, subject });
  if (!r.ok) throw unavailable(r);
  const h = ctx.outside ? withoutNotes(r.history) : r.history;
  const n = h.totals.facts + h.totals.linked + h.totals.events;
  if (n === 0)
    throw new ToolError(
      `The fact index has nothing about "${subject}". Use query_facts to find a subject id.`,
    );
  const keep = <T>(xs: readonly T[]) => xs.slice(-HISTORY_ROWS);
  const facts = keep(h.facts);
  const linked = keep(h.linked);
  const events = keep(h.events);
  const omitted = {
    facts: Math.max(0, h.totals.facts - facts.length),
    linked: Math.max(0, h.totals.linked - linked.length),
    events: Math.max(0, h.totals.events - events.length),
  };
  const left = (Object.keys(LISTS) as (keyof typeof LISTS)[])
    .filter((k) => omitted[k] > 0)
    .map((k) => `${String(omitted[k])} older ${LISTS[k]}`);
  const label = h.facts.find((f) => f.label)?.label ?? subject;
  return {
    result: {
      subject: h.subject,
      label,
      facts: facts.map(factRow),
      linked: linked.map((l) => ({ rel: l.rel, ...factRow(l.fact) })),
      events: events.map(eventRow),
      ...(left.length > 0
        ? { omitted, note: `Left out: ${left.join(', ')}. The newest of each list are shown.` }
        : {}),
    },
    summary: say(
      'agentTool.summary.history',
      { count: n, label },
      `${label}: ${n === 1 ? '1 entry' : `${String(n)} entries`}`,
    ),
  };
});
