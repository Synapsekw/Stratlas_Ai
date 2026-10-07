import type { AuditEntry, Issue, VerifyReport } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  actorLabel,
  actorsSeen,
  buildFilter,
  EMPTY_FILTER_FORM,
  entryLabel,
  fieldLabel,
  flatten,
  formatValue,
  formatWhen,
  howLabel,
  KIND_GROUPS,
  kindLabel,
  localDayIso,
  matchesRecordText,
  pipelineFamily,
  problemText,
  recordLabel,
  redactedLabel,
  resolveRecord,
  restorePlan,
  restoreText,
  stateLabel,
  touches,
  verifyClean,
  verifyHeadline,
} from './auditModel';

const DEV = `d_${'a'.repeat(52)}`;
const ACTOR = `a_${'b'.repeat(26)}`;
const OTHER = `a_${'c'.repeat(26)}`;
const HASH = 'f'.repeat(64);

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    op: HASH,
    chain: `${DEV}.r_${'d'.repeat(16)}`,
    seq: 1,
    hlc: `1791374700000.0000.${DEV}`,
    at: '2026-10-07T12:05:00.000Z',
    actor: { id: ACTOR, name: 'Dana Saleh', initials: 'DS' },
    device: DEV,
    kind: 'issue.patch',
    target: { rec: 'issue', id: 'iss-1' },
    how: 'hand',
    state: 'ok',
    ...over,
  };
}

const issues = [
  { id: 'iss-1', code: 'F01' },
  { id: 'iss-2', code: 'F02' },
];

const issue = {
  id: 'iss-1',
  code: 'F01',
  classId: 'blister',
  severity: 4,
  status: 'reviewed',
  title: 'Blistering',
  note: 'New note',
} as unknown as Issue;

describe('labels', () => {
  it('reads every known kind and calls newer kinds an unknown change', () => {
    expect(kindLabel('issue.status')).toBe('Status changed');
    expect(kindLabel('issue.sighting.add')).toBe('Sighting added');
    expect(kindLabel('widget.spin')).toBe('Unknown change');
    for (const kinds of Object.values(KIND_GROUPS))
      for (const k of kinds) expect(kindLabel(k), k).not.toBe('Unknown change');
  });

  it('prefers the editor label, else the kind', () => {
    expect(entryLabel(entry({ label: 'F01 to reviewed' }))).toBe('F01 to reviewed');
    expect(entryLabel(entry({ label: '  ' }))).toBe('Issue edited');
    expect(entryLabel(entry({ kind: 'widget.spin', state: 'unknown-kind' }))).toBe(
      'Unknown change',
    );
  });

  it('names the author, falling back to initials and then to unknown', () => {
    expect(actorLabel({ id: ACTOR, name: 'Dana Saleh' })).toBe('Dana Saleh');
    expect(actorLabel({ id: ACTOR, initials: 'DS' })).toBe('DS');
    expect(actorLabel({ id: ACTOR })).toBe('Unknown author');
    expect(actorLabel(undefined)).toBe('Unknown author');
  });

  it('says how a change came about', () => {
    expect(howLabel(entry(), 'Quadrion AI')).toBe('By hand');
    expect(howLabel(entry({ how: 'agent' }), 'Quadrion AI')).toBe('By the assistant');
    expect(howLabel(entry({ how: 'external' }), 'Quadrion AI')).toBe('Changed outside Quadrion AI');
    expect(howLabel(entry({ how: 'import' }), 'Quadrion AI')).toBe('Imported');
    expect(howLabel(entry({ how: 'pipeline' }), 'Quadrion AI')).toBe('Pipeline run');
    const via = { pipeline: { name: 'inspection.run', jobId: 'job-1' } };
    expect(howLabel(entry({ how: 'pipeline', via }), 'Quadrion AI')).toBe(
      'Inspection pipeline (run by Dana Saleh)',
    );
    expect(howLabel(entry({ how: 'pipeline', via, actor: { id: ACTOR } }), 'Quadrion AI')).toBe(
      'Inspection pipeline',
    );
  });

  it('names pipeline families, known or not', () => {
    expect(pipelineFamily('road.build')).toBe('Road');
    expect(pipelineFamily('pointcloud.to_copc')).toBe('Point cloud');
    expect(pipelineFamily('survey_kit.run')).toBe('Survey kit');
  });

  it('badges only states that need attention', () => {
    expect(stateLabel('ok')).toBeNull();
    expect(stateLabel('unsigned')).toBe('Not signed');
    expect(stateLabel('bad-signature')).toBe('Signature does not match');
    expect(stateLabel('quarantined')).toBe('Held back');
  });

  it('splits field names into words', () => {
    expect(fieldLabel('classId')).toBe('class');
    expect(fieldLabel('severity')).toBe('severity');
    expect(fieldLabel('reviewNote')).toBe('review note');
  });
});

describe('values and times', () => {
  it('shows values compact and JSON-ish', () => {
    expect(formatValue(undefined)).toBe('not set');
    expect(formatValue(null)).toBe('empty');
    expect(formatValue('')).toBe('empty');
    expect(formatValue(3)).toBe('3');
    expect(formatValue(false)).toBe('false');
    expect(formatValue('two\n lines')).toBe('two lines');
    expect(formatValue({ depthMm: 2 })).toBe('{"depthMm":2}');
    expect(formatValue(['a', 'b'])).toBe('["a","b"]');
  });

  it('cuts long values short', () => {
    const long = formatValue('x'.repeat(200));
    expect(long).toHaveLength(60);
    expect(long.endsWith('...')).toBe(true);
    const json = formatValue({ text: 'y'.repeat(200) }, 20);
    expect(json).toHaveLength(20);
    expect(json).toMatch(/^\{"text":"y+\.\.\.$/);
  });

  it('keeps Arabic text as it is', () => {
    expect(formatValue('تقشر في البطانة')).toBe('تقشر في البطانة');
  });

  it('formats the local date and time of an entry', () => {
    const text = formatWhen('2026-10-07T12:05:00.000Z');
    expect(text).toContain('2026');
    expect(text).toContain('Oct');
    expect(formatWhen('not a time')).toBe('not a time');
  });

  it('names the redacting actor and the day', () => {
    const names = new Map([[ACTOR, 'Dana Saleh']]);
    expect(redactedLabel({ by: ACTOR, at: `1791374700000.0000.${DEV}` }, names)).toMatch(
      /^Redacted by Dana Saleh on \d{1,2} Oct 2026$/,
    );
    expect(redactedLabel({ by: OTHER, at: `1791374700000.0000.${DEV}` }, names)).toContain(
      'Unknown author',
    );
  });

  it('collects the actors seen, keeping names over unknowns', () => {
    const seen = actorsSeen([
      entry({ actor: { id: OTHER } }),
      entry(),
      entry({ actor: { id: OTHER, name: 'Omar' } }),
    ]);
    expect([...seen]).toEqual([
      [OTHER, 'Omar'],
      [ACTOR, 'Dana Saleh'],
    ]);
  });
});

describe('journal:changed', () => {
  it('reloads for its record, or for an empty list', () => {
    const target = { rec: 'issue', id: 'iss-1' };
    expect(touches([], target)).toBe(true);
    expect(touches([{ rec: 'issue', id: 'iss-1' }], target)).toBe(true);
    expect(touches([{ rec: 'issue', id: 'iss-2' }], target)).toBe(false);
    expect(touches([{ rec: 'comment', id: 'iss-1' }], target)).toBe(false);
  });
});

describe('filters', () => {
  it('sends nothing for an empty form', () => {
    expect(buildFilter(EMPTY_FILTER_FORM, issues)).toEqual({});
  });

  it('builds who, what, record, how and time', () => {
    const filter = buildFilter(
      {
        who: ACTOR,
        what: 'comments',
        record: 'f01',
        from: '2026-10-01',
        to: '2026-10-07',
        how: 'pipeline',
      },
      issues,
    );
    expect(filter.actors).toEqual([ACTOR]);
    expect(filter.kinds).toEqual([
      'comment.add',
      'comment.edit',
      'comment.delete',
      'comment.redact',
    ]);
    expect(filter.target).toEqual({ rec: 'issue', id: 'iss-1' });
    expect(filter.how).toEqual(['pipeline']);
    expect(filter.from).toBe(new Date(2026, 9, 1).toISOString());
    expect(filter.to).toBe(new Date(new Date(2026, 9, 8).getTime() - 1).toISOString());
  });

  it('turns local days into ISO times and ignores bad dates', () => {
    expect(localDayIso('2026-02-28')).toBe(new Date(2026, 1, 28).toISOString());
    expect(localDayIso('')).toBeUndefined();
    expect(localDayIso('28/02/2026')).toBeUndefined();
  });

  it('resolves a record by code or id', () => {
    expect(resolveRecord('F02', issues)).toEqual({ rec: 'issue', id: 'iss-2' });
    expect(resolveRecord(' iss-1 ', issues)).toEqual({ rec: 'issue', id: 'iss-1' });
    expect(resolveRecord('cs-9', issues)).toBeNull();
    expect(resolveRecord('', issues)).toBeNull();
  });

  it('narrows by record text the filter could not carry', () => {
    const e = entry({ target: { rec: 'change-item', id: 'ci-42', in: 'cs-7' } });
    expect(matchesRecordText(e, 'ci-4', issues)).toBe(true);
    expect(matchesRecordText(e, 'cs-7', issues)).toBe(true);
    expect(matchesRecordText(e, 'zz', issues)).toBe(false);
    // a resolved issue is filtered by main, so every loaded entry passes
    expect(matchesRecordText(e, 'F01', issues)).toBe(true);
    expect(matchesRecordText(e, '', issues)).toBe(true);
  });

  it('labels records by issue code, else kind and id', () => {
    expect(recordLabel({ rec: 'issue', id: 'iss-2' }, issues)).toBe('F02');
    expect(recordLabel({ rec: 'issue', id: 'gone' }, issues)).toBe('issue gone');
    expect(recordLabel({ rec: 'detection', id: 'd'.repeat(40) }, issues)).toBe(
      `detection ${'d'.repeat(21)}...`,
    );
  });
});

describe('restore', () => {
  it('puts back the before values the editor can set', () => {
    const plan = restorePlan(
      [
        { field: 'severity', before: 2, after: 4 },
        { field: 'note', before: 'Old note', after: 'New note' },
        { field: 'status', before: 'draft', after: 'reviewed' },
        { field: 'sightings', before: [], after: [{}] },
      ],
      issue,
    );
    expect(plan).toEqual({
      patch: { severity: 2, note: 'Old note' },
      status: 'draft',
      fields: ['severity', 'note', 'status'],
    });
    expect(restoreText('F01', plan?.fields ?? [])).toBe('Restore F01 severity, note and status');
    expect(restoreText('F01', ['severity'])).toBe('Restore F01 severity');
  });

  it('has nothing to restore when values match, are missing or are malformed', () => {
    expect(restorePlan(undefined, issue)).toBeNull();
    expect(restorePlan([], issue)).toBeNull();
    expect(restorePlan([{ field: 'severity', before: 4, after: 5 }], issue)).toBeNull();
    expect(restorePlan([{ field: 'title', after: 'New' }], issue)).toBeNull();
    expect(restorePlan([{ field: 'status', before: 'lost', after: 'draft' }], issue)).toBeNull();
    expect(restorePlan([{ field: 'severity', before: 2 }], undefined)).toBeNull();
  });

  it('takes the uncertain severity', () => {
    expect(restorePlan([{ field: 'severity', before: 'uncertain' }], issue)?.patch).toEqual({
      severity: 'uncertain',
    });
  });
});

describe('verify', () => {
  const report = (over: Partial<VerifyReport> = {}): VerifyReport => ({
    ok: true,
    checkedAt: '2026-10-07T12:00:00.000Z',
    head: { root: HASH, count: 3 },
    chains: [],
    counts: { ops: 3, signed: 3, unsigned: 0, external: 0, quarantined: 0, redacted: 0 },
    problems: [],
    ...over,
  });

  it('says the history is intact when every entry is signed', () => {
    expect(verifyHeadline(report())).toBe('The history is intact. Every entry is signed.');
    expect(verifyClean(report())).toBe(true);
  });

  it('counts unsigned entries of an intact history', () => {
    const r = report({
      counts: { ops: 3, signed: 2, unsigned: 1, external: 0, quarantined: 0, redacted: 0 },
    });
    expect(verifyHeadline(r)).toBe('The history is intact. 1 entry is not signed.');
    expect(verifyClean(r)).toBe(false);
  });

  it('counts problems', () => {
    const r = report({
      ok: false,
      problems: [
        { code: 'hash-mismatch', message: 'x' },
        { code: 'chain-gap', message: 'y' },
      ],
    });
    expect(verifyHeadline(r)).toBe('2 problems found.');
    expect(verifyClean(r)).toBe(false);
  });

  it('names the exact line of a problem', () => {
    const file = `journal/ops/${DEV}.r_${'d'.repeat(16)}/000001.jsonl`;
    expect(problemText({ code: 'hash-mismatch', file, line: 2 })).toBe(
      `Line 2 of ${file} was edited.`,
    );
    expect(problemText({ code: 'segment-missing', file })).toBe(
      `${file} is missing: a whole file of entries was removed.`,
    );
    expect(problemText({ code: 'unsigned' })).toBe('An entry is not signed.');
  });
});

describe('flatten', () => {
  it('turns bridge and handler failures into one shape', () => {
    expect(flatten({ ok: false, error: 'No bridge' })).toEqual({ ok: false, error: 'No bridge' });
    expect(
      flatten({ ok: true, value: { ok: false, error: 'Not yet', code: 'not-implemented' } }),
    ).toEqual({ ok: false, error: 'Not yet', code: 'not-implemented' });
    expect(flatten({ ok: true, value: { ok: true, n: 1 } })).toEqual({
      ok: true,
      value: { ok: true, n: 1 },
    });
  });
});
