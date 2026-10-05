import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFeed, platformOf } from './feed.mjs';
import {
  groupCommits,
  parseCommit,
  previousTag,
  readCommits,
  releaseNotes,
  renderNotes,
} from './notes.mjs';

describe('conventional commits', () => {
  it('parses type, scope and the breaking mark', () => {
    expect(parseCommit('feat(desktop): compare two dates')).toEqual({
      type: 'feat',
      scope: 'desktop',
      text: 'compare two dates',
      breaking: false,
    });
    expect(parseCommit('fix!: drop the old feed')?.breaking).toBe(true);
    expect(parseCommit('refactor: x', 'BREAKING CHANGE: settings moved')?.breaking).toBe(true);
    expect(parseCommit('Merge branch main')).toBeNull();
  });

  it('keeps features, fixes and speed-ups, without duplicates or chores', () => {
    const g = groupCommits([
      { subject: 'feat(ui): dark street maps' },
      { subject: 'fix(desktop): the split pane is dark' },
      { subject: 'fix(maps): the split pane is dark' },
      { subject: 'perf(engine): fewer draw calls' },
      { subject: 'docs: testing stage' },
      { subject: 'chore: merge main' },
      { subject: 'test(desktop): e2e' },
      { subject: 'feat!: projects open read-only' },
    ]);
    expect(g).toEqual({
      breaking: ['Projects open read-only'],
      feat: ['Dark street maps'],
      fix: ['The split pane is dark'],
      perf: ['Fewer draw calls'],
    });
  });

  it('renders Markdown groups and caps long lists', () => {
    const md = renderNotes({
      version: '0.7.0',
      date: '2026-10-05',
      commits: [
        ...Array.from({ length: 5 }, (_, i) => ({ subject: `fix: thing ${String(i)}` })),
        { subject: 'feat: updates from a feed' },
      ],
      limit: 3,
    });
    expect(md).toBe(
      [
        '# Stratlas 0.7.0',
        '',
        '2026-10-05',
        '',
        '## New',
        '',
        '- Updates from a feed',
        '',
        '## Fixed',
        '',
        '- Thing 0',
        '- Thing 1',
        '- Thing 2',
        '- and 2 more',
        '',
      ].join('\n'),
    );
    expect(renderNotes({ version: '1.0.1', commits: [{ subject: 'chore: bump' }] })).toContain(
      'no user-visible changes',
    );
  });
});

describe('notes between tags', () => {
  let repo;
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
  const commit = (subject) => git('commit', '--allow-empty', '-q', '--no-verify', '-m', subject);

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'notes-'));
    git('init', '-q');
    mkdirSync(join(repo, 'apps/desktop'), { recursive: true });
    mkdirSync(join(repo, 'packages/brand'), { recursive: true });
    writeFileSync(join(repo, 'apps/desktop/package.json'), '{"version":"0.8.0"}');
    writeFileSync(join(repo, 'packages/brand/brand.json'), '{"productName":"Stratlas"}');
    commit('feat: first feature');
    git('tag', 'v0.7.0');
    commit('fix: after the tag');
    git('tag', 'm1-not-a-release');
    commit('feat: second feature');
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('starts at the previous v-tag and ignores other tags', () => {
    expect(previousTag('HEAD', repo)).toBe('v0.7.0');
    expect(readCommits('v0.7.0', 'HEAD', repo).map((c) => c.subject)).toEqual([
      'feat: second feature',
      'fix: after the tag',
    ]);
    const n = releaseNotes({ cwd: repo, date: '2026-11-01' });
    expect(n.version).toBe('0.8.0');
    expect(n.from).toBe('v0.7.0');
    expect(n.markdown).toContain('- Second feature');
    expect(n.markdown).toContain('- After the tag');
    expect(n.markdown).not.toContain('First feature');
  });

  it('lists the whole history when there is no earlier release', () => {
    git('tag', '-d', 'v0.7.0');
    expect(releaseNotes({ cwd: repo }).markdown).toContain('- First feature');
  });
});

describe('update feed', () => {
  let dist;
  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'feed-'));
  });
  afterEach(() => {
    rmSync(dist, { recursive: true, force: true });
  });

  it('maps installer names to platforms', () => {
    expect(platformOf('Stratlas-0.7.0-win-x64-setup.exe', '0.7.0')).toBe('win-x64');
    expect(platformOf('Stratlas-0.7.0-mac-arm64.dmg', '0.7.0')).toBe('mac-arm64');
    expect(platformOf('Stratlas-0.7.0-win-x64-portable.exe', '0.7.0')).toBeNull();
    expect(platformOf('Stratlas-0.6.0-win-x64-setup.exe', '0.7.0')).toBeNull();
    expect(platformOf('Stratlas-0.7.0-win-x64-setup.exe.blockmap', '0.7.0')).toBeNull();
  });

  it('hashes installers and merges a feed of the same version', async () => {
    writeFileSync(join(dist, 'Stratlas-0.7.0-win-x64-setup.exe'), 'abc');
    const feed = await buildFeed({
      dist,
      version: '0.7.0',
      notes: '# Stratlas 0.7.0\n',
      previous: {
        version: '0.7.0',
        files: { 'mac-arm64': { url: 'm.dmg', sha256: 'f'.repeat(64), size: 1 } },
      },
      now: new Date('2026-10-05T10:00:00Z'),
    });
    expect(feed).toEqual({
      schema: 'aio.update-feed/1',
      version: '0.7.0',
      releasedAt: '2026-10-05',
      notes: '# Stratlas 0.7.0\n',
      files: {
        'mac-arm64': { url: 'm.dmg', sha256: 'f'.repeat(64), size: 1 },
        'win-x64': {
          url: 'Stratlas-0.7.0-win-x64-setup.exe',
          sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
          size: 3,
        },
      },
    });
    const based = await buildFeed({ dist, version: '0.7.0', baseUrl: 'https://u.example.com/s/' });
    expect(based.files['win-x64']?.url).toBe(
      'https://u.example.com/s/Stratlas-0.7.0-win-x64-setup.exe',
    );
  });
});
