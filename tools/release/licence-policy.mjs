// The licence policy of M10 decision 1 as code, shared by the npm gate (license-check.mjs), the
// native gate (native-licences.mjs) and the data gate (data-licences.mjs). The policy itself is
// data in licence-exceptions.json; python/tests/test_licences.py reads the same file.
//
//   - `allowed.spdx` is allowed everywhere; `allowed.native` only for native libraries.
//   - MPL-* only for a package named in `mpl`, LGPL-* only for one named in `lgplShared` (the
//     caller checks that it is a separately replaceable shared library), and a compiler runtime
//     only with the exact licence of its `runtimes` entry; each for the entry's ecosystem.
//   - An entry whose `approved` is `pending` still counts, reported as pending: CI passes with a
//     warning, a strict run (release builds) fails.
//   - Everything else is denied: GPL, AGPL, SSPL, non-commercial and unknown ids.
import { readFileSync } from 'node:fs';

export const EXCEPTIONS_FILE = new URL('./licence-exceptions.json', import.meta.url);

/** The policy from licence-exceptions.json (or a parsed object, for tests). */
export function loadPolicy(doc = JSON.parse(readFileSync(EXCEPTIONS_FILE, 'utf8'))) {
  const named = (list) =>
    (list ?? []).map((e) => ({
      ...e,
      names: new Set([e.name, ...(e.aliases ?? [])].map((n) => n.toLowerCase())),
    }));
  return {
    allowed: new Set(doc.allowed?.spdx ?? []),
    nativeAllowed: new Set(doc.allowed?.native ?? []),
    mpl: named(doc.mpl),
    lgplShared: named(doc.lgplShared),
    runtimes: named(doc.runtimes),
  };
}

/**
 * Parse an SPDX licence expression into a tree: `{ id, with? }`, `{ and: [...] }` or
 * `{ or: [...] }`. AND binds tighter than OR, as in the SPDX specification.
 */
export function parseExpression(text) {
  const tokens = String(text).replace(/[()]/g, ' $& ').split(/\s+/).filter(Boolean);
  let i = 0;
  const peek = () => tokens[i];
  const word = (w) => peek()?.toUpperCase() === w;
  function term() {
    const t = tokens[i++];
    if (t === undefined) throw new Error(`Licence expression ends early: "${text}"`);
    if (t === '(') {
      const e = orExpr();
      if (tokens[i++] !== ')') throw new Error(`Unbalanced parentheses in "${text}"`);
      return e;
    }
    if (t === ')' || /^(AND|OR|WITH)$/i.test(t)) throw new Error(`Unexpected "${t}" in "${text}"`);
    if (word('WITH')) {
      i++;
      const ex = tokens[i++];
      if (!ex || ex === '(' || ex === ')')
        throw new Error(`WITH without an exception in "${text}"`);
      return { id: t, with: ex };
    }
    return { id: t };
  }
  function andExpr() {
    const parts = [term()];
    while (word('AND')) {
      i++;
      parts.push(term());
    }
    return parts.length === 1 ? parts[0] : { and: parts };
  }
  function orExpr() {
    const parts = [andExpr()];
    while (word('OR')) {
      i++;
      parts.push(andExpr());
    }
    return parts.length === 1 ? parts[0] : { or: parts };
  }
  const tree = orExpr();
  if (i !== tokens.length) throw new Error(`Unexpected "${tokens[i]}" in "${text}"`);
  return tree;
}

/** Every licence id (with its exception, if any) in an expression. */
export function terms(text) {
  const out = [];
  const walk = (n) => {
    if (n.id) out.push(n.with ? `${n.id} WITH ${n.with}` : n.id);
    for (const c of n.and ?? n.or ?? []) walk(c);
  };
  walk(parseExpression(text));
  return out;
}

const RANK = { ok: 2, pending: 1, denied: 0 };

/**
 * Judge licence expression `expr` for a package known by `names` (its name, aliases and, for a
 * runtime, the runtime entry's name) in `ecosystem` ('npm', 'python' or 'native').
 * Answers `{ status: 'ok' | 'pending' | 'denied', pending: [entry names], lgpl: boolean }`;
 * `lgpl` says the chosen option relies on an LGPL licence (the caller checks the linkage).
 */
export function judge(policy, expr, { ecosystem, names = [] }) {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const entryFor = (list) =>
    list.find((e) => e.ecosystem === ecosystem && [...e.names].some((n) => want.has(n)));
  const result = (status, entry, lgpl = false) => ({
    status: status === 'ok' && entry?.approved === 'pending' ? 'pending' : status,
    pending: entry?.approved === 'pending' ? [entry.name] : [],
    lgpl,
  });

  function leaf({ id, with: ex }) {
    const full = ex ? `${id} WITH ${ex}` : id;
    const runtime = entryFor(policy.runtimes);
    if (runtime && runtime.licence === full) return result('ok', runtime);
    const exceptionOk = !ex || policy.nativeAllowed.has(ex) || policy.allowed.has(ex);
    if (!exceptionOk) return result('denied');
    if (policy.allowed.has(id)) return result('ok');
    if (ecosystem === 'native' && policy.nativeAllowed.has(id)) return result('ok');
    if (/^MPL-/i.test(id)) {
      const e = entryFor(policy.mpl);
      return e ? result('ok', e) : result('denied');
    }
    if (/^LGPL-/i.test(id)) {
      const e = entryFor(policy.lgplShared);
      return e ? result('ok', e, true) : result('denied');
    }
    return result('denied');
  }

  function walk(n) {
    if (n.id) return leaf(n);
    const parts = (n.and ?? n.or).map(walk);
    if (n.or) return parts.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
    const status = parts.reduce((a, b) => (RANK[b.status] < RANK[a.status] ? b : a)).status;
    return {
      status,
      pending: [...new Set(parts.flatMap((p) => p.pending))],
      lgpl: parts.some((p) => p.lgpl),
    };
  }

  try {
    return walk(parseExpression(expr));
  } catch {
    return { status: 'denied', pending: [], lgpl: false };
  }
}
