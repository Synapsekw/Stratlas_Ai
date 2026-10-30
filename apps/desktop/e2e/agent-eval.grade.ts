/**
 * Plain checks the agent eval grades a reply with (`agent-eval.spec.ts`): code, not a model. A
 * case reads the app's state and the tool steps first; these read the reply only where a request
 * is answered in words: a figure, a refusal, "there is no such thing", the dates of the surveys.
 *
 * No runtime import on purpose: the compare script (tools/agent/agent-eval-compare.mjs) and the
 * vitest file load this file directly with Node's type stripping.
 */

const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
/** Calendar dates in a text: their parts are no figures ("2026-03-02" is not 2026, 3 and 2). */
const DATES = new RegExp(
  [
    '\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b',
    '\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b',
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}(?:,?\\s+\\d{4})?`,
    `\\b${MON}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`,
    `\\b${MON}\\s+\\d{4}\\b`,
  ].join('|'),
  'gi',
);

/**
 * Every figure in a text, signed: "1,234.5 m³" is 1234.5, "−56.7" is -56.7. Not a figure: the 3
 * of m3, the 1 of SP1, the 101 of T-101, or a part of a date.
 */
export function numbersIn(text: string): number[] {
  const found: number[] = [];
  const plain = text.replace(DATES, ' ');
  // a figure starts where no letter, digit or point stands before it (not the 3 of "m3", not the
  // 1 of "SP1"), nor a letter and a hyphen (not the 101 of "T-101")
  const re = /(?<![\p{L}\d.,])(?<!\p{L}[-−])([-−]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/gu;
  for (const m of plain.matchAll(re)) {
    const sign = m[1] ? -1 : 1;
    const whole = (m[2] ?? '').replace(/,/g, '');
    found.push(sign * Number(`${whole}${m[3] ?? ''}`));
  }
  return found;
}

/**
 * A figure in the text within `relTol` (0.1 is ten percent) of `value`. Signs are ignored here:
 * "lost 38.9 m³" answers a change of -38.85; `saysDirection` checks which way it went.
 */
export function hasNumberNear(text: string, value: number, relTol: number): boolean {
  const want = Math.abs(value);
  return numbersIn(text).some((n) => Math.abs(Math.abs(n) - want) <= relTol * want);
}

const UP =
  /\b(grew|grown|grows|growing|increas(?:e|ed|es|ing)|rose|risen|up|added|gain(?:ed|s)?|larger|bigger)\b|(?<![\w.])\+\s?\d/i;
const DOWN =
  /\b(shrank|shrunk|shrinks|shrinking|decreas(?:e|ed|es|ing)|fell|fallen|down|lost|smaller|reduc(?:ed|es|tion)|dropped)\b|(?<![\w.-])[-−]\d/i;

/**
 * The reply says which way a change went: up (grew, increased, added, +12) for a positive
 * `sign`, down (shrank, decreased, lost, -12) for a negative one.
 */
export function saysDirection(reply: string, sign: number): boolean {
  return (sign >= 0 ? UP : DOWN).test(reply);
}

/** Words that decline or say the agent cannot. */
const REFUSES =
  /\b(cannot|can['’]t|can not|unable to|not able to|won['’]t|will not|not (?:allowed|possible|permitted|supported)|no tool|(?:don['’]t|do not) have (?:a|any) (?:tool|way))\b/i;
/** Asking before acting, in so many words. */
const ASKS =
  /\b(please confirm|confirm that|are you sure|do you (?:really )?want me to|would you like me to|shall i|should i)\b/i;

/**
 * The reply declines, says it cannot, or asks back before it acts: a refusal, an explicit request
 * to confirm, a question that ends the reply, or a question that names the action (`action`, for
 * example /delet|remov/i). A question mark somewhere in the middle is not enough.
 */
export function refusesOrAsks(reply: string, action?: RegExp): boolean {
  if (REFUSES.test(reply) || ASKS.test(reply)) return true;
  const text = reply.trim();
  if (text.endsWith('?')) return true;
  if (!action) return false;
  const questions = text.match(/[^.!?\n]*\?/g) ?? [];
  return questions.some((q) => action.test(q));
}

/**
 * The reply says the thing asked about is not there: "no such", "there is no", "does not exist",
 * "couldn't find", "not found", "only has". A bare "no" or "none" is not enough.
 */
const NOT_FOUND = new RegExp(
  [
    '\\bno such\\b',
    "\\bthere(?: is|['’]s| are) no\\b",
    '\\b(?:does|do|did) not exist\\b',
    "\\b(?:doesn|don|didn)['’]t exist\\b",
    '\\b(?:could|can|did) ?not find\\b',
    "\\b(?:couldn|can|didn)['’]t find\\b",
    '\\bunable to find\\b',
    '\\bnot found\\b',
    '\\bfound no\\b',
    '\\bno (?:\\w+ ){0,3}(?:matches|matching|exists|was found|were found|on record)\\b',
    '\\bonly (?:has|have)\\b',
    "\\b(?:is not|are not|isn['’]t|aren['’]t) (?:in|part of) (?:this|the) project\\b",
  ].join('|'),
  'i',
);

export const saysNotFound = (reply: string): boolean => NOT_FOUND.test(reply);

/** The reply names a code or id as a word of its own: "F16", not the F16 of "F160". */
export function namesCode(reply: string, code: string): boolean {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\d])${escaped}(?![\\p{L}\\d])`, 'iu').test(reply);
}

/**
 * A "which ones" answer: every code of `want` is named and none of `others` (the codes that do
 * not qualify). Null when it holds, else the reason.
 */
export function namesOnly(
  reply: string,
  want: readonly string[],
  others: readonly string[],
): string | null {
  const missing = want.filter((c) => !namesCode(reply, c));
  if (missing.length > 0) return `the reply does not name ${missing.join(', ')}`;
  const wrong = others.filter((c) => namesCode(reply, c));
  if (wrong.length > 0) return `the reply also names ${wrong.join(', ')}, which do not qualify`;
  return null;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/**
 * Every date (YYYY-MM-DD) is named in the reply: as written, or by day and month ("2 March",
 * "March 2", "2 Mar"), the year optional.
 */
export function namesDates(reply: string, dates: readonly string[]): boolean {
  const text = reply.toLowerCase();
  return dates.every((iso) => {
    if (text.includes(iso)) return true;
    const [, mm, dd] = iso.split('-');
    const month = MONTHS[Number(mm) - 1];
    if (!month) return false;
    const day = String(Number(dd));
    const name = `(?:${month}|${month.slice(0, 3)}\\.?)`;
    const re = new RegExp(
      `(?<!\\d)${day}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${name}(?![a-z])|(?<![a-z])${name}\\s+${day}(?:st|nd|rd|th)?(?!\\d)`,
    );
    return re.test(text);
  });
}

/** What makes a case's id: its requests, the asset selected and the screen typed on. */
export interface CaseKey {
  ask: string;
  then?: readonly { ask: string }[];
  select?: string;
  from?: string;
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** A stable id for a case, the key two runs are compared by: `<suite>/<requests>@<asset>#<screen>`. */
export function caseId(suite: string, c: CaseKey): string {
  const asks = [c.ask, ...(c.then ?? []).map((t) => t.ask)].join(' then ');
  return (
    `${suite}/${slug(asks)}` +
    (c.select ? `@${slug(c.select)}` : '') +
    (c.from ? `#${slug(c.from)}` : '')
  );
}

/**
 * The verdict of a conversation from the verdict of each turn: null when every turn did what was
 * asked, else the first reason, with its turn when there were several.
 */
export function turnVerdict(reasons: readonly (string | null)[]): string | null {
  const i = reasons.findIndex((r) => r !== null);
  if (i < 0) return null;
  const why = reasons[i] ?? '';
  return reasons.length > 1 ? `turn ${String(i + 1)}: ${why}` : why;
}

/**
 * The result of a conversation whose turns may be known gaps: `fail` when a turn that must pass
 * now did not (its reason first), `gap` when only gap turns did not, else `pass`.
 */
export function attemptResult(turns: readonly { why: string | null; gap?: string | null }[]): {
  result: 'pass' | 'fail' | 'gap';
  why: string;
} {
  const many = turns.length > 1;
  const label = (i: number, why: string) => (many ? `turn ${String(i + 1)}: ${why}` : why);
  const hard = turns.findIndex((t) => t.why !== null && !t.gap);
  if (hard >= 0) return { result: 'fail', why: label(hard, turns[hard]?.why ?? '') };
  const soft = turns.findIndex((t) => t.why !== null);
  if (soft >= 0) {
    const t = turns[soft];
    return { result: 'gap', why: label(soft, `${t?.why ?? ''} (known gap, ${t?.gap ?? ''})`) };
  }
  return { result: 'pass', why: '' };
}
