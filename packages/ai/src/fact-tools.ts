/**
 * Executors of the fact index tools (M1): `query_facts` and `history_of`. The index is main's
 * (`@aio/facts`, SQLite with FTS5); this side asks for it through `window.aio` (`facts:query`,
 * `facts:history`) and hands the model a compact view. Specs in fact-tool-specs.ts.
 */
import { FACT_KINDS, type AioBridge, type Fact, type FactQuery } from '@aio/schema';
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

async function query(projectId: string, q: FactQuery) {
  const r = await bridge().invoke('facts:query', { projectId, query: q });
  if (!r.ok) throw new ToolError(r.error);
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
  const r = await query(projectId, q);
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

/**
 * The one subject a name means, from a text search of the index: the subject every hit shares,
 * else the one whose name is exactly the name. Several subjects: refused, each listed with its
 * id, so nothing is read on a guess.
 */
export async function resolveSubject(projectId: string, name: string): Promise<string> {
  const r = await query(projectId, { text: name, limit: 10 });
  const subjects = new Map<string, Fact>();
  for (const f of r.facts) if (!subjects.has(f.subject)) subjects.set(f.subject, f);
  if (subjects.size === 0)
    throw new ToolError(
      `Nothing in the fact index is called "${name}". Use query_facts to find its subject id.`,
    );
  const [only] = subjects.keys();
  if (subjects.size === 1 && only) return only;
  const q = name.trim().toLowerCase();
  const exact = [...subjects.values()].filter((f) =>
    r.facts.some((h) => h.subject === f.subject && h.label.trim().toLowerCase() === q),
  );
  if (exact.length === 1 && exact[0]) return exact[0].subject;
  const list = [...subjects.values()].map((f) => `${f.subject} (${f.kind} "${f.label}")`);
  throw new ToolError(
    `"${name}" fits several things: ${list.join(', ')}. Ask history_of again with one subject id.`,
  );
}

/** At most this many of each list reach the model; the most recent are kept. */
const HISTORY_ROWS = 60;

define('history_of', async (input, ctx) => {
  const projectId = project(ctx).id;
  const ref = input.subject.trim();
  const subject = isSubjectId(ref) ? ref : await resolveSubject(projectId, ref);
  const r = await bridge().invoke('facts:history', { projectId, subject });
  if (!r.ok) throw new ToolError(r.error);
  const h = r.history;
  const n = h.facts.length + h.linked.length + h.events.length;
  if (n === 0)
    throw new ToolError(
      `The fact index has nothing about "${subject}". Use query_facts to find a subject id.`,
    );
  const keep = <T>(xs: readonly T[]) => xs.slice(-HISTORY_ROWS);
  const omitted = {
    facts: Math.max(0, h.facts.length - HISTORY_ROWS),
    linked: Math.max(0, h.linked.length - HISTORY_ROWS),
    events: Math.max(0, h.events.length - HISTORY_ROWS),
  };
  const label = h.facts.find((f) => f.label)?.label ?? subject;
  return {
    result: {
      subject: h.subject,
      label,
      facts: keep(h.facts).map(factRow),
      linked: keep(h.linked).map((l) => ({ rel: l.rel, ...factRow(l.fact) })),
      events: keep(h.events).map(eventRow),
      ...(omitted.facts + omitted.linked + omitted.events > 0
        ? { omitted, note: 'The oldest entries are left out; the newest are shown.' }
        : {}),
    },
    summary: say(
      'agentTool.summary.history',
      { count: n, label },
      `${label}: ${n === 1 ? '1 entry' : `${String(n)} entries`}`,
    ),
  };
});
