import type { Heads, Op } from '@aio/schema';

/**
 * Which incoming ops a copy can take now (pure; shared by exchange import and hub pulls).
 *
 * Per chain, ops apply in seq order from the copy's head: an op already held is a duplicate; the
 * next one must link to the head (`prev`); anything after a gap is held until the missing ops
 * arrive ("needs changes from <device> up to #N"). An op whose `prev` does not link, or a second
 * op for a seq the copy holds with another id, is a fork: it is refused, never applied.
 */
export interface IngestPlan {
  /** Ops to append, in chain then seq order. */
  apply: Op[];
  /** Ops after a gap, kept until the gap fills. */
  held: Op[];
  /** Ops the copy already holds (by id). */
  duplicates: Op[];
  /** Ops that contradict the chain the copy holds. */
  forks: { op: Op; message: string }[];
  /** Per held chain: the device and the last seq still missing. */
  gaps: { chain: string; device: string; upTo: number }[];
  /** Heads after applying. */
  heads: Heads;
}

export interface LocalChains {
  heads: Heads;
  /** The id the copy holds at a chain and seq, if it holds that op (fork detection). */
  idAt?: (chain: string, seq: number) => string | undefined;
}

export function planIngest(local: LocalChains, incoming: readonly Op[]): IngestPlan {
  const byChain = new Map<string, Map<number, Op>>();
  const forks: IngestPlan['forks'] = [];
  for (const op of incoming) {
    let seqs = byChain.get(op.chain);
    if (!seqs) byChain.set(op.chain, (seqs = new Map<number, Op>()));
    const seen = seqs.get(op.seq);
    if (!seen) seqs.set(op.seq, op);
    else if (seen.id !== op.id) {
      forks.push({ op, message: forkMessage(op) });
    }
  }
  const heads: Heads = { ...local.heads };
  const plan: IngestPlan = { apply: [], held: [], duplicates: [], forks, gaps: [], heads };
  for (const chain of [...byChain.keys()].sort()) {
    const seqs = byChain.get(chain) ?? new Map<number, Op>();
    let head = heads[chain];
    const ordered = [...seqs.values()].sort((a, b) => a.seq - b.seq);
    let broken = false;
    for (const op of ordered) {
      if (head && op.seq <= head.seq) {
        const have = op.seq === head.seq ? head.id : local.idAt?.(chain, op.seq);
        if (have !== undefined && have !== op.id) forks.push({ op, message: forkMessage(op) });
        else plan.duplicates.push(op);
        continue;
      }
      const next = (head?.seq ?? 0) + 1;
      if (broken || op.seq !== next) {
        plan.held.push(op);
        continue;
      }
      if (op.prev !== (head?.id ?? null)) {
        forks.push({ op, message: forkMessage(op) });
        broken = true;
        continue;
      }
      plan.apply.push(op);
      head = { seq: op.seq, id: op.id };
      heads[chain] = head;
    }
    const firstHeld = plan.held.find((o) => o.chain === chain);
    if (firstHeld) {
      plan.gaps.push({ chain, device: firstHeld.dev, upTo: firstHeld.seq - 1 });
    }
  }
  return plan;
}

function forkMessage(op: Op): string {
  return `Change #${op.seq} from ${op.dev.slice(0, 10)} does not follow the changes this copy holds (a copied project folder kept writing).`;
}

/** Ops with a seq after `since` per chain (a patch for a peer that holds `since`). */
export function opsSince(ops: readonly Op[], since: Heads): Op[] {
  return ops.filter((op) => op.seq > (since[op.chain]?.seq ?? 0));
}

/** The heads of a set of ops (the highest seq per chain). */
export function headsOf(ops: readonly Op[], base: Heads = {}): Heads {
  const out: Heads = { ...base };
  for (const op of ops) {
    const h = out[op.chain];
    if (!h || op.seq > h.seq) out[op.chain] = { seq: op.seq, id: op.id };
  }
  return out;
}

/** Merge two views of what a peer holds: per chain, the further one. */
export function mergeHeads(a: Heads, b: Heads): Heads {
  const out: Heads = { ...a };
  for (const [chain, h] of Object.entries(b)) {
    const mine = out[chain];
    if (!mine || h.seq > mine.seq) out[chain] = h;
  }
  return out;
}

/** Contiguous seq runs per chain, for member names (`<from>-<to>.jsonl`). */
export function chainRuns(
  ops: readonly Op[],
): { chain: string; from: number; to: number; ops: Op[] }[] {
  const sorted = [...ops].sort((a, b) =>
    a.chain === b.chain ? a.seq - b.seq : a.chain < b.chain ? -1 : 1,
  );
  const runs: { chain: string; from: number; to: number; ops: Op[] }[] = [];
  for (const op of sorted) {
    const last = runs.at(-1);
    if (last?.chain === op.chain && last.to + 1 === op.seq) {
      last.to = op.seq;
      last.ops.push(op);
    } else if (!(last?.chain === op.chain && last.to === op.seq)) {
      runs.push({ chain: op.chain, from: op.seq, to: op.seq, ops: [op] });
    }
  }
  return runs;
}
