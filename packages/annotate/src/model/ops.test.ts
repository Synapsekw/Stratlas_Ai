import { describe, expect, it } from 'vitest';
import { LATER, NOW, ctx, makeIssue, meshSighting, photoSighting, videoSighting } from '../testing';
import {
  addSighting,
  canTransition,
  createIssue,
  mergeIssues,
  moveSighting,
  nextStatus,
  removeSighting,
  setStatus,
  updateIssue,
  validateIssue,
} from './ops';

describe('createIssue', () => {
  it('creates a draft issue from a sighting with the next code', () => {
    const r = createIssue(
      [makeIssue({ code: 'F01' }), makeIssue({ id: 'i2', code: 'F07' })],
      { sighting: photoSighting, classId: 'blister', severity: 3, author: 'DR', now: NOW, id: 'n' },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      id: 'n',
      code: 'F08',
      status: 'draft',
      classId: 'blister',
      severityModelId: 'tank-1-5',
      severity: 3,
      title: 'Coating blister',
      source: 'human',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(r.value.sightings).toEqual([photoSighting]);
  });

  it('takes the severity model from the class', () => {
    const r = createIssue(
      [],
      { sighting: meshSighting, classId: 'pothole', severity: 2, author: 'DR', now: NOW },
      ctx,
    );
    expect(r.ok && r.value.severityModelId).toBe('road-3');
  });

  it('rejects a severity that is not in the model', () => {
    const r = createIssue(
      [],
      { sighting: meshSighting, classId: 'pothole', severity: 5, author: 'DR', now: NOW },
      ctx,
    );
    expect(r).toEqual({
      ok: false,
      error: 'Issue F01: severity 5 is not in model "Road distress"',
    });
  });

  it('rejects uncertain when the model has no uncertain level', () => {
    const r = createIssue(
      [],
      { sighting: meshSighting, classId: 'pothole', severity: 'uncertain', author: 'DR', now: NOW },
      ctx,
    );
    expect(r.ok).toBe(false);
  });

  it('uses a custom prefix and source', () => {
    const r = createIssue(
      [makeIssue({ code: 'D03' })],
      {
        sighting: meshSighting,
        classId: 'crack',
        severity: 'uncertain',
        author: 'agent',
        now: NOW,
        prefix: 'D',
        source: 'agent',
      },
      ctx,
    );
    expect(r.ok && r.value.code).toBe('D04');
    expect(r.ok && r.value.source).toBe('agent');
  });

  it('rejects an unknown class', () => {
    const r = createIssue(
      [],
      { sighting: meshSighting, classId: 'nope', severity: 3, author: 'DR', now: NOW },
      ctx,
    );
    expect(r).toEqual({ ok: false, error: 'Class "nope" is not in any class catalogue' });
  });
});

describe('validateIssue', () => {
  it('accepts a valid issue', () => {
    expect(validateIssue(makeIssue(), ctx).ok).toBe(true);
  });

  it('rejects a missing severity model', () => {
    const r = validateIssue(makeIssue({ severityModelId: 'gone' }), ctx);
    expect(r).toEqual({
      ok: false,
      error: 'Issue F01: severity model "gone" is not in the project',
    });
  });

  it('rejects a schema violation with a readable message', () => {
    const r = validateIssue(makeIssue({ code: 'bad' }), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Issue code must look like F01');
  });
});

describe('sightings', () => {
  it('adds a sighting and touches updatedAt', () => {
    const next = addSighting(makeIssue(), videoSighting, LATER);
    expect(next.sightings).toHaveLength(2);
    expect(next.updatedAt).toBe(LATER);
  });

  it('removes a sighting but never the last one', () => {
    const two = addSighting(makeIssue(), photoSighting, NOW);
    const r = removeSighting(two, 0, LATER);
    expect(r.ok && r.value.sightings).toEqual([photoSighting]);
    const last = removeSighting(makeIssue(), 0, LATER);
    expect(last).toEqual({
      ok: false,
      error: 'Issue F01 needs at least one sighting; delete the issue instead',
    });
  });

  it('rejects an index out of range', () => {
    expect(removeSighting(makeIssue(), 3, LATER).ok).toBe(false);
  });

  it('moves a sighting to another issue (link across datasets)', () => {
    const a = addSighting(makeIssue({ id: 'a' }), photoSighting, NOW);
    const b = makeIssue({ id: 'b', code: 'F02' });
    const r = moveSighting(a, 1, b, LATER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.from?.sightings).toEqual([meshSighting]);
    expect(r.value.to.sightings).toEqual([meshSighting, photoSighting]);
  });

  it('moving the last sighting empties the source issue', () => {
    const a = makeIssue({ id: 'a', sightings: [photoSighting] });
    const b = makeIssue({ id: 'b', code: 'F02' });
    const r = moveSighting(a, 0, b, LATER);
    expect(r.ok && r.value.from).toBeNull();
  });

  it('merges all sightings of one issue into another', () => {
    const a = makeIssue({ id: 'a' });
    const b = makeIssue({ id: 'b', code: 'F02', sightings: [photoSighting, videoSighting] });
    const merged = mergeIssues(a, b, LATER);
    expect(merged.sightings).toEqual([meshSighting, photoSighting, videoSighting]);
    expect(merged.note).toContain('Merged F02');
  });
});

describe('status workflow', () => {
  it('moves forward one step at a time', () => {
    expect(canTransition('draft', 'reviewed')).toBe(true);
    expect(canTransition('reviewed', 'approved')).toBe(true);
    expect(canTransition('approved', 'closed')).toBe(true);
    expect(canTransition('draft', 'approved')).toBe(false);
    expect(canTransition('draft', 'closed')).toBe(false);
  });

  it('can step back one level to reopen', () => {
    expect(canTransition('closed', 'approved')).toBe(true);
    expect(canTransition('reviewed', 'draft')).toBe(true);
    expect(canTransition('closed', 'draft')).toBe(false);
  });

  it('names the next status', () => {
    expect(nextStatus('draft')).toBe('reviewed');
    expect(nextStatus('closed')).toBeNull();
  });

  it('sets a status or explains why not', () => {
    const r = setStatus(makeIssue(), 'reviewed', LATER);
    expect(r.ok && r.value.status).toBe('reviewed');
    expect(setStatus(makeIssue(), 'closed', LATER)).toEqual({
      ok: false,
      error: 'Issue F01 cannot go from draft to closed',
    });
  });
});

describe('updateIssue', () => {
  it('changes class and follows its severity model', () => {
    const r = updateIssue(makeIssue(), { classId: 'pothole', severity: 3 }, LATER, ctx);
    expect(r.ok && r.value.severityModelId).toBe('road-3');
    expect(r.ok && r.value.updatedAt).toBe(LATER);
  });

  it('validates the change', () => {
    const r = updateIssue(makeIssue(), { classId: 'pothole' }, LATER, ctx);
    expect(r.ok).toBe(false);
  });

  it('edits title and note', () => {
    const r = updateIssue(makeIssue(), { title: 'New', note: 'n' }, LATER, ctx);
    expect(r.ok && r.value.title).toBe('New');
    expect(r.ok && r.value.note).toBe('n');
  });
});
