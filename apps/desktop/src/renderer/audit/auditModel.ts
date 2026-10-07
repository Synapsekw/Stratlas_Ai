import {
  isKnownOpKind,
  type AuditEntry,
  type AuditFilter,
  type ChangeHow,
  type Issue,
  type IssueStatus,
  type OpKind,
  type RecordRef,
  type VerifyProblem,
  type VerifyReport,
} from '@aio/schema';
import { t, type MessageKey } from '@aio/ui';

/**
 * Pure helpers of the History panel and the Audit trail screen (M9 stream T1): readable labels for
 * who, how and what, compact before and after values, the filter sent to `journal:history`, the
 * Restore plan of an issue change and the Verify report wording. No React, no IPC.
 */

/** Longest value shown in a History row before it is cut short. */
export const VALUE_MAX = 60;

const KIND_KEYS = {
  'issue.create': 'audit.kind.issue.create',
  'issue.patch': 'audit.kind.issue.patch',
  'issue.delete': 'audit.kind.issue.delete',
  'issue.restore': 'audit.kind.issue.restore',
  'issue.sighting.add': 'audit.kind.issue.sighting.add',
  'issue.sighting.remove': 'audit.kind.issue.sighting.remove',
  'issue.status': 'audit.kind.issue.status',
  'issue.merge': 'audit.kind.issue.merge',
  'issue.recode': 'audit.kind.issue.recode',
  'comment.add': 'audit.kind.comment.add',
  'comment.edit': 'audit.kind.comment.edit',
  'comment.delete': 'audit.kind.comment.delete',
  'comment.redact': 'audit.kind.comment.redact',
  'assign.set': 'audit.kind.assign.set',
  'approval.add': 'audit.kind.approval.add',
  'approval.withdraw': 'audit.kind.approval.withdraw',
  'change.review': 'audit.kind.change.review',
  'detection.review': 'audit.kind.detection.review',
  'procmodel.part': 'audit.kind.procmodel.part',
  'manifest.entry': 'audit.kind.manifest.entry',
  'boundary.edit': 'audit.kind.boundary.edit',
  'narrative.version': 'audit.kind.narrative.version',
  'blob.add': 'audit.kind.blob.add',
  'member.add': 'audit.kind.member.add',
  'member.role': 'audit.kind.member.role',
  'member.remove': 'audit.kind.member.remove',
  'member.link': 'audit.kind.member.link',
  'device.revoke': 'audit.kind.device.revoke',
  'policy.set': 'audit.kind.policy.set',
  'project.share': 'audit.kind.project.share',
  'package.export': 'audit.kind.package.export',
  'exchange.import': 'audit.kind.exchange.import',
  'conflict.resolve': 'audit.kind.conflict.resolve',
  'record.external': 'audit.kind.record.external',
  checkpoint: 'audit.kind.checkpoint',
  'journal.off': 'audit.kind.journal.off',
  'journal.on': 'audit.kind.journal.on',
  'op.redact': 'audit.kind.op.redact',
} as const satisfies Record<OpKind, MessageKey>;

/** What an op kind did, in words; kinds from a newer version read "Unknown change". */
export function kindLabel(kind: string): string {
  return isKnownOpKind(kind) ? t(KIND_KEYS[kind]) : t('audit.kind.unknown');
}

/** The text when it has any, else undefined (so `??` can fall back past blank strings). */
function filled(text: string | undefined): string | undefined {
  const s = text?.trim();
  return s === '' ? undefined : s;
}

/** The row's label: the editor's readable command, else a sentence from the kind. */
export function entryLabel(entry: Pick<AuditEntry, 'label' | 'kind' | 'state'>): string {
  if (entry.state === 'unknown-kind') return filled(entry.label) ?? t('audit.kind.unknown');
  return filled(entry.label) ?? kindLabel(entry.kind);
}

/** Who made the change: the name, else the initials, else "Unknown author" (never guessed). */
export function actorLabel(actor: AuditEntry['actor'] | undefined): string {
  return filled(actor?.name) ?? filled(actor?.initials) ?? t('audit.unknownAuthor');
}

const PIPELINE_KEYS: Record<string, MessageKey> = {
  inspection: 'audit.pipeline.inspection',
  road: 'audit.pipeline.road',
  volumetric: 'audit.pipeline.volumetric',
  aik: 'audit.pipeline.aik',
  pointcloud: 'audit.pipeline.pointcloud',
  change: 'audit.pipeline.change',
  drawing: 'audit.pipeline.drawing',
  model: 'audit.pipeline.model',
  system: 'audit.pipeline.system',
};

/** "inspection.run" to "Inspection": the family of a pipeline, as people say it. */
export function pipelineFamily(name: string): string {
  const head = name.split('.')[0] ?? name;
  const key = PIPELINE_KEYS[head];
  if (key) return t(key);
  const words = head.replace(/[_-]+/g, ' ').trim();
  return words ? `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}` : name;
}

/** The pipeline of an entry's `via`, when it has one. */
export function viaPipeline(via: AuditEntry['via']): string | null {
  if (!via || !('pipeline' in via)) return null;
  const p = (via as { pipeline?: { name?: unknown } }).pipeline;
  return typeof p?.name === 'string' && p.name ? p.name : null;
}

const HOW_KEYS = {
  hand: 'audit.how.hand',
  agent: 'audit.how.agent',
  pipeline: 'audit.how.pipeline',
  external: 'audit.how.external',
  import: 'audit.how.import',
  server: 'audit.how.server',
} as const satisfies Record<ChangeHow, MessageKey>;

/** How a change came about: "By hand", "Inspection pipeline (run by Dana Saleh)", ... */
export function howLabel(
  entry: Pick<AuditEntry, 'how' | 'via' | 'actor'>,
  product: string,
): string {
  if (entry.how === 'pipeline') {
    const name = viaPipeline(entry.via);
    if (!name) return t('audit.how.pipeline');
    const pipeline = pipelineFamily(name);
    const who = filled(entry.actor.name) ?? filled(entry.actor.initials);
    return who
      ? t('audit.how.pipelineRunBy', { pipeline, name: who })
      : t('audit.how.pipelineNamed', { pipeline });
  }
  return t(HOW_KEYS[entry.how], { product });
}

/** Every `how` a person can filter by (the server's own entries come with T7). */
export const HOW_FILTERS: readonly ChangeHow[] = [
  'hand',
  'agent',
  'pipeline',
  'external',
  'import',
];

export function howFilterLabel(how: ChangeHow, product: string): string {
  return t(HOW_KEYS[how], { product });
}

const FIELD_KEYS: Record<string, MessageKey> = {
  severity: 'audit.field.severity',
  classId: 'audit.field.classId',
  status: 'audit.field.status',
  title: 'audit.field.title',
  note: 'audit.field.note',
  measurements: 'audit.field.measurements',
  sightings: 'audit.field.sightings',
  code: 'audit.field.code',
};

/** A field name in words: known issue fields by name, others split from camelCase. */
export function fieldLabel(field: string): string {
  const key = FIELD_KEYS[field];
  if (key) return t(key);
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.]+/g, ' ')
    .toLowerCase();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 3))}...` : text;
}

/** A before or after value, compact and JSON-ish: strings plain, the rest as JSON, cut short. */
export function formatValue(value: unknown, max = VALUE_MAX): string {
  if (value === undefined) return t('audit.value.none');
  if (value === null || value === '') return t('audit.value.empty');
  if (typeof value === 'string') return clip(value.replace(/\s+/g, ' '), max);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  return clip(json ?? typeof value, max);
}

/** Local date and time of an entry ("7 Oct 2026, 14:05"). */
export function formatWhen(at: string, locale = 'en-GB'): string {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return at;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

/** Wall time of a clock reading (`<ms>.<counter>.<device>`), as an ISO time. */
export function hlcTime(hlc: string): string | null {
  const ms = Number(hlc.split('.')[0]);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/** States worth a badge; `ok` has none. */
export const STATE_KEYS = {
  unsigned: 'audit.state.unsigned',
  'bad-signature': 'audit.state.bad-signature',
  quarantined: 'audit.state.quarantined',
  'unknown-kind': 'audit.state.unknown-kind',
} as const satisfies Record<Exclude<AuditEntry['state'], 'ok'>, MessageKey>;

export function stateLabel(state: AuditEntry['state']): string | null {
  return state === 'ok' ? null : t(STATE_KEYS[state]);
}

/** "Redacted by Dana Saleh on 7 Oct 2026", naming the actor from the entries seen, else unknown. */
export function redactedLabel(
  redacted: NonNullable<AuditEntry['redacted']>,
  names: ReadonlyMap<string, string>,
  locale = 'en-GB',
): string {
  const at = hlcTime(redacted.at);
  const date = at
    ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(
        new Date(at),
      )
    : redacted.at;
  return t('audit.redacted', { name: names.get(redacted.by) ?? t('audit.unknownAuthor'), date });
}

/** Actor names seen in a list of entries, for redaction lines and the Who filter. */
export function actorsSeen(
  entries: readonly AuditEntry[],
  into: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const out = new Map(into);
  for (const e of entries) {
    const known = out.get(e.actor.id);
    const label = actorLabel(e.actor);
    if (!known || (known === t('audit.unknownAuthor') && label !== known))
      out.set(e.actor.id, label);
  }
  return out;
}

/** Does a `journal:changed` event touch this record? An empty list means "reload everything". */
export function touches(records: readonly RecordRef[], target: RecordRef): boolean {
  if (records.length === 0) return true;
  return records.some((r) => r.rec === target.rec && r.id === target.id);
}

// ---------------------------------------------------------------- Audit filters

export const KIND_GROUPS = {
  issues: [
    'issue.create',
    'issue.patch',
    'issue.delete',
    'issue.restore',
    'issue.sighting.add',
    'issue.sighting.remove',
    'issue.status',
    'issue.merge',
    'issue.recode',
  ],
  comments: ['comment.add', 'comment.edit', 'comment.delete', 'comment.redact'],
  review: ['assign.set', 'approval.add', 'approval.withdraw'],
  records: [
    'change.review',
    'detection.review',
    'procmodel.part',
    'manifest.entry',
    'boundary.edit',
    'narrative.version',
    'blob.add',
  ],
  team: [
    'member.add',
    'member.role',
    'member.remove',
    'member.link',
    'device.revoke',
    'policy.set',
    'project.share',
  ],
  events: [
    'package.export',
    'exchange.import',
    'conflict.resolve',
    'record.external',
    'checkpoint',
    'journal.off',
    'journal.on',
    'op.redact',
  ],
} as const satisfies Record<string, readonly OpKind[]>;
export type KindGroup = keyof typeof KIND_GROUPS;
export const KIND_GROUP_IDS = Object.keys(KIND_GROUPS) as KindGroup[];

const GROUP_KEYS = {
  issues: 'audit.group.issues',
  comments: 'audit.group.comments',
  review: 'audit.group.review',
  records: 'audit.group.records',
  team: 'audit.group.team',
  events: 'audit.group.events',
} as const satisfies Record<KindGroup, MessageKey>;

export function groupLabel(group: KindGroup): string {
  return t(GROUP_KEYS[group]);
}

/** What the Audit screen's filter bar holds; empty strings mean "any". */
export interface AuditFilterForm {
  /** Actor id. */
  who: string;
  what: KindGroup | '';
  /** Issue code or id, or any record id text. */
  record: string;
  /** `YYYY-MM-DD`, local. */
  from: string;
  to: string;
  how: ChangeHow | '';
}

export const EMPTY_FILTER_FORM: AuditFilterForm = {
  who: '',
  what: '',
  record: '',
  from: '',
  to: '',
  how: '',
};

/** Start (or, with `end`, the last millisecond) of a local calendar day, as an ISO time. */
export function localDayIso(date: string, end = false): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (end ? 1 : 0));
  if (Number.isNaN(d.getTime())) return undefined;
  return new Date(d.getTime() - (end ? 1 : 0)).toISOString();
}

/** The record a Record filter text names: an issue by code (any case) or id, else null. */
export function resolveRecord(
  text: string,
  issues: readonly Pick<Issue, 'id' | 'code'>[],
): RecordRef | null {
  const q = text.trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  const hit = issues.find((i) => i.code.toLowerCase() === lower) ?? issues.find((i) => i.id === q);
  return hit ? { rec: 'issue', id: hit.id } : null;
}

/**
 * The `journal:history` filter of the form. A Record text that names no issue is not sent (the
 * filter needs a record kind); `matchesRecordText` narrows the loaded entries instead.
 */
export function buildFilter(
  form: AuditFilterForm,
  issues: readonly Pick<Issue, 'id' | 'code'>[],
): AuditFilter {
  const filter: AuditFilter = {};
  if (form.who) filter.actors = [form.who];
  if (form.what) filter.kinds = [...KIND_GROUPS[form.what]];
  const target = resolveRecord(form.record, issues);
  if (target) filter.target = target;
  if (form.how) filter.how = [form.how];
  const from = localDayIso(form.from);
  if (from) filter.from = from;
  const to = localDayIso(form.to, true);
  if (to) filter.to = to;
  return filter;
}

/** Client-side narrowing for a Record text the filter could not carry (not an issue). */
export function matchesRecordText(
  entry: Pick<AuditEntry, 'target' | 'label'>,
  text: string,
  issues: readonly Pick<Issue, 'id' | 'code'>[],
): boolean {
  const q = text.trim().toLowerCase();
  if (!q || resolveRecord(text, issues)) return true;
  return (
    entry.target.id.toLowerCase().includes(q) ||
    (entry.target.in?.toLowerCase().includes(q) ?? false) ||
    (entry.label?.toLowerCase().includes(q) ?? false)
  );
}

/** The record of an entry in a few characters: an issue's code, else `<kind> <id>`. */
export function recordLabel(
  target: RecordRef,
  issues: readonly Pick<Issue, 'id' | 'code'>[],
): string {
  if (target.rec === 'issue') {
    const issue = issues.find((i) => i.id === target.id);
    if (issue) return issue.code;
  }
  const id = target.id.length > 24 ? `${target.id.slice(0, 21)}...` : target.id;
  return `${target.rec} ${id}`;
}

// ---------------------------------------------------------------- Restore

const STATUSES: readonly IssueStatus[] = ['draft', 'reviewed', 'approved', 'closed'];

/** The issue fields Restore can put back through the issue editor. */
export interface RestorePlan {
  patch: {
    classId?: string;
    severity?: Issue['severity'];
    title?: string;
    note?: string;
    measurements?: NonNullable<Issue['measurements']>;
  };
  status?: IssueStatus;
  /** Field names restored, in the entry's order. */
  fields: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What Restore would put back on `issue` from an entry's `before` values: only fields the editor
 * can set, with a well-formed value that differs from the issue now. Null when nothing would change.
 */
export function restorePlan(
  changes: AuditEntry['changes'],
  issue: Issue | undefined,
): RestorePlan | null {
  if (!changes?.length || !issue) return null;
  const plan: RestorePlan = { patch: {}, fields: [] };
  for (const c of changes) {
    const v = c.before;
    if (v === undefined) continue;
    const now = (issue as Record<string, unknown>)[c.field];
    if (same(v, now)) continue;
    let took = true;
    switch (c.field) {
      case 'classId':
      case 'title':
      case 'note':
        if (typeof v === 'string') plan.patch[c.field] = v;
        else took = false;
        break;
      case 'severity':
        if ((typeof v === 'number' && Number.isFinite(v)) || v === 'uncertain')
          plan.patch.severity = v;
        else took = false;
        break;
      case 'measurements':
        if (typeof v === 'object' && v !== null)
          plan.patch.measurements = v as NonNullable<Issue['measurements']>;
        else took = false;
        break;
      case 'status':
        if (typeof v === 'string' && (STATUSES as readonly string[]).includes(v))
          plan.status = v as IssueStatus;
        else took = false;
        break;
      default:
        took = false;
    }
    if (took) plan.fields.push(c.field);
  }
  return plan.fields.length ? plan : null;
}

/** The Restore button's words: "Restore F01 severity", "Restore F01 severity and note". */
export function restoreText(code: string, fields: readonly string[], locale = 'en-GB'): string {
  return t('audit.restore.label', { code, fields: fieldList(fields, locale) }).trim();
}

/** "severity, note and status". */
export function fieldList(fields: readonly string[], locale = 'en-GB'): string {
  return new Intl.ListFormat(locale, { type: 'conjunction' }).format(fields.map(fieldLabel));
}

// ---------------------------------------------------------------- Verify

/** The headline of a Verify report. */
export function verifyHeadline(report: VerifyReport): string {
  if (!report.ok || report.problems.length > 0) {
    const count = report.problems.length;
    return t('audit.verify.problems', { count: Math.max(1, count) });
  }
  if (report.counts.unsigned > 0)
    return t('audit.verify.intactUnsigned', { count: report.counts.unsigned });
  return t('audit.verify.intact');
}

/** Intact and fully signed: the one line the founder test looks for. */
export function verifyClean(report: VerifyReport): boolean {
  return report.ok && report.problems.length === 0 && report.counts.unsigned === 0;
}

export const COUNT_KEYS = {
  ops: 'audit.count.ops',
  signed: 'audit.count.signed',
  unsigned: 'audit.count.unsigned',
  external: 'audit.count.external',
  quarantined: 'audit.count.quarantined',
  redacted: 'audit.count.redacted',
} as const satisfies Record<keyof VerifyReport['counts'], MessageKey>;

const PROBLEM_KEYS = {
  parse: 'audit.problem.parse',
  'hash-mismatch': 'audit.problem.hash-mismatch',
  'payload-hash': 'audit.problem.payload-hash',
  'payload-missing': 'audit.problem.payload-missing',
  'chain-gap': 'audit.problem.chain-gap',
  order: 'audit.problem.order',
  truncated: 'audit.problem.truncated',
  'segment-missing': 'audit.problem.segment-missing',
  fork: 'audit.problem.fork',
  'bad-signature': 'audit.problem.bad-signature',
  unsigned: 'audit.problem.unsigned',
  'unknown-device': 'audit.problem.unknown-device',
  'revoked-device': 'audit.problem.revoked-device',
  'checkpoint-mismatch': 'audit.problem.checkpoint-mismatch',
  'clock-ahead': 'audit.problem.clock-ahead',
} as const satisfies Record<VerifyProblem['code'], MessageKey>;

/** Where a problem sits: "Line 2 of journal/ops/<chain>/000001.jsonl", the file, or "An entry". */
export function problemWhere(p: Pick<VerifyProblem, 'file' | 'line'>): string {
  if (p.file && p.line !== undefined) return t('audit.where.line', { line: p.line, file: p.file });
  if (p.file) return t('audit.where.file', { file: p.file });
  return t('audit.where.none');
}

/** A problem in plain English: "Line 2 of journal/ops/.../000001.jsonl was edited." */
export function problemText(p: Pick<VerifyProblem, 'code' | 'file' | 'line'>): string {
  const key: MessageKey =
    (PROBLEM_KEYS as Record<string, MessageKey>)[p.code] ?? 'audit.problem.other';
  return t(key, { where: problemWhere(p) });
}

// ---------------------------------------------------------------- IPC results

/** A bridge result whose value is itself `{ ok }`: one flat success or failure. */
export type Flat<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };

export function flatten<V extends { ok: boolean }>(
  res: { ok: true; value: V } | { ok: false; error: string },
): Flat<Extract<V, { ok: true }>> {
  if (!res.ok) return { ok: false, error: res.error };
  const v = res.value;
  if (v.ok) return { ok: true, value: v as Extract<V, { ok: true }> };
  const failure = v as unknown as { ok: false; error: string; code?: string | undefined };
  return failure.code !== undefined
    ? { ok: false, error: failure.error, code: failure.code }
    : { ok: false, error: failure.error };
}
