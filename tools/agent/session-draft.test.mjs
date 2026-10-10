import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildDraftFilename,
  countToolCalls,
  countToolCallsFromTranscript,
  filterRelevantPaths,
  hasRecentDraft,
  needsNorthStarBumpWarning,
  noteStamp,
  renderDraft,
  shouldDraftSession,
} from './session-draft.mjs';

const dir = mkdtempSync(join(tmpdir(), 'session-draft-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('shouldDraftSession', () => {
  it('drafts at 10 changed files or 20 tool calls', () => {
    expect(shouldDraftSession({ changedFiles: 10, toolCalls: 0 })).toBe(true);
    expect(shouldDraftSession({ changedFiles: 0, toolCalls: 20 })).toBe(true);
    expect(shouldDraftSession({ changedFiles: 9, toolCalls: 19 })).toBe(false);
  });
});

describe('countToolCalls', () => {
  it('counts tool_use blocks in assistant messages only, tolerating bad lines', () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text' }, { type: 'tool_use' }, { type: 'tool_use' }] },
      }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_use' }] } }),
      '{not json "tool_use"',
      JSON.stringify({ type: 'assistant', message: { content: 'plain "tool_use"' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }),
    ].join('\r\n');
    expect(countToolCalls(jsonl)).toBe(3);
    expect(countToolCalls('')).toBe(0);
  });

  it('reads a transcript file, 0 when missing, threshold when oversized', () => {
    const path = join(dir, 't.jsonl');
    writeFileSync(
      path,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }) + '\n',
    );
    expect(countToolCallsFromTranscript(path)).toBe(1);
    expect(countToolCallsFromTranscript(undefined)).toBe(0);
    expect(countToolCallsFromTranscript(join(dir, 'missing.jsonl'))).toBe(0);
    expect(countToolCallsFromTranscript(path, 1)).toBe(20);
  });
});

describe('filterRelevantPaths', () => {
  it('drops only docs/sessions draft stubs and normalises separators', () => {
    expect(
      filterRelevantPaths([
        'docs/sessions/_draft-2026-10-10-0900.md',
        'docs\\sessions\\_draft-2026-10-10-0901.md',
        'docs/sessions/2026-10-10-0900-real.md',
        'docs/_draft-other.md',
        'apps\\desktop\\x.ts',
      ]),
    ).toEqual([
      'docs/sessions/2026-10-10-0900-real.md',
      'docs/_draft-other.md',
      'apps/desktop/x.ts',
    ]);
  });
});

describe('needsNorthStarBumpWarning', () => {
  it('warns when a plan or ADR changed without the north-star', () => {
    expect(needsNorthStarBumpWarning(['docs/plans/m11.md'])).toBe(true);
    expect(needsNorthStarBumpWarning(['docs\\architecture\\adr\\0007-x.md'])).toBe(true);
  });

  it('stays quiet when the north-star changed too, or nothing relevant changed', () => {
    expect(needsNorthStarBumpWarning(['docs/plans/m11.md', 'docs/NORTH-STAR.md'])).toBe(false);
    expect(needsNorthStarBumpWarning(['docs/architecture/SPEC.md', 'src/x.ts'])).toBe(false);
    expect(needsNorthStarBumpWarning([])).toBe(false);
  });
});

describe('draft names', () => {
  it('uses a zero-padded local YYYY-MM-DD-HHmm stamp', () => {
    const date = new Date(2026, 0, 5, 9, 5);
    expect(noteStamp(date)).toBe('2026-01-05-0905');
    expect(buildDraftFilename(date)).toBe('docs/sessions/_draft-2026-01-05-0905.md');
  });
});

describe('hasRecentDraft', () => {
  it('sees drafts touched in the last two hours only', () => {
    const missing = join(dir, 'missing');
    expect(hasRecentDraft(missing)).toBe(false);
    const now = Date.now();
    writeFileSync(join(dir, 'unrelated.md'), '');
    expect(hasRecentDraft(dir, now)).toBe(false);
    const draft = join(dir, '_draft-2026-10-10-0900.md');
    writeFileSync(draft, '');
    expect(hasRecentDraft(dir, now)).toBe(true);
    const old = (now - 3 * 60 * 60 * 1000) / 1000;
    utimesSync(draft, old, old);
    expect(hasRecentDraft(dir, now)).toBe(false);
  });
});

describe('renderDraft', () => {
  const base = { stamp: '2026-10-10-1430', branch: 'feat/x', toolCalls: 25 };

  it('holds branch, paths, counts and commit subjects only', () => {
    const text = renderDraft({
      ...base,
      changedPaths: ['a.ts', 'docs/plans/p.md'],
      commits: ['abc1234 feat: thing'],
    });
    expect(text).toContain('date: 2026-10-10-1430');
    expect(text).toContain('branch: feat/x');
    expect(text).toContain('2 changed path(s) and 25 tool call(s)');
    expect(text).toContain('- `docs/plans/p.md`');
    expect(text).toContain('- abc1234 feat: thing');
    expect(text.startsWith('---\ntype: session\n')).toBe(true);
  });

  it('marks empty lists and caps a long path list', () => {
    const empty = renderDraft({ ...base, changedPaths: [], commits: [] });
    expect(empty.match(/- \(none\)/g)).toHaveLength(2);
    const many = Array.from({ length: 45 }, (_, i) => `f${i}.ts`);
    const text = renderDraft({ ...base, changedPaths: many, commits: [] });
    expect(text).toContain('- `f39.ts`');
    expect(text).not.toContain('- `f40.ts`');
    expect(text).toContain('- (+5 more)');
  });
});
