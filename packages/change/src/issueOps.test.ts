import { Issue as IssueSchema } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { canMakeIssue, closeResolved, draftFromChange, trackPair } from './issueOps';
import { issue, SITE } from './testing';

const NOW = '2026-10-06T12:00:00Z';

describe('a person confirms a change', () => {
  it('closes a confirmed resolved issue on the later date, and only then', () => {
    const i = issue({ code: 'F02', layer: 'model-d1', at: [10, 0, 0] });
    const closed = closeResolved(i, 'd2', NOW);
    expect(closed).toMatchObject({ status: 'closed', resolvedIn: 'd2', updatedAt: NOW });
    expect(IssueSchema.safeParse(closed).success).toBe(true);
    expect(i.status).toBe('reviewed');
  });

  it('gives a confirmed match one track and each issue its date', () => {
    const a = issue({ code: 'F01', layer: 'model-d1', at: [0, 0, 0] });
    const b = issue({ code: 'F11', layer: 'model-d2', at: [0, 0, 0] });
    const r = trackPair(a, b, { from: 'd1', to: 'd2' }, NOW, () => 'track-1');
    expect(r.track).toBe('track-1');
    expect(r.earlier).toMatchObject({ track: 'track-1', capture: 'd1' });
    expect(r.later).toMatchObject({ track: 'track-1', capture: 'd2' });
    // an existing track is kept
    const again = trackPair({ ...a, track: 't0' }, b, { from: 'd1', to: 'd2' }, NOW, () => 'x');
    expect(again.track).toBe('t0');
  });
});

describe('make an issue from a change', () => {
  const ctx = {
    set: { from: 'd1', to: 'd2' },
    manifest: SITE,
    existingCodes: ['F01', 'F02'],
    author: 'tester',
    now: NOW,
    id: 'new-issue',
  };

  it('is offered for things on the later date without an issue', () => {
    expect(canMakeIssue({ kind: 'vector', id: 'v', verdict: 'added' })).toBe(true);
    expect(canMakeIssue({ kind: 'vector', id: 'v', verdict: 'removed' })).toBe(false);
    expect(canMakeIssue({ kind: 'issue', id: 'i', verdict: 'new' })).toBe(false);
    expect(
      canMakeIssue({
        kind: 'vector',
        id: 'v',
        verdict: 'added',
        review: { status: 'confirmed', by: 'x', at: NOW, issueId: 'i1' },
      }),
    ).toBe(false);
  });

  it('drafts a map issue on the later date for a vector change', () => {
    const r = draftFromChange(
      { kind: 'vector', id: 'v', verdict: 'added', layerTo: 'tracks-d2', label: 'New track added' },
      {
        ...ctx,
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [0.001, 0],
          ],
        },
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.issue).toMatchObject({
      code: 'F03',
      status: 'draft',
      capture: 'd2',
      track: 'new-issue',
      title: 'New track added',
      classId: 'corrosion',
      severity: 1,
      sightings: [{ on: 'map', layer: 'tracks-d2' }],
    });
    expect(IssueSchema.safeParse(r.issue).success).toBe(true);
  });

  it('places a detection change on a later photo and a region on the later model', () => {
    const d = draftFromChange(
      { kind: 'detection', id: 'd', verdict: 'new', classId: 'coating' },
      {
        ...ctx,
        detection: {
          layer: 'photos-d2',
          photo: 'photos-d2-0',
          geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 },
        },
      },
    );
    expect(d.ok && d.issue.sightings[0]).toMatchObject({ on: 'image', photo: 'photos-d2-0' });
    expect(d.ok && d.issue.classId).toBe('coating');
    const g = draftFromChange(
      { kind: 'region', id: 'r', verdict: 'added', at: [1, 2, 3] },
      { ...ctx, meshLayer: 'model-d2' },
    );
    expect(g.ok && g.issue.sightings[0]).toMatchObject({ on: 'mesh', layer: 'model-d2' });
    const none = draftFromChange({ kind: 'region', id: 'r', verdict: 'added' }, ctx);
    expect(none).toEqual({
      ok: false,
      error: 'This change has no place on the later date to put an issue.',
    });
  });
});
