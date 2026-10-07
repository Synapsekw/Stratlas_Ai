import {
  isKnownOpKind,
  type AuditEntry,
  type AuditFilter,
  type ChangeHow,
  type RecordRef,
} from '@aio/schema';
import type { LoadedJournal } from './load';

/** One op as read from a segment, with where it is. */
export interface JournalOp {
  file: string;
  line: number;
  raw: Record<string, unknown>;
}

/** Every well-formed op line of a loaded journal, in chain and segment order. */
export function opsOf(j: LoadedJournal): JournalOp[] {
  const out: JournalOp[] = [];
  for (const c of j.chains.values()) {
    for (const s of c.segments) {
      for (const l of s.lines) {
        if (l.ok && typeof l.raw.id === 'string' && typeof l.raw.hlc === 'string') {
          out.push({ file: s.file, line: l.line, raw: l.raw });
        }
      }
    }
  }
  return out;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Fields History never shows (bookkeeping that changes with every edit). */
const HIDDEN_FIELDS = new Set(['updatedAt']);

/** How a change came about, from its `via` and kind. */
export function howOf(raw: Obj): ChangeHow {
  const via = isObj(raw.via) ? raw.via : {};
  if (via.agent) return 'agent';
  if (via.pipeline) return 'pipeline';
  if (via.external || raw.kind === 'record.external') return 'external';
  if (isObj(via.import)) return via.import.source === 'server' ? 'server' : 'import';
  return 'hand';
}

/** Before and after per field, from the payload (patches carry `was`). */
export function changesOf(raw: Obj): AuditEntry['changes'] {
  const p = raw.payload;
  if (!isObj(p)) return undefined;
  switch (raw.kind) {
    case 'issue.status':
      return [{ field: 'status', before: p.from, after: p.to }];
    case 'issue.sighting.add':
      return [{ field: 'sighting', after: p.sighting ?? p.hash }];
    case 'issue.sighting.remove':
      return [{ field: 'sighting', before: p.sighting ?? p.hash }];
    case 'issue.recode':
      return [{ field: 'code', before: p.from, after: p.to }];
    case 'record.external':
      if (!isObj(p.patch)) return [{ field: 'file', before: p.before, after: p.after }];
      return patchChanges(p.patch);
    case 'issue.create':
    case 'issue.restore':
    case 'issue.delete':
      return undefined;
    default:
      break;
  }
  if ('record' in p) {
    return [{ field: 'record', before: p.was, after: p.record }];
  }
  if ('set' in p || 'unset' in p) return patchChanges(p);
  return undefined;
}

function patchChanges(p: Obj): AuditEntry['changes'] {
  const out: NonNullable<AuditEntry['changes']> = [];
  const was = isObj(p.was) ? p.was : {};
  if (isObj(p.set)) {
    for (const [field, after] of Object.entries(p.set)) {
      if (HIDDEN_FIELDS.has(field)) continue;
      out.push({ field, ...(field in was ? { before: was[field] } : {}), after });
    }
  }
  if (Array.isArray(p.unset)) {
    for (const field of p.unset) {
      if (typeof field !== 'string' || HIDDEN_FIELDS.has(field)) continue;
      out.push({ field, ...(field in was ? { before: was[field] } : {}) });
    }
  }
  return out.length ? out : undefined;
}

/** Who each actor is: from device records and `member.add` ops. */
export function actorNames(
  j: LoadedJournal,
  ops: readonly JournalOp[],
): Map<string, { name?: string; initials?: string }> {
  const names = new Map<string, { name?: string; initials?: string }>();
  const put = (actor: unknown, name: unknown, initials: unknown) => {
    if (typeof actor !== 'string') return;
    names.set(actor, {
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof initials === 'string' ? { initials } : {}),
    });
  };
  for (const d of j.devices.values()) if (d.raw) put(d.raw.actor, d.raw.name, d.raw.initials);
  for (const o of ops) {
    if (o.raw.kind !== 'member.add' || !isObj(o.raw.payload)) continue;
    const p = o.raw.payload;
    put(p.actor, p.name, p.initials);
  }
  return names;
}

export interface EntryOptions {
  /** Ops the merge engine holds in quarantine. */
  quarantined?: ReadonlySet<string>;
  /** Per-op findings of the last Verify (bad signatures). */
  badSignature?: ReadonlySet<string>;
}

const atOf = (hlc: string) => new Date(Number(hlc.slice(0, 13))).toISOString();

/**
 * Every op as an audit entry, newest first (by clock reading, then id). History, the Audit
 * screen and the exports all read these; the renderer never sees raw ops or keys.
 */
export function auditEntries(j: LoadedJournal, opts: EntryOptions = {}): AuditEntry[] {
  const ops = opsOf(j);
  const names = actorNames(j, ops);
  const redactions = new Map<string, { by: string; at: string }>();
  for (const o of ops) {
    const p = o.raw.payload;
    if (!isObj(p)) continue;
    const by = String(o.raw.act);
    const at = String(o.raw.hlc);
    if (o.raw.kind === 'op.redact' && typeof p.op === 'string') redactions.set(p.op, { by, at });
    if (o.raw.kind === 'comment.redact' && Array.isArray(p.ops)) {
      for (const x of p.ops) if (typeof x === 'string') redactions.set(x, { by, at });
    }
  }
  const out: AuditEntry[] = [];
  for (const o of ops) {
    const raw = o.raw;
    const id = String(raw.id);
    const hlc = String(raw.hlc);
    const kind = typeof raw.kind === 'string' ? raw.kind : 'unknown';
    const act = String(raw.act);
    const who = names.get(act) ?? {};
    const redacted = 'payload' in raw ? undefined : redactions.get(id);
    const changes = changesOf(raw);
    const state: AuditEntry['state'] = opts.badSignature?.has(id)
      ? 'bad-signature'
      : opts.quarantined?.has(id)
        ? 'quarantined'
        : !isKnownOpKind(kind)
          ? 'unknown-kind'
          : typeof raw.sig === 'string'
            ? 'ok'
            : 'unsigned';
    out.push({
      op: id,
      chain: String(raw.chain),
      seq: Number(raw.seq),
      hlc,
      at: atOf(hlc),
      actor: { id: act, ...who },
      device: String(raw.dev),
      kind,
      target: isObj(raw.target) ? (raw.target as RecordRef) : { rec: 'unknown', id: 'unknown' },
      ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
      how: howOf(raw),
      ...(isObj(raw.via) ? { via: raw.via as AuditEntry['via'] } : {}),
      ...(changes ? { changes } : {}),
      state,
      ...(redacted ? { redacted } : {}),
    });
  }
  out.sort((a, b) => (a.hlc < b.hlc ? 1 : a.hlc > b.hlc ? -1 : a.op < b.op ? 1 : -1));
  return out;
}

/** Does an entry pass the filter (who, what, record, how, time)? */
export function matchesFilter(e: AuditEntry, f: AuditFilter | undefined): boolean {
  if (!f) return true;
  if (f.actors?.length && !f.actors.includes(e.actor.id)) return false;
  if (f.kinds?.length && !f.kinds.some((k) => e.kind === k || e.kind.startsWith(`${k}.`))) {
    return false;
  }
  if (f.target) {
    if (e.target.rec !== f.target.rec || e.target.id !== f.target.id) return false;
    if (f.target.in !== undefined && e.target.in !== f.target.in) return false;
  }
  if (f.how?.length && !f.how.includes(e.how)) return false;
  if (f.from && e.at < new Date(f.from).toISOString()) return false;
  if (f.to && e.at > new Date(f.to).toISOString()) return false;
  return true;
}

/** One page of filtered entries; the cursor is the offset of the next page. */
export function pageEntries(
  entries: readonly AuditEntry[],
  filter: AuditFilter | undefined,
  limit = 200,
  cursor?: string,
): { entries: AuditEntry[]; cursor: string | null } {
  const from = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  const matching = filter ? entries.filter((e) => matchesFilter(e, filter)) : entries;
  const page = matching.slice(from, from + limit);
  const next = from + page.length;
  return { entries: page, cursor: next < matching.length ? String(next) : null };
}
