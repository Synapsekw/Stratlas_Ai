import { describe, expect, it } from 'vitest';
import {
  extractNowSection,
  formatWorktrees,
  frontmatterValue,
  isLinkedWorktreeGitDir,
  newestNoteNames,
  noteTitle,
  parseAheadBehind,
  parsePorcelainZ,
  parseWorktrees,
} from './session-context.mjs';

const NORTH_STAR = [
  '---',
  'title: North star',
  'last-updated: 2026-10-10',
  '---',
  '',
  '# North star',
  '',
  '## 2. Where we are',
  '',
  '- old',
  '',
  '## 3. Now',
  '',
  '- **Phase**: M11',
  '- **Branch**: feat/x',
  '',
  '### Detail',
  '- more',
  '',
  '## 4. Later',
  '- not this',
].join('\r\n');

describe('extractNowSection', () => {
  it('returns the section 3 body up to the next ## heading, CRLF-safe', () => {
    expect(extractNowSection(NORTH_STAR)).toEqual([
      '- **Phase**: M11',
      '- **Branch**: feat/x',
      '',
      '### Detail',
      '- more',
    ]);
  });

  it('runs to the end when section 3 is last', () => {
    expect(extractNowSection('## 3 Now\n- a\n- b\n')).toEqual(['- a', '- b']);
  });

  it('returns null without a section 3 and ignores ## 30', () => {
    expect(extractNowSection('## 2. x\n- a')).toBeNull();
    expect(extractNowSection('## 30. x\n- a')).toBeNull();
  });
});

describe('frontmatterValue and noteTitle', () => {
  it('reads frontmatter scalars only inside the frontmatter', () => {
    expect(frontmatterValue(NORTH_STAR, 'last-updated')).toBe('2026-10-10');
    expect(frontmatterValue('last-updated: 2026-01-01\n', 'last-updated')).toBeNull();
    expect(frontmatterValue('---\ntitle: "Quoted"\n---\n', 'title')).toBe('Quoted');
  });

  it('prefers a frontmatter title, then the first # heading, then the fallback', () => {
    expect(noteTitle('---\ntitle: T\n---\n# H\n', 'f')).toBe('T');
    expect(noteTitle('intro\n## sub\n# Heading here\n', 'f')).toBe('Heading here');
    expect(noteTitle('no heading', 'f.md')).toBe('f.md');
  });
});

describe('newestNoteNames', () => {
  it('keeps dated notes, newest first, skipping drafts and other files', () => {
    expect(
      newestNoteNames([
        '2026-10-08-0900-a.md',
        '_draft-2026-10-10-1200.md',
        'README.md',
        '2026-10-10-0815-c.md',
        '2026-10-09-2300-b.md',
        '2026-10-01-0100-old.md',
      ]),
    ).toEqual(['2026-10-10-0815-c.md', '2026-10-09-2300-b.md', '2026-10-08-0900-a.md']);
  });
});

describe('isLinkedWorktreeGitDir', () => {
  it('detects a linked worktree git-dir on either separator', () => {
    expect(isLinkedWorktreeGitDir('E:/Dev/AIO Software/.git/worktrees/agent-workflow')).toBe(true);
    expect(isLinkedWorktreeGitDir('E:\\Dev\\AIO Software\\.git\\worktrees\\x')).toBe(true);
  });

  it('does not flag the main checkout', () => {
    expect(isLinkedWorktreeGitDir('.git')).toBe(false);
    expect(isLinkedWorktreeGitDir('E:/Dev/AIO Software/.git')).toBe(false);
    expect(isLinkedWorktreeGitDir('E:/worktrees/repo/.git')).toBe(false);
  });
});

describe('parsePorcelainZ', () => {
  it('lists paths, skips rename sources and normalises separators', () => {
    const z = [' M a/b.ts', 'R  new.ts', 'old.ts', '?? dir with space/', ''].join('\0');
    expect(parsePorcelainZ(z)).toEqual(['a/b.ts', 'new.ts', 'dir with space/']);
    expect(parsePorcelainZ('')).toEqual([]);
  });
});

describe('worktrees', () => {
  const porcelain = [
    'worktree E:/Dev/AIO Software',
    'HEAD 1',
    'branch refs/heads/main',
    '',
    'worktree E:/Dev/AIO Software/.claude/worktrees/one',
    'HEAD 2',
    'branch refs/heads/feat/one',
    '',
    'worktree C:/tmp/other',
    'HEAD 3',
    'detached',
    '',
  ].join('\n');

  it('parses paths and branches', () => {
    expect(parseWorktrees(porcelain)).toEqual([
      { path: 'E:/Dev/AIO Software', branch: 'main' },
      { path: 'E:/Dev/AIO Software/.claude/worktrees/one', branch: 'feat/one' },
      { path: 'C:/tmp/other', branch: '(detached)' },
    ]);
  });

  it('puts the current worktree first, starred, and caps the list', () => {
    const lines = formatWorktrees(
      parseWorktrees(porcelain),
      'e:\\Dev\\AIO Software\\.claude\\worktrees\\one',
      2,
    );
    expect(lines).toEqual([
      '  * one  [feat/one]',
      '    (main checkout)  [main]',
      '    +1 more (git worktree list)',
    ]);
  });
});

describe('parseAheadBehind', () => {
  it('reads left (behind) and right (ahead) counts', () => {
    expect(parseAheadBehind('3\t5\n')).toEqual({ behind: 3, ahead: 5 });
    expect(parseAheadBehind(null)).toBeNull();
  });
});
