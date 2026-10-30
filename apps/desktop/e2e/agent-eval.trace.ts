/**
 * The record of an agent eval run and what is read from it (`agent-eval.spec.ts` writes it): per
 * suite one JSON file in the run's folder under `.agent-eval/` (git-ignored), with every case,
 * every attempt (pass^k repeats each case k times), and per turn the request, each tool step with
 * its input and how it ended, and the reply. No key and no image is in it.
 *
 * `summarizeSuite` gives pass@1, pass^k and the known gaps; `compareRuns` says per case what moved
 * between two runs (verdict and tool sequence), so a prompt or tool change can be judged before
 * and after: `pnpm eval:agent:compare` (tools/agent/agent-eval-compare.mjs).
 *
 * No runtime import on purpose: the compare script loads this file with Node's type stripping.
 */

export const TRACE_SCHEMA = 'aio.agent-eval/1';

/** One tool call as the agent panel showed it. */
export interface StepTrace {
  name: string;
  /** done, rejected (the eval rejects every approval), error, cancelled, ... */
  status: string;
  input?: unknown;
}

export interface TurnTrace {
  ask: string;
  steps: StepTrace[];
  reply: string;
  /** Why the reply failed, when it did. */
  error?: string;
  /** Why this turn did not do what was asked; absent when it did. */
  why?: string;
  /** The roadmap item expected to close this turn's gap (A1, A2...), when it is one. */
  gap?: string;
}

export interface AttemptTrace {
  /**
   * `pass`: every turn did what was asked. `fail`: a turn that is not a known gap did not.
   * `gap`: only turns that are known gaps did not. `provider`: refused for its rate limit or
   * load, twice; no verdict either way.
   */
  result: 'pass' | 'fail' | 'gap' | 'provider';
  /** Why it did not pass; empty for a pass. */
  why: string;
  turns: TurnTrace[];
  /** The case's remark for the table (whether the photo opened), or absent. */
  note?: string;
  ms?: number;
}

export interface CaseTrace {
  /** Stable across runs (`caseId` in agent-eval.grade.ts): the key of a comparison. */
  id: string;
  suite: string;
  /** The requests, joined with " / ". */
  ask: string;
  turns: number;
  /** The gaps of its turns, joined (A1, A2...): for the table. */
  gap?: string;
  /** Per turn, the roadmap item expected to close it, or null for a turn that must pass now. */
  turnGaps?: (string | null)[];
  /** Counted in the suite's pass bar. */
  core: boolean;
  attempts: AttemptTrace[];
}

export interface SuiteTrace {
  schema: typeof TRACE_SCHEMA;
  suite: string;
  demo: string;
  /** anthropic, local or scripted. */
  profile: string;
  provider: string;
  model: string;
  k: number;
  startedAt: string;
  finishedAt: string;
  /** The share of the core attempts that must pass, or null: this suite reports only. */
  passPercent: number | null;
  cases: CaseTrace[];
}

export type CaseStatus = 'pass' | 'fail' | 'flaky' | 'gap' | 'gap-closed' | 'no-verdict';

export interface CaseSummary {
  id: string;
  ask: string;
  gap?: string;
  core: boolean;
  /** The case has a turn that must pass now: its attempts count in the pass rate. */
  scored: boolean;
  /** Attempts with a verdict (not refused by the provider). */
  judged: number;
  /** Judged attempts whose turns that are not known gaps all passed. */
  passed: number;
  provider: number;
  /** The run asked it this many times (the suite's k). */
  k: number;
  /** Fewer attempts were judged than k: the provider refused some, or the run was cut short. */
  partial: boolean;
  /** Share of judged attempts that passed; null without any, or when every turn is a gap. */
  passAt1: number | null;
  /** Every judged attempt passed; null as `passAt1`. */
  passHatK: boolean | null;
  status: CaseStatus;
  /** Every attempt ran the same tool sequence. */
  consistent: boolean;
  /** The sequence most attempts ran. */
  tools: string;
}

/** The tool steps of an attempt, per turn: `find_places>fly_to | show_issue(rejected)`. */
export function toolSequence(a: AttemptTrace): string {
  return a.turns
    .map((t) =>
      t.steps.map((s) => (s.status === 'done' ? s.name : `${s.name}(${s.status})`)).join('>'),
    )
    .join(' | ');
}

function mostCommon(items: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  let best = '';
  let n = 0;
  for (const [i, c] of counts)
    if (c > n) {
      best = i;
      n = c;
    }
  return best;
}

/**
 * One case over its attempts. A failure on a turn that is not a known gap is a failure, whatever
 * the other turns; a case whose only failures are on gap turns is a known gap, and one whose every
 * attempt passed all its turns, gaps included, is a closed gap.
 */
export function summarizeCase(c: CaseTrace, k = c.attempts.length): CaseSummary {
  const judged = c.attempts.filter((a) => a.result !== 'provider');
  const passed = judged.filter((a) => a.result !== 'fail').length;
  const full = judged.filter((a) => a.result === 'pass').length;
  const failed = judged.length - passed;
  const scored = c.turnGaps ? c.turnGaps.some((g) => !g) : !c.gap;
  const sequences = c.attempts.map(toolSequence);
  let status: CaseStatus;
  if (judged.length === 0) status = 'no-verdict';
  else if (failed > 0) status = passed === 0 ? 'fail' : 'flaky';
  else if (c.gap) status = full === judged.length ? 'gap-closed' : 'gap';
  else status = 'pass';
  const rated = scored && judged.length > 0;
  return {
    id: c.id,
    ask: c.ask,
    ...(c.gap ? { gap: c.gap } : {}),
    core: c.core,
    scored,
    judged: judged.length,
    passed,
    provider: c.attempts.length - judged.length,
    k,
    partial: judged.length < k,
    passAt1: rated ? passed / judged.length : null,
    passHatK: rated ? passed === judged.length : null,
    status,
    consistent: new Set(sequences).size <= 1,
    tools: mostCommon(sequences),
  };
}

export interface SuiteSummary {
  cases: CaseSummary[];
  /** Mean pass rate over the judged attempts, on the turns that are not known gaps. */
  passAt1: number | null;
  /** Share of the rated cases whose every judged attempt passed. */
  passHatK: number | null;
  /** Attempts of the core cases: what the bar is checked on. */
  core: { judged: number; passed: number };
  gaps: number;
  gapsClosed: number;
  /** Cases with fewer judged attempts than k. */
  partial: number;
  /** Attempts the provider refused. */
  providerErrors: number;
  attempts: number;
  /** Null when the suite has no bar or nothing was judged. */
  barMet: boolean | null;
}

export function summarizeSuite(s: SuiteTrace): SuiteSummary {
  const cases = s.cases.map((c) => summarizeCase(c, s.k));
  const rated = cases.filter((c) => c.scored && c.judged > 0);
  const judged = rated.reduce((n, c) => n + c.judged, 0);
  const passed = rated.reduce((n, c) => n + c.passed, 0);
  const core = rated.filter((c) => c.core);
  const coreJudged = core.reduce((n, c) => n + c.judged, 0);
  const corePassed = core.reduce((n, c) => n + c.passed, 0);
  return {
    cases,
    passAt1: judged > 0 ? passed / judged : null,
    passHatK: rated.length > 0 ? rated.filter((c) => c.passHatK).length / rated.length : null,
    core: { judged: coreJudged, passed: corePassed },
    gaps: cases.filter((c) => c.status === 'gap').length,
    gapsClosed: cases.filter((c) => c.status === 'gap-closed').length,
    partial: cases.filter((c) => c.partial).length,
    providerErrors: cases.reduce((n, c) => n + c.provider, 0),
    attempts: s.cases.reduce((n, c) => n + c.attempts.length, 0),
    barMet:
      s.passPercent === null || coreJudged === 0
        ? null
        : corePassed * 100 >= coreJudged * s.passPercent,
  };
}

const pct = (x: number | null): string => (x === null ? '-' : `${String(Math.round(x * 100))}%`);

const STATUS_LABEL: Record<CaseStatus, string> = {
  pass: 'pass',
  fail: 'FAIL',
  flaky: 'FLAKY',
  gap: 'known gap',
  'gap-closed': 'GAP CLOSED',
  'no-verdict': 'no verdict',
};

/** "2/3 passed, 3/3 judged", with PARTIAL when fewer than k attempts have a verdict. */
const counts = (c: CaseSummary): string =>
  `${String(c.passed)}/${String(c.judged)} passed, ${String(c.judged)}/${String(c.k)} judged${c.partial ? ' PARTIAL' : ''}`;

/** The suite as a table for the run's log: one block per case, then the totals. */
export function formatSummary(s: SuiteTrace): string {
  const sum = summarizeSuite(s);
  const lines: string[] = [
    `${s.suite} on ${s.demo}: ${s.model} (${s.profile}), each case ${String(s.k)} time(s)`,
  ];
  for (const [i, c] of sum.cases.entries()) {
    const trace = s.cases[i];
    lines.push(
      `${String(i + 1).padStart(2)}  ${STATUS_LABEL[c.status]}${c.gap ? ` (${c.gap})` : ''}  ${counts(c)}  ${c.ask}`,
    );
    const why = (
      trace?.attempts.find((a) => a.result === 'fail') ??
      trace?.attempts.find((a) => a.result === 'gap')
    )?.why;
    if (why) lines.push(`    why:   ${why}`);
    lines.push(
      `    tools: ${c.tools || 'none'}${c.consistent ? '' : ' (varies between attempts)'}`,
    );
    const note = trace?.attempts.find((a) => a.note)?.note;
    if (note) lines.push(`    note:  ${note}`);
  }
  lines.push(
    `pass@1 ${pct(sum.passAt1)}, pass^${String(s.k)} ${pct(sum.passHatK)} on the turns that are not known gaps; ` +
      `${String(sum.gaps)} known gap(s), ${String(sum.gapsClosed)} closed; ` +
      `${String(sum.partial)} partial case(s); ` +
      `${String(sum.providerErrors)} of ${String(sum.attempts)} attempt(s) refused by the provider`,
  );
  if (s.passPercent !== null)
    lines.push(
      `bar: ${String(sum.core.passed)} of ${String(sum.core.judged)} core attempts passed, ${String(s.passPercent)}% needed: ${sum.barMet === null ? 'no verdict' : sum.barMet ? 'met' : 'NOT met'}`,
    );
  else lines.push('bar: none for this suite (reports only)');
  return lines.join('\n');
}

/** `unknown`: one side has no verdict (the provider refused every attempt). */
export type CaseChange = 'fixed' | 'broke' | 'same' | 'unknown' | 'new' | 'removed';

export interface ComparisonRow {
  id: string;
  ask: string;
  before: CaseSummary | null;
  after: CaseSummary | null;
  change: CaseChange;
  /** The tool sequence most attempts ran differs. */
  toolsChanged: boolean;
}

export interface Comparison {
  rows: ComparisonRow[];
  totals: {
    fixed: number;
    broke: number;
    same: number;
    unknown: number;
    new: number;
    removed: number;
    toolsChanged: number;
  };
  before: { passAt1: number | null; passHatK: number | null };
  after: { passAt1: number | null; passHatK: number | null };
}

const good = (c: CaseSummary): boolean => c.status === 'pass' || c.status === 'gap-closed';

function pooled(suites: readonly SuiteTrace[]): {
  passAt1: number | null;
  passHatK: number | null;
} {
  const cases = suites
    .flatMap((s) => summarizeSuite(s).cases)
    .filter((c) => c.scored && c.judged > 0);
  const judged = cases.reduce((n, c) => n + c.judged, 0);
  return {
    passAt1: judged > 0 ? cases.reduce((n, c) => n + c.passed, 0) / judged : null,
    passHatK: cases.length > 0 ? cases.filter((c) => c.passHatK).length / cases.length : null,
  };
}

/** Per case (by id, across every suite of each run): what moved from `before` to `after`. */
export function compareRuns(
  before: readonly SuiteTrace[],
  after: readonly SuiteTrace[],
): Comparison {
  const index = (runs: readonly SuiteTrace[]) =>
    new Map(runs.flatMap((s) => s.cases.map((c) => [c.id, summarizeCase(c, s.k)] as const)));
  const a = index(before);
  const b = index(after);
  const ids = [...new Set([...a.keys(), ...b.keys()])];
  const rows = ids.map((id): ComparisonRow => {
    const x = a.get(id) ?? null;
    const y = b.get(id) ?? null;
    const change: CaseChange = !x
      ? 'new'
      : !y
        ? 'removed'
        : x.status === 'no-verdict' || y.status === 'no-verdict'
          ? 'unknown'
          : good(x) === good(y)
            ? 'same'
            : good(y)
              ? 'fixed'
              : 'broke';
    return {
      id,
      ask: (y ?? x)?.ask ?? id,
      before: x,
      after: y,
      change,
      toolsChanged: Boolean(x && y && x.tools !== y.tools),
    };
  });
  const count = (c: CaseChange) => rows.filter((r) => r.change === c).length;
  return {
    rows,
    totals: {
      fixed: count('fixed'),
      broke: count('broke'),
      same: count('same'),
      unknown: count('unknown'),
      new: count('new'),
      removed: count('removed'),
      toolsChanged: rows.filter((r) => r.toolsChanged).length,
    },
    before: pooled(before),
    after: pooled(after),
  };
}

const CHANGE_LABEL: Record<CaseChange, string> = {
  fixed: 'fixed',
  broke: 'BROKE',
  same: 'same',
  unknown: 'unknown',
  new: 'new',
  removed: 'removed',
};

const verdict = (c: CaseSummary | null): string =>
  c ? `${STATUS_LABEL[c.status]} ${counts(c)}` : '-';

const toolsOf = (c: CaseSummary | null): string => (c && c.tools !== '' ? c.tools : 'none');

/** New or removed cases listed one by one up to this many. */
const MAX_LISTED = 10;

/** The comparison for a terminal: changed cases first, then the totals. */
export function formatComparison(cmp: Comparison): string {
  const order: CaseChange[] = ['broke', 'unknown', 'fixed', 'new', 'removed', 'same'];
  const rows = [...cmp.rows].sort(
    (p, q) => order.indexOf(p.change) - order.indexOf(q.change) || p.id.localeCompare(q.id),
  );
  const lines: string[] = [];
  // a run filtered to a few cases leaves out the rest: past ten, only their number is shown
  const many = (c: CaseChange) => rows.filter((r) => r.change === c).length > MAX_LISTED;
  for (const r of rows) {
    if (r.change === 'same' && !r.toolsChanged) continue;
    if ((r.change === 'new' || r.change === 'removed') && many(r.change)) continue;
    lines.push(`${CHANGE_LABEL[r.change].padEnd(7)}  ${r.id}`);
    lines.push(`         ${verdict(r.before)}  ->  ${verdict(r.after)}`);
    if (r.toolsChanged) {
      lines.push(`         tools before: ${toolsOf(r.before)}`);
      lines.push(`         tools after:  ${toolsOf(r.after)}`);
    }
  }
  for (const c of ['new', 'removed'] as const)
    if (many(c))
      lines.push(
        `${String(cmp.totals[c])} cases ${c === 'new' ? 'only in the later run' : 'only in the earlier run'} (a run filtered with QUADRION_EVAL_CASES?)`,
      );
  const t = cmp.totals;
  lines.push(
    `${String(t.fixed)} fixed, ${String(t.broke)} broke, ${String(t.same)} same, ${String(t.unknown)} unknown (no verdict on one side), ${String(t.new)} new, ${String(t.removed)} removed; ` +
      `tool sequence changed in ${String(t.toolsChanged)}`,
  );
  lines.push(
    `pass@1 ${pct(cmp.before.passAt1)} -> ${pct(cmp.after.passAt1)}, pass^k ${pct(cmp.before.passHatK)} -> ${pct(cmp.after.passHatK)} (turns that are not known gaps)`,
  );
  return lines.join('\n');
}

/**
 * Why two runs are not comparable, or null: they differ in profile, model or k (or a run mixes
 * them). Comparing such runs measures the setup, not a prompt or tool change.
 */
export function runMismatch(
  before: readonly SuiteTrace[],
  after: readonly SuiteTrace[],
): string | null {
  const keys = (runs: readonly SuiteTrace[]) => ({
    profile: [...new Set(runs.map((s) => s.profile))].join('+'),
    model: [...new Set(runs.map((s) => s.model))].join('+'),
    k: [...new Set(runs.map((s) => String(s.k)))].join('+'),
  });
  const a = keys(before);
  const b = keys(after);
  const diff = (['profile', 'model', 'k'] as const)
    .filter((key) => a[key] !== b[key] || a[key].includes('+'))
    .map((key) => `${key} ${a[key]} vs ${b[key]}`);
  return diff.length > 0 ? `the runs differ: ${diff.join(', ')}` : null;
}
