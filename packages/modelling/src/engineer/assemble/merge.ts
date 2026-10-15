/**
 * Merging a regenerated set of assemblies with the previous model, by id (spec section 5.4):
 *
 * - a regenerated assembly equal to the previous one (origin aside: a new run id alone is no
 *   change) keeps the previous object, byte for byte;
 * - an accepted (or rejected) previous assembly keeps its values and status; only the person's
 *   own values (`user` basis) of the new set are laid onto it. When the new run would have
 *   changed it otherwise, it is flagged for review;
 * - a draft takes the new values, with the person values it carried (`user` basis) copied
 *   forward when the new set does not repeat them;
 * - a previous assembly the new set lacks is dropped while it is an engineer draft; an accepted
 *   one is kept and flagged (a lowered count never deletes accepted work), a rejected or
 *   hand-made one is kept as it is.
 */
import { Assembly, type ParamQuality, type ProcModel } from '@aio/schema';
import { indexInRole } from './ids';

export interface MergeResult {
  assemblies: Assembly[];
  /** Ids added, replaced or dropped. */
  changed: string[];
  /** Ids whose previous object was kept. */
  kept: string[];
  flagged: { id: string; reason: string }[];
}

/** Plain-data equality: key order and undefined members do not matter. */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => sameData(x, b[i]));
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) if (!sameData(ra[k], rb[k])) return false;
  return true;
}

/** Equal apart from `origin` (which run made it). */
export function sameAssembly(a: Assembly, b: Assembly): boolean {
  return sameData({ ...a, origin: null }, { ...b, origin: null });
}

/** The role of a generated id `<role>-<n>` (the id itself when it has no index). */
export function roleOf(id: string): string {
  const m = /^(.*)-[1-9][0-9]*$/.exec(id);
  return m?.[1] ?? id;
}

/**
 * `onto` with the params named in `keys` taken from `from` (values and quality). Re-validated;
 * undefined when the result is not a valid assembly.
 */
function withParams(onto: Assembly, from: Assembly, keys: string[]): Assembly | undefined {
  if (!keys.length) return onto;
  const params: Record<string, unknown> = { ...onto.params };
  const quality: Record<string, ParamQuality> = { ...onto.quality };
  const src = from.params as Record<string, unknown>;
  for (const k of keys) {
    params[k] = src[k];
    const q = from.quality[k];
    if (q) quality[k] = q;
  }
  const r = Assembly.safeParse({ ...onto, params, quality });
  return r.success ? r.data : undefined;
}

const userKeys = (a: Assembly): string[] =>
  Object.entries(a.quality)
    .filter(([k, q]) => q.basis === 'user' && k in a.params)
    .map(([k]) => k);

export function mergeModels(
  previous: ProcModel | null,
  next: Assembly[],
  o: { removedRoles?: string[] } = {},
): MergeResult {
  const prev = new Map((previous?.assemblies ?? []).map((a) => [a.id, a]));
  const removed = new Set(o.removedRoles ?? []);
  const changed: string[] = [];
  const kept: string[] = [];
  const flagged: { id: string; reason: string }[] = [];
  const out: Assembly[] = [];
  const nextIds = new Set(next.map((a) => a.id));

  for (const n of next) {
    const p = prev.get(n.id);
    if (!p) {
      out.push(n);
      changed.push(n.id);
      continue;
    }
    if (p.status !== 'draft') {
      // the person's own new values land on the kept component; nothing else does
      const own = p.kind === n.kind ? userKeys(n).filter((k) => !sameData(...pair(p, n, k))) : [];
      const merged = (p.kind === n.kind ? withParams(p, n, own) : undefined) ?? p;
      out.push(merged);
      (merged === p ? kept : changed).push(p.id);
      if (p.status === 'accepted' && !sameAssembly({ ...merged, status: n.status }, n))
        flagged.push({
          id: p.id,
          reason: 'The new run would change this accepted component; the accepted values are kept.',
        });
      continue;
    }
    const carry = userKeys(p).filter((k) => n.quality[k]?.basis !== 'user');
    const candidate = (p.kind === n.kind ? withParams(n, p, carry) : undefined) ?? n;
    if (sameAssembly(candidate, p)) {
      out.push(p);
      kept.push(p.id);
    } else {
      out.push(candidate);
      changed.push(p.id);
    }
  }

  for (const p of previous?.assemblies ?? []) {
    if (nextIds.has(p.id)) continue;
    const role = roleOf(p.id);
    const byPerson = removed.has(p.id) || removed.has(role);
    if (p.origin.by === 'engineer' && p.status === 'draft') {
      changed.push(p.id);
      continue;
    }
    insertAfterRole(out, p);
    kept.push(p.id);
    if (p.status === 'accepted' && p.origin.by === 'engineer')
      flagged.push({
        id: p.id,
        reason: byPerson
          ? 'The person removed it, but it was accepted: kept for review.'
          : `No longer generated (the ${role} count is lower than before), but it was accepted: kept for review.`,
      });
  }
  return { assemblies: out, changed, kept, flagged };
}

function pair(a: Assembly, b: Assembly, k: string): [unknown, unknown] {
  return [(a.params as Record<string, unknown>)[k], (b.params as Record<string, unknown>)[k]];
}

/** Puts `a` after the last assembly of its role (in index order), else at the end. */
function insertAfterRole(out: Assembly[], a: Assembly): void {
  const role = roleOf(a.id);
  const n = indexInRole(role, a.id) ?? Infinity;
  let at = -1;
  out.forEach((x, i) => {
    const k = indexInRole(role, x.id);
    if (k !== undefined && k < n) at = i;
  });
  if (at < 0) {
    const first = out.findIndex((x) => indexInRole(role, x.id) !== undefined);
    if (first >= 0) at = first - 1;
    else {
      out.push(a);
      return;
    }
  }
  out.splice(at + 1, 0, a);
}
