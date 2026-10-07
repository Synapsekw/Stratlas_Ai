/**
 * Audit exports (M9 T1): `audit-csv` (UTF-8 with BOM, Arabic safe, opens in Excel) and
 * `audit-json` (every op file, device key and checkpoint of the journal plus the readable entries
 * and the Verify report, anchored by a fresh signed checkpoint; `tools/audit-verify/verify.mjs`
 * checks it with no dependencies). Both fall under the package export kind `files`.
 */
import { writeFile } from 'node:fs/promises';
import type { AuditEntry, IpcRequest, IpcResponse } from '@aio/schema';
import { matchesFilter } from '@aio/journal';
import type { JournalService } from '../journal';

export const AUDIT_JSON_SCHEMA = 'aio.audit/1';

const BOM = String.fromCharCode(0xfeff);

/** One CSV cell: quoted when needed; a leading formula character is neutralised for Excel. */
function cell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const HOW: Record<AuditEntry['how'], string> = {
  hand: 'By hand',
  agent: 'By the assistant',
  pipeline: 'Pipeline run',
  external: 'Changed outside {product}',
  import: 'Imported',
  server: 'From the team server',
};

const show = (v: unknown): string => {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  const s = JSON.stringify(v);
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
};

export const AUDIT_CSV_COLUMNS = [
  'Time (UTC)',
  'Who',
  'Initials',
  'Actor',
  'How',
  'Pipeline or agent',
  'Change',
  'Record',
  'In',
  'Label',
  'Before and after',
  'State',
  'Redacted by',
  'Entry',
  'Chain',
  'Seq',
] as const;

/** The audit as CSV: one row per entry, newest first. */
export function auditCsv(entries: readonly AuditEntry[], product = 'the app'): string {
  const rows = [AUDIT_CSV_COLUMNS.map(cell).join(',')];
  for (const e of entries) {
    const via = e.via as Record<string, Record<string, unknown> | undefined> | undefined;
    const by = via?.pipeline?.name ?? via?.agent?.model ?? via?.agent?.provider ?? '';
    const changes = (e.changes ?? [])
      .map((c) => `${c.field}: ${show(c.before)} to ${show(c.after)}`)
      .join('; ');
    rows.push(
      [
        e.at,
        e.actor.name ?? '',
        e.actor.initials ?? '',
        e.actor.id,
        HOW[e.how].replace('{product}', product),
        typeof by === 'string' ? by : '',
        e.kind,
        `${e.target.rec} ${e.target.id}`,
        e.target.in ?? '',
        e.label ?? '',
        changes,
        e.state,
        e.redacted ? `${e.redacted.by} at ${e.redacted.at}` : '',
        e.op,
        e.chain,
        String(e.seq),
      ]
        .map(cell)
        .join(','),
    );
  }
  return `${BOM}${rows.join('\r\n')}\r\n`;
}

export interface AuditExportDeps {
  journal: JournalService;
  /** Save dialog; null when cancelled. */
  choose: (defaultName: string, format: 'audit-csv' | 'audit-json') => Promise<string | null>;
  projectName: (projectId: string) => string | undefined;
  app: { name: string; version: string };
  now?: () => Date;
}

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'project';

export function createAuditExport(deps: AuditExportDeps) {
  return async (req: IpcRequest<'audit:export'>): Promise<IpcResponse<'audit:export'>> => {
    const now = deps.now?.() ?? new Date();
    // anchor what leaves the machine with a signed checkpoint
    await deps.journal.checkpointNow(req.projectId);
    const all = await deps.journal.entries(req.projectId);
    if (!all) return { ok: false, error: `Project "${req.projectId}" is not open.` };
    const entries = req.filter ? all.filter((e) => matchesFilter(e, req.filter)) : all;
    const name = deps.projectName(req.projectId) ?? req.projectId;
    const day = now.toISOString().slice(0, 10);
    const ext = req.format === 'audit-csv' ? 'csv' : 'json';
    const path = await deps.choose(`${slug(name)}-audit-${day}.${ext}`, req.format);
    if (path === null) return { ok: true, path: null, count: entries.length };
    if (req.format === 'audit-csv') {
      await writeFile(path, auditCsv(entries, deps.app.name), 'utf8');
      return { ok: true, path, count: entries.length };
    }
    const files = await deps.journal.files(req.projectId);
    const verified = await deps.journal.verify(req.projectId);
    const report = verified.ok ? verified.report : null;
    const doc = {
      schema: AUDIT_JSON_SCHEMA,
      app: deps.app,
      project: { name },
      exportedAt: now.toISOString(),
      ...(req.filter ? { filter: req.filter } : {}),
      head: report?.head ?? null,
      verify: report,
      entries,
      journal: Object.fromEntries(files?.files ?? []),
    };
    await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    return { ok: true, path, count: entries.length };
  };
}
