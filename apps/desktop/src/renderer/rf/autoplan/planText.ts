/**
 * The words Auto-plan shows (a pick's reason, a row's note, an error or a warning) as i18n keys
 * with their values, so the pure planning modules hold no English: the dialog renders them with
 * `t()` (`planText`). Text that is not the app's own (the AI's reason, a provider's error) is kept
 * as it came, in `{ text }`. A value may itself be a message (`equipment: { key: ... }`).
 */
import type { MessageKey, Vars } from '@aio/ui';

export type PlanVar = string | number | PlanText;
export type PlanText =
  { key: MessageKey; vars?: Readonly<Record<string, PlanVar>> } | { text: string };

/** A message of the app's catalogue. */
export const msg = (key: MessageKey, vars?: Readonly<Record<string, PlanVar>>): PlanText =>
  vars ? { key, vars } : { key };

/** Text that is not the app's own, shown as it came. */
export const raw = (text: string): PlanText => ({ text });

type T = (key: MessageKey, vars?: Vars) => string;

function one(t: T, p: PlanText): string {
  if ('text' in p) return p.text;
  if (!p.vars) return t(p.key);
  const vars: Vars = {};
  for (const [k, v] of Object.entries(p.vars)) vars[k] = typeof v === 'object' ? one(t, v) : v;
  return t(p.key, vars);
}

/** The parts as one line: each is a sentence, so they join with a space. */
export function planText(t: T, parts: PlanText | readonly PlanText[]): string {
  const list: readonly PlanText[] = Array.isArray(parts) ? parts : [parts as PlanText];
  return list
    .map((p) => one(t, p))
    .filter((s) => s !== '')
    .join(' ');
}
