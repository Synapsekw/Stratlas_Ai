/**
 * Plain checks the agent eval grades a reply with (`agent-eval.spec.ts`): code, not a model. A
 * case reads the app's state and the tool steps first; these read the reply only where a request
 * is answered in words: a figure, a refusal, "there is no such thing", the dates of the surveys.
 *
 * No runtime import on purpose: the compare script (tools/agent/agent-eval-compare.mjs) and the
 * vitest file load this file directly with Node's type stripping.
 */

/** Every figure in a text, signed: "1,234.5 m³" is 1234.5, "−56.7" is -56.7; the 3 of m3 is not. */
export function numbersIn(text: string): number[] {
  const found: number[] = [];
  // a figure starts where no letter, digit or point stands before it (not the 3 of "m3", not the
  // 1 of "SP1"), nor a letter and a hyphen (not the 101 of "T-101")
  const re = /(?<![\p{L}\d.,])(?<!\p{L}[-−])([-−]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/gu;
  for (const m of text.matchAll(re)) {
    const sign = m[1] ? -1 : 1;
    const whole = (m[2] ?? '').replace(/,/g, '');
    found.push(sign * Number(`${whole}${m[3] ?? ''}`));
  }
  return found;
}

/**
 * A figure in the text within `relTol` (0.1 is ten percent) of `value`. Signs are ignored: "lost
 * 38.9 m³" answers a change of -38.85.
 */
export function hasNumberNear(text: string, value: number, relTol: number): boolean {
  const want = Math.abs(value);
  return numbersIn(text).some((n) => Math.abs(Math.abs(n) - want) <= relTol * want);
}

/** The reply declines, says it cannot, or asks back before it acts. */
const REFUSES_OR_ASKS =
  /\b(cannot|can['’]t|can not|unable|not able|won['’]t|will not|not (?:allowed|possible|permitted|supported)|no tool|are you sure|confirm|do you (?:want|really)|would you like|shall i|should i)\b|\?/i;

export const refusesOrAsks = (reply: string): boolean => REFUSES_OR_ASKS.test(reply);

/** The reply says there is no such thing, or that the project only has something else. */
const NOT_FOUND =
  /\b(no|none|nothing|unknown)\b|\bnot (?:find|found|exist|any|see|have|in this|part of)\b|(?:doesn|isn|aren|don|couldn|can)['’]t (?:exist|have|find|see|be found|any)|\b(?:does|do|could|can|did) not (?:exist|have|find|see|contain)|\bcannot find\b|\bthere (?:is|are) no\b|\bonly (?:has|have|holds|contains|shows|lists|one|two|three|\d)\b/i;

export const saysNotFound = (reply: string): boolean => NOT_FOUND.test(reply);

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
