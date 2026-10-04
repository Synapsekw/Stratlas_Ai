import { useSyncExternalStore } from 'react';
import { en, type CatalogueKey } from './en';

export { en };

/** A translation: any subset of the English keys (plural keys use `_one`, `_other`, ...). */
export type Catalogue = Partial<Record<string, string>>;

export type Vars = Record<string, string | number>;

const RTL = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'yi', 'dv', 'ku', 'ug']);

/** Text direction of a BCP 47 locale. */
export function directionOf(locale: string): 'ltr' | 'rtl' {
  const lang = locale.toLowerCase().split(/[-_]/)[0] ?? '';
  return RTL.has(lang) ? 'rtl' : 'ltr';
}

let locale = 'en';
let messages: Catalogue = {};
const listeners = new Set<() => void>();

/** Switch the UI language. Keys missing from `catalogue` fall back to English. */
export function setLocale(next: string, catalogue: Catalogue = {}): void {
  locale = next;
  messages = next === 'en' ? {} : catalogue;
  for (const l of listeners) l();
}

export function getLocale(): string {
  return locale;
}

const english = en as Record<string, string>;

function lookup(key: string): string | undefined {
  return messages[key] ?? english[key];
}

/** Placeholder names in a message, in order. */
export function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '');
}

/** Base key of a plural form (`library.count_one` to `library.count`). */
const baseKey = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, '');

/** A key `t` accepts: plural forms collapse to their base (`library.count`). */
export type MessageKey = CatalogueKey extends infer K
  ? K extends `${infer B}_${'one' | 'other'}`
    ? B
    : K
  : never;

/**
 * The message for `key` in the current locale, with `{placeholders}` filled from `vars`. With a
 * numeric `count`, the plural form for that count is used (`key_one`, `key_other`).
 */
export function t(key: MessageKey, vars: Vars = {}): string {
  let message: string | undefined;
  if (typeof vars.count === 'number') {
    const form = new Intl.PluralRules(locale).select(vars.count);
    message = lookup(`${key}_${form}`) ?? lookup(`${key}_other`);
  }
  message ??= lookup(key) ?? key;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** Re-render on locale changes and return `t`. */
export function useT(): typeof t {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => locale,
  );
  return t;
}

/** Keys unknown to the source catalogue and placeholder mismatches, as readable lines. */
export function catalogueProblems(catalogue: Catalogue, source: Catalogue = english): string[] {
  const problems: string[] = [];
  const sourceKeys = new Set(Object.keys(source));
  const sourceBases = new Set([...sourceKeys].map(baseKey));
  for (const [key, value] of Object.entries(catalogue)) {
    if (value === undefined) continue;
    if (!sourceKeys.has(key) && !sourceBases.has(baseKey(key))) {
      problems.push(`${key}: not in the English catalogue`);
      continue;
    }
    const ref = source[key] ?? source[`${baseKey(key)}_other`] ?? '';
    const want = [...new Set(placeholders(ref))].sort();
    const got = [...new Set(placeholders(value))].sort();
    if (want.join() !== got.join()) {
      problems.push(
        `${key}: placeholders ${got.map((p) => `{${p}}`).join(' ') || 'none'} do not match ${want.map((p) => `{${p}}`).join(' ') || 'none'}`,
      );
    }
  }
  return problems;
}
