import type { ExchangePreview, Heads, Op } from '@aio/schema';
import { planIngest, type IngestPlan } from './ingest';
import type { OpenedExchange } from './read';

/** What this copy holds, as the preview and the import need it. */
export interface LocalView {
  heads: Heads;
  idAt?: (chain: string, seq: number) => string | undefined;
  /** Ops held from earlier imports, waiting for a gap to fill. */
  held: readonly Op[];
  /** This copy's ops (to estimate conflicts with ops the sender had not seen). */
  ops: readonly Op[];
  hasBlob(sha256: string): boolean;
  /** Is this actor a member of the team (T2); unknown without members. */
  isMember?(actor: string): boolean;
  /** Exchange ids this copy has imported before. */
  imported: ReadonlySet<string>;
}

/** The fields an op changes, as `<rec>:<in>:<id>:<field>` (or the whole record). */
export function touches(op: Op): string[] {
  const base = `${op.target.rec}:${op.target.in ?? ''}:${op.target.id}`;
  const p = op.payload as { set?: Record<string, unknown>; unset?: string[] } | undefined;
  if (p && typeof p === 'object' && (p.set || p.unset)) {
    return [...Object.keys(p.set ?? {}), ...(p.unset ?? [])].map((f) => `${base}:${f}`);
  }
  if (op.kind === 'issue.status') return [`${base}:status`];
  if (op.kind === 'assign.set') return [`${base}:assignee`];
  if (op.kind.endsWith('.delete')) return [`${base}:*`];
  return [];
}

/**
 * Concurrent writes to the same field: ops of this copy the sender had not seen against new ops
 * from the file. An estimate for the preview; the merge engine (T4) decides the real conflicts.
 */
export function estimateConflicts(
  local: readonly Op[],
  senderHeads: Heads,
  incoming: readonly Op[],
): number {
  const unseen = new Map<string, Op>();
  for (const op of local) {
    if (op.seq <= (senderHeads[op.chain]?.seq ?? 0)) continue;
    for (const k of touches(op)) unseen.set(k, op);
  }
  const hit = new Set<string>();
  for (const op of incoming) {
    for (const k of touches(op)) {
      const mine = unseen.get(k);
      if (!mine) continue;
      const field = k.endsWith(':*') ? null : k.slice(k.lastIndexOf(':') + 1);
      const theirs = (op.payload as { set?: Record<string, unknown> } | undefined)?.set;
      const ours = (mine.payload as { set?: Record<string, unknown> } | undefined)?.set;
      if (field && theirs && ours && JSON.stringify(theirs[field]) === JSON.stringify(ours[field]))
        continue;
      hit.add(k);
    }
  }
  return hit.size;
}

export function planFor(opened: OpenedExchange, local: LocalView): IngestPlan {
  return planIngest({ heads: local.heads, ...(local.idAt ? { idAt: local.idAt } : {}) }, [
    ...local.held,
    ...opened.ops,
  ]);
}

/** What applying an exchange file would do; nothing is written. */
export function previewExchange(opened: OpenedExchange, local: LocalView): ExchangePreview {
  const plan = planFor(opened, local);
  const fresh = new Set(opened.ops.map((o) => o.id));
  const isNew = (o: Op) => fresh.has(o.id);
  const newOps = [...plan.apply, ...plan.held].filter(isNew);
  const byKind: Record<string, number> = {};
  for (const op of newOps) byKind[op.kind] = (byKind[op.kind] ?? 0) + 1;
  const sender = opened.devices.find((d) => d.id === opened.header.from.device);
  const missing = opened.header.blobs.filter((b) => !local.hasBlob(b.sha256));
  const problems = [...opened.problems, ...plan.forks.map((f) => f.message)];
  return {
    file: opened.file,
    header: opened.header,
    signature: opened.signature,
    sender: {
      name: opened.header.from.name,
      ...(sender ? { initials: sender.initials } : {}),
      member: local.isMember?.(opened.header.from.actor) ?? false,
    },
    byKind,
    newOps: newOps.length,
    alreadyHave: plan.duplicates.filter(isNew).length,
    held: plan.gaps.map((g) => ({ chain: g.chain, device: g.device, upTo: g.upTo })),
    expectedConflicts: estimateConflicts(local.ops, opened.header.heads, plan.apply),
    blobs: {
      count: opened.header.blobs.length,
      bytes: opened.header.blobs.reduce((n, b) => n + b.size, 0),
      missing: missing.length,
    },
    alreadyApplied:
      local.imported.has(opened.header.id) ||
      (newOps.length === 0 && missing.length === 0 && opened.ops.length > 0),
    problems,
  };
}
