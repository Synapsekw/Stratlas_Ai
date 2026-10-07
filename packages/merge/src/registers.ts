import { canonicalJson } from '@aio/journal';
import type { OpIndex, OpNode } from './causal';

/** One value written to a field by an op (`absent`: the op removed the field). */
export interface Write {
  node: OpNode;
  value: unknown;
  absent: boolean;
  /** Canonical text of the value, for equality. */
  key: string;
}

/** A field's write as History shows it: every value ever written stays here. */
export interface FieldWrite {
  field: string;
  value?: unknown;
  absent: boolean;
  op: string;
  hlc: string;
  by: string;
}

/** Two concurrent writes to one field with different values, before ids and viewers. */
export interface RawConflict {
  field: string;
  winner: Write;
  loser: Write;
}

const ABSENT_KEY = '\u0000absent';

export function writeOf(node: OpNode, value: unknown, absent = false): Write {
  return { node, value, absent, key: absent ? ABSENT_KEY : canonicalJson(value ?? null) };
}

/**
 * Last-writer-wins registers for the fields of one record. Ops must be added in total order
 * (clock reading, then op id), so the last write of a field is its winner. Fields of one group
 * (`classId` with `severityModelId`) are checked for conflicts together, under the group's first
 * field. Quiet fields (`updatedAt`) take the last writer and never raise a conflict.
 */
export class FieldLog {
  private readonly fields = new Map<string, Write[]>();
  private readonly checked = new Map<string, Write[]>();

  constructor(
    private readonly groups: readonly (readonly string[])[] = [],
    private readonly quiet: readonly string[] = [],
  ) {}

  /** Record what one op wrote: `set` values and `unset` names. */
  write(node: OpNode, set: Record<string, unknown>, unset: readonly string[] = []): void {
    const touched = new Map<string, Write>();
    for (const [f, v] of Object.entries(set)) {
      if (v === undefined) continue;
      touched.set(f, writeOf(node, v));
    }
    for (const f of unset) if (!touched.has(f)) touched.set(f, writeOf(node, undefined, true));
    const grouped = new Map<string, Record<string, unknown>>();
    for (const [f, w] of touched) {
      this.push(this.fields, f, w);
      if (this.quiet.includes(f)) continue;
      const group = this.groups.find((g) => g.includes(f));
      if (!group) {
        this.push(this.checked, f, w);
        continue;
      }
      const lead = group[0] ?? f;
      const g = grouped.get(lead) ?? {};
      g[f] = w.absent ? null : w.value;
      grouped.set(lead, g);
    }
    for (const [lead, value] of grouped) this.push(this.checked, lead, writeOf(node, value));
  }

  private push(map: Map<string, Write[]>, f: string, w: Write): void {
    const list = map.get(f);
    if (list) list.push(w);
    else map.set(f, [w]);
  }

  /** The winning write of a field, if any op wrote it. */
  winner(field: string): Write | undefined {
    const list = this.fields.get(field);
    return list?.[list.length - 1];
  }

  /** Field names in first-write order. */
  names(): string[] {
    return [...this.fields.keys()];
  }

  /** The winners as a set/unset overlay. */
  overlay(): { set: Record<string, unknown>; unset: string[] } {
    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    for (const f of this.fields.keys()) {
      const w = this.winner(f);
      if (!w) continue;
      if (w.absent) unset.push(f);
      else set[f] = w.value;
    }
    return { set, unset };
  }

  /** Every write, oldest first. */
  history(field?: string): FieldWrite[] {
    const out: FieldWrite[] = [];
    for (const [f, list] of this.fields) {
      if (field !== undefined && f !== field) continue;
      for (const w of list) {
        out.push({
          field: f,
          ...(w.absent ? {} : { value: w.value }),
          absent: w.absent,
          op: w.node.op.id,
          hlc: w.node.op.hlc,
          by: w.node.op.act,
        });
      }
    }
    return out.sort((a, b) => (a.hlc === b.hlc ? (a.op < b.op ? -1 : 1) : a.hlc < b.hlc ? -1 : 1));
  }

  /** Writes concurrent with the winner, with another value, that nothing later replaced. */
  conflicts(index: OpIndex): RawConflict[] {
    const out: RawConflict[] = [];
    for (const [field, list] of this.checked) {
      out.push(...concurrentLosers(field, list, index));
    }
    return out;
  }
}

/** The writes a person must look at: concurrent with the winner, different, not superseded. */
export function concurrentLosers(
  field: string,
  list: readonly Write[],
  index: OpIndex,
): RawConflict[] {
  if (list.length < 2) return [];
  const winner = list.at(-1);
  if (!winner) return [];
  // one entry per losing value: the latest write of it
  const byValue = new Map<string, RawConflict>();
  for (const w of list) {
    if (w === winner || w.node === winner.node || w.key === winner.key) continue;
    if (index.before(w.node, winner.node)) continue;
    if (list.some((x) => x !== w && x.node !== w.node && index.before(w.node, x.node))) continue;
    byValue.set(w.key, { field, winner, loser: w });
  }
  return [...byValue.values()];
}
