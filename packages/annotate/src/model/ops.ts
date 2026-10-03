import {
  Issue as IssueSchema,
  err,
  ok,
  validateIssueAgainstModel,
  type ClassCatalogue,
  type Issue,
  type IssueClass,
  type IssueStatus,
  type Result,
  type SeverityModel,
  type Sighting,
} from '@aio/schema';

/** What every issue change is checked against: the project's severity models and catalogues. */
export interface IssueContext {
  models: readonly SeverityModel[];
  catalogues: readonly ClassCatalogue[];
}

export type Severity = Issue['severity'];

/** Next free issue code for a prefix: F01..F99, then F100. */
export function nextIssueCode(existing: readonly string[], prefix: string): string {
  if (!/^[A-Z]{1,3}$/.test(prefix)) {
    throw new Error(`Issue prefix must be 1 to 3 capital letters, got "${prefix}"`);
  }
  let max = 0;
  for (const code of existing) {
    if (!code.startsWith(prefix)) continue;
    const n = Number(code.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(2, '0')}`;
}

export function findClass(ctx: IssueContext, classId: string): IssueClass | undefined {
  for (const c of ctx.catalogues) {
    const hit = c.classes.find((k) => k.id === classId);
    if (hit) return hit;
  }
  return undefined;
}

export function findModel(ctx: IssueContext, modelId: string): SeverityModel | undefined {
  return ctx.models.find((m) => m.id === modelId);
}

/** Schema check plus the severity check against the issue's model. */
export function validateIssue(issue: Issue, ctx: IssueContext): Result<Issue> {
  const parsed = IssueSchema.safeParse(issue);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` at ${first.path.join('.')}` : '';
    return err(`Issue ${issue.code} is invalid${where}: ${first?.message ?? 'unknown error'}`);
  }
  const model = findModel(ctx, issue.severityModelId);
  if (!model) {
    return err(
      `Issue ${issue.code}: severity model "${issue.severityModelId}" is not in the project`,
    );
  }
  return validateIssueAgainstModel(issue, model);
}

export interface NewIssueInput {
  sighting: Sighting;
  classId: string;
  severity: Severity;
  author: string;
  /** ISO time stamp for createdAt and updatedAt. */
  now: string;
  title?: string;
  note?: string;
  id?: string;
  /** Code prefix, default F. */
  prefix?: string;
  source?: Issue['source'];
  /** Used only when the class is not in a catalogue (imports without a taxonomy). */
  severityModelId?: string;
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

/** A new draft issue from its first sighting; the code continues the project's sequence. */
export function createIssue(
  existing: readonly Issue[],
  input: NewIssueInput,
  ctx: IssueContext,
): Result<Issue> {
  const cls = findClass(ctx, input.classId);
  const severityModelId = cls?.severityModel ?? input.severityModelId;
  if (!severityModelId) return err(`Class "${input.classId}" is not in any class catalogue`);
  const given = input.title?.trim() ?? '';
  const issue: Issue = {
    id: input.id ?? newId(),
    code: nextIssueCode(
      existing.map((i) => i.code),
      input.prefix ?? 'F',
    ),
    classId: input.classId,
    severityModelId,
    severity: input.severity,
    status: 'draft',
    title: given.length > 0 ? given : (cls?.label ?? input.classId),
    note: input.note ?? '',
    author: input.author,
    createdAt: input.now,
    updatedAt: input.now,
    sightings: [input.sighting],
    source: input.source ?? 'human',
  };
  return validateIssue(issue, ctx);
}

export function addSighting(issue: Issue, sighting: Sighting, now: string): Issue {
  return { ...issue, sightings: [...issue.sightings, sighting], updatedAt: now };
}

export function replaceSighting(
  issue: Issue,
  index: number,
  sighting: Sighting,
  now: string,
): Result<Issue> {
  if (index < 0 || index >= issue.sightings.length) {
    return err(`Issue ${issue.code} has no sighting ${index + 1}`);
  }
  const sightings = issue.sightings.slice();
  sightings[index] = sighting;
  return ok({ ...issue, sightings, updatedAt: now });
}

export function removeSighting(issue: Issue, index: number, now: string): Result<Issue> {
  if (index < 0 || index >= issue.sightings.length) {
    return err(`Issue ${issue.code} has no sighting ${index + 1}`);
  }
  if (issue.sightings.length === 1) {
    return err(`Issue ${issue.code} needs at least one sighting; delete the issue instead`);
  }
  return ok({
    ...issue,
    sightings: issue.sightings.filter((_, i) => i !== index),
    updatedAt: now,
  });
}

/**
 * Link a sighting to another issue: it leaves `from` and joins `to`. When it was the last
 * sighting of `from`, `from` comes back as null and should be deleted.
 */
export function moveSighting(
  from: Issue,
  index: number,
  to: Issue,
  now: string,
): Result<{ from: Issue | null; to: Issue }> {
  const s = from.sightings[index];
  if (!s) return err(`Issue ${from.code} has no sighting ${index + 1}`);
  if (from.id === to.id) return err('A sighting cannot be moved to the issue it belongs to');
  const rest = from.sightings.filter((_, i) => i !== index);
  return ok({
    from: rest.length ? { ...from, sightings: rest, updatedAt: now } : null,
    to: addSighting(to, s, now),
  });
}

/** All sightings of `source` join `target`; `source` should then be deleted. */
export function mergeIssues(target: Issue, source: Issue, now: string): Issue {
  const line = `Merged ${source.code}: ${source.title}`;
  return {
    ...target,
    sightings: [...target.sightings, ...source.sightings],
    note: target.note ? `${target.note}\n${line}` : line,
    updatedAt: now,
  };
}

export const STATUS_ORDER: readonly IssueStatus[] = ['draft', 'reviewed', 'approved', 'closed'];

/** Forward one step (draft, reviewed, approved, closed) or back one step to reopen. */
export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  const a = STATUS_ORDER.indexOf(from);
  const b = STATUS_ORDER.indexOf(to);
  return Math.abs(a - b) === 1;
}

export function nextStatus(s: IssueStatus): IssueStatus | null {
  return STATUS_ORDER[STATUS_ORDER.indexOf(s) + 1] ?? null;
}

export function previousStatus(s: IssueStatus): IssueStatus | null {
  return STATUS_ORDER[STATUS_ORDER.indexOf(s) - 1] ?? null;
}

export function setStatus(issue: Issue, status: IssueStatus, now: string): Result<Issue> {
  if (issue.status === status) return ok(issue);
  if (!canTransition(issue.status, status)) {
    return err(`Issue ${issue.code} cannot go from ${issue.status} to ${status}`);
  }
  return ok({ ...issue, status, updatedAt: now });
}

export interface IssuePatch {
  classId?: string;
  severity?: Severity;
  title?: string;
  note?: string;
  measurements?: NonNullable<Issue['measurements']>;
}

/** Edit fields; a class change brings the class's severity model with it. Always validated. */
export function updateIssue(
  issue: Issue,
  patch: IssuePatch,
  now: string,
  ctx: IssueContext,
): Result<Issue> {
  const next: Issue = { ...issue, updatedAt: now };
  if (patch.classId !== undefined && patch.classId !== issue.classId) {
    const cls = findClass(ctx, patch.classId);
    if (!cls) return err(`Class "${patch.classId}" is not in any class catalogue`);
    next.classId = cls.id;
    next.severityModelId = cls.severityModel;
  }
  if (patch.severity !== undefined) next.severity = patch.severity;
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.note !== undefined) next.note = patch.note;
  if (patch.measurements !== undefined) next.measurements = patch.measurements;
  return validateIssue(next, ctx);
}
