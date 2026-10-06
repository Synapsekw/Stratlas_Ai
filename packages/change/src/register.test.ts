import { ChangeSet, type ChangeItem } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildChangeSet,
  changeStats,
  mergeReviews,
  registerRows,
  reviewItem,
  summarize,
} from './register';

const fixture = ChangeSet.parse(
  JSON.parse(
    readFileSync(
      new URL('../../schema/src/__fixtures__/change/issues.json', import.meta.url),
      'utf8',
    ),
  ),
);

describe('change sets across recomputes', () => {
  it('keeps every review byte for byte on a recompute with the same item ids', () => {
    const recomputed = buildChangeSet({
      id: fixture.id,
      from: fixture.from,
      to: fixture.to,
      producer: fixture.producer,
      createdAt: '2026-10-07T08:00:00Z',
      items: fixture.items.map((i) => {
        const rest: ChangeItem = { ...i };
        delete rest.review;
        return rest;
      }),
    });
    const merged = mergeReviews(fixture, recomputed);
    const before = fixture.items.find((i) => i.id === 'issue:F01')?.review;
    const after = merged.items.find((i) => i.id === 'issue:F01')?.review;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(merged.createdAt).toBe('2026-10-07T08:00:00Z');
    expect(merged.stats).toMatchObject({ items: 4, open: 3, grown: 1 });
    expect(ChangeSet.safeParse(merged).success).toBe(true);
  });

  it('drops the review of an item that is gone', () => {
    const next = buildChangeSet({
      id: fixture.id,
      from: 'c1',
      to: 'c2',
      producer: 'issues',
      createdAt: '2026-10-07T08:00:00Z',
      items: [{ kind: 'issue', id: 'issue:F09', verdict: 'new' }],
    });
    expect(mergeReviews(fixture, next).items).toEqual([
      { kind: 'issue', id: 'issue:F09', verdict: 'new' },
    ]);
  });

  it('sets and clears a review and counts the open items', () => {
    const r = { status: 'dismissed' as const, by: 'me', at: '2026-10-06T10:00:00Z' };
    const s = reviewItem(fixture, 'issue:F03', r);
    expect(s.items.find((i) => i.id === 'issue:F03')?.review).toEqual(r);
    expect(changeStats(s.items).open).toBe(2);
    const cleared = reviewItem(s, 'issue:F03', null);
    expect(cleared.items.find((i) => i.id === 'issue:F03')).not.toHaveProperty('review');
    expect(summarize(cleared)).toMatchObject({ id: 'c1-c2-issues', items: 4, open: 3 });
    expect(() => reviewItem(fixture, 'nope', r)).toThrow(/no item/);
  });
});

describe('the register', () => {
  it('sorts what appeared first and filters by kind, verdict, status and text', () => {
    const rows = registerRows([fixture]);
    expect(rows.map((r) => r.item.verdict)).toEqual(['new', 'grown', 'resolved', 'not-seen']);
    expect(registerRows([fixture], { status: ['confirmed'] }).map((r) => r.item.id)).toEqual([
      'issue:F01',
    ]);
    expect(registerRows([fixture], { verdicts: ['resolved', 'not-seen'] })).toHaveLength(2);
    expect(registerRows([fixture], { kinds: ['vector'] })).toHaveLength(0);
    expect(registerRows([fixture], { text: 'coating' }).map((r) => r.item.id)).toEqual([
      'issue:F01',
      'issue:F02',
    ]);
    expect(registerRows([fixture], {}, 'label').map((r) => r.item.id)).toEqual([
      'issue:F01',
      'issue:F02',
      'issue:F03',
      'issue:F04',
    ]);
  });
});
