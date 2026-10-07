import { canonicalJson, checkOp } from '@aio/journal';
import type { Op } from '@aio/schema';

/** One op in the causal index. */
export interface OpNode {
  op: Op;
  /** Position in the total order (clock reading, then op id). */
  order: number;
  /** Index of the op's chain in `OpIndex.chains`. */
  chain: number;
  /** Highest seq seen per chain when the op was written (its own included); null when held. */
  vc: Int32Array | null;
}

/** An op that cannot apply yet: an op it builds on (`prev` or a `deps` head) is missing. */
export interface HeldOp {
  op: string;
  chain: string;
  seq: number;
  /** The op ids it waits for, with their chain when known. */
  missing: { chain: string; op: string; seq?: number }[];
}

export interface OpIndex {
  /** Every distinct op, in total order: clock reading, then op id. Held ops included. */
  nodes: OpNode[];
  byId: ReadonlyMap<string, OpNode>;
  chains: readonly string[];
  held: HeldOp[];
  /** `a` happened before `b`: `b`'s writer had seen `a`. */
  before(a: OpNode, b: OpNode): boolean;
  /** Neither happened before the other. */
  concurrent(a: OpNode, b: OpNode): boolean;
}

/** Total order of ops: the clock reading, then the op id (both fixed-width text). */
export function compareOps(a: Op, b: Op): number {
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Two lines with one id but different bytes (a tampered copy): keep the one that hashes, else the
 * smallest canonical text, so every copy keeps the same one whatever order they arrived in.
 */
function pickDuplicate(a: Op, b: Op): Op {
  const ca = canonicalJson(a);
  const cb = canonicalJson(b);
  if (ca === cb) return a;
  const okA = checkOp(a);
  const okB = checkOp(b);
  const goodA = okA.id && okA.payload !== false;
  const goodB = okB.id && okB.payload !== false;
  if (goodA !== goodB) return goodA ? a : b;
  return ca < cb ? a : b;
}

/**
 * Index a set of ops: dedupe by id, order them, and work out who had seen what from `prev` and
 * `deps` (a vector of the highest seq seen per chain). Ops whose `prev` or `deps` are missing are
 * held, and so is everything built on them. Pure: the same set gives the same index in any order.
 */
export function indexOps(ops: readonly Op[]): OpIndex {
  const unique = new Map<string, Op>();
  for (const op of ops) {
    const seen = unique.get(op.id);
    unique.set(op.id, seen ? pickDuplicate(seen, op) : op);
  }
  const sorted = [...unique.values()].sort(compareOps);
  const chains = [...new Set(sorted.map((o) => o.chain))].sort();
  const chainIndex = new Map(chains.map((c, i) => [c, i]));
  const nodes: OpNode[] = sorted.map((op, order) => ({
    op,
    order,
    chain: chainIndex.get(op.chain) ?? 0,
    vc: null,
  }));
  const byId = new Map(nodes.map((n) => [n.op.id, n]));

  // 0 unvisited, 1 on the stack, 2 done (vc set), 3 held
  const state = new Uint8Array(nodes.length);
  const missingOf = new Map<number, HeldOp['missing']>();
  const parents = (n: OpNode): { ids: string[]; chains: (string | undefined)[] } => {
    const ids: string[] = [];
    const cs: (string | undefined)[] = [];
    if (n.op.prev !== null) {
      ids.push(n.op.prev);
      cs.push(n.op.chain);
    }
    for (const [c, id] of Object.entries(n.op.deps ?? {})) {
      ids.push(id);
      cs.push(c);
    }
    return { ids, chains: cs };
  };

  for (const start of nodes) {
    if (state[start.order] !== 0) continue;
    const stack: OpNode[] = [start];
    while (stack.length > 0) {
      const n = stack.at(-1);
      if (!n) break;
      if (state[n.order] === 0) state[n.order] = 1;
      const { ids, chains: pcs } = parents(n);
      let pending = false;
      for (const id of ids) {
        const p = byId.get(id);
        if (p && state[p.order] === 0) {
          stack.push(p);
          pending = true;
        }
      }
      if (pending) continue;
      stack.pop();
      if (state[n.order] !== 1) continue;
      const missing: HeldOp['missing'] = [];
      const vc = new Int32Array(chains.length);
      ids.forEach((id, i) => {
        const p = byId.get(id);
        if (!p) {
          const chain = pcs[i] ?? '';
          missing.push(
            chain === n.op.chain ? { chain, op: id, seq: n.op.seq - 1 } : { chain, op: id },
          );
          return;
        }
        // a cycle (a forged prev) or a held parent holds this op too
        if (state[p.order] !== 2 || !p.vc) {
          missing.push({ chain: p.op.chain, op: id, seq: p.op.seq });
          return;
        }
        for (let c = 0; c < vc.length; c += 1) {
          const v = p.vc[c] ?? 0;
          if (v > (vc[c] ?? 0)) vc[c] = v;
        }
      });
      if (missing.length > 0) {
        state[n.order] = 3;
        missingOf.set(n.order, missing);
        continue;
      }
      if (n.op.seq > (vc[n.chain] ?? 0)) vc[n.chain] = n.op.seq;
      n.vc = vc;
      state[n.order] = 2;
    }
  }

  const held: HeldOp[] = nodes
    .filter((n) => state[n.order] === 3)
    .map((n) => ({
      op: n.op.id,
      chain: n.op.chain,
      seq: n.op.seq,
      missing: missingOf.get(n.order) ?? [],
    }));

  const before = (a: OpNode, b: OpNode): boolean =>
    a !== b && b.vc !== null && (b.vc[a.chain] ?? 0) >= a.op.seq;
  return {
    nodes,
    byId,
    chains,
    held,
    before,
    concurrent: (a, b) => a !== b && !before(a, b) && !before(b, a),
  };
}
