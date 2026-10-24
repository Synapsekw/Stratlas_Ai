import { describe, expect, it } from 'vitest';
import {
  decide,
  hasMarker,
  inMainCheckout,
  normalizePath,
  splitCommands,
  stripHeredocs,
} from './merge-guard-hook.mjs';

const mainRoot = 'E:\\Dev\\AIO Software';
const worktree = 'E:\\Dev\\AIO Software\\.claude\\worktrees\\map-legend';
const coordinator = { name: 'aio-software-f2', since: '2026-10-24T12:06', raw: '' };

/** decide() from a worktree on a feature branch, or from the main checkout on main. */
const fromWorktree = (command, coord = coordinator) =>
  decide({
    command,
    cwd: worktree,
    mainRoot,
    currentBranch: 'feat/map-legend',
    coordinator: coord,
  });
const fromMain = (command, coord = coordinator) =>
  decide({ command, cwd: mainRoot, mainRoot, currentBranch: 'main', coordinator: coord });

describe('splitCommands', () => {
  it('splits on separators outside quotes and keeps quoted text in its word', () => {
    expect(
      splitCommands('cd "/e/Dev/AIO Software" && git merge --ff-only feat/x; echo ok'),
    ).toEqual([
      ['cd', '/e/Dev/AIO Software'],
      ['git', 'merge', '--ff-only', 'feat/x'],
      ['echo', 'ok'],
    ]);
    expect(splitCommands(`git commit -m "fix: a; b && git push"`)).toEqual([
      ['git', 'commit', '-m', 'fix: a; b && git push'],
    ]);
    expect(splitCommands(`echo 'it''s'`)).toEqual([['echo', "it's"]]);
  });

  it('drops heredoc and here-string bodies', () => {
    const bash = `git commit -F - <<'EOF'\nfix: no git push here\nEOF\ngit log`;
    expect(stripHeredocs(bash)).toBe(`git commit -F - <<'EOF'\ngit log`);
    const ps = `git commit -m @'\nfix: don't git push\n'@\ngit status`;
    expect(splitCommands(ps)).toEqual([
      ['git', 'commit', '-m', ''],
      ['git', 'status'],
    ]);
  });
});

describe('paths', () => {
  it('normalizes Windows, MSYS and forward-slash forms', () => {
    expect(normalizePath('E:\\Dev\\AIO Software\\')).toBe('e:/dev/aio software');
    expect(normalizePath('/e/Dev/AIO Software')).toBe('e:/dev/aio software');
    expect(normalizePath('E:/Dev/AIO Software')).toBe('e:/dev/aio software');
  });

  it('knows the main checkout from its worktrees', () => {
    expect(inMainCheckout('/e/dev/aio software', mainRoot)).toBe(true);
    expect(inMainCheckout('E:/Dev/AIO Software/apps/desktop', mainRoot)).toBe(true);
    expect(inMainCheckout(worktree, mainRoot)).toBe(false);
    expect(inMainCheckout('E:/Dev/AIO Software-old', mainRoot)).toBe(false);
  });
});

describe('hasMarker', () => {
  it('sees the bash and PowerShell forms', () => {
    expect(hasMarker('QUADRION_ORCHESTRATOR=1 git push origin main')).toBe(true);
    expect(hasMarker("$env:QUADRION_ORCHESTRATOR='1'; git push origin main")).toBe(true);
    expect(hasMarker('$env:QUADRION_ORCHESTRATOR = "1"; git push')).toBe(true);
    expect(hasMarker('export QUADRION_ORCHESTRATOR=1; git push')).toBe(true);
    expect(hasMarker('QUADRION_ORCHESTRATOR=0 git push')).toBe(false);
    expect(hasMarker('QUADRION_ORCHESTRATOR=10 git push')).toBe(false);
    expect(hasMarker('git push')).toBe(false);
  });
});

describe('decide: pushes and pull requests', () => {
  it('denies pushes in any form, from anywhere', () => {
    for (const command of [
      'git push origin feat/x',
      'git push',
      'git -C "E:/Dev/AIO Software" push origin main',
      'git -c core.askPass=x push -u origin HEAD',
      'pnpm check && git push --force-with-lease',
      '& git.exe push origin feat/x',
      'FOO=1 git push',
    ]) {
      expect(fromWorktree(command), command).not.toBeNull();
    }
  });

  it('denies opening, readying and merging pull requests', () => {
    for (const command of [
      'gh pr create --draft --title x --body y',
      'gh pr merge 12 --squash',
      'gh pr ready 12',
      'gh -R org/repo pr create',
      'gh api -X PUT repos/o/r/pulls/12/merge',
      'gh api repos/o/r/merges -f base=main -f head=x',
    ]) {
      expect(fromWorktree(command), command).not.toBeNull();
    }
  });

  it('allows reading pull requests and CI', () => {
    for (const command of [
      'gh pr view 12',
      'gh pr list --state open',
      'gh pr checks 12',
      'gh run view 1 --log-failed',
      'gh api repos/o/r/pulls/12',
    ]) {
      expect(fromWorktree(command), command).toBeNull();
    }
  });

  it('names the coordinator, or says how to start one', () => {
    const withCoordinator = fromWorktree('git push origin feat/x');
    expect(withCoordinator?.reason).toContain('SendMessage to aio-software-f2');
    expect(withCoordinator?.reason).toContain('git rebase main');
    expect(withCoordinator?.message).toContain('aio-software-f2');
    const without = fromWorktree('git push origin feat/x', null);
    expect(without?.reason).toContain('run /coordinate');
    expect(without?.reason).toContain('No merge coordinator session is running');
    expect(without?.message).toContain('/coordinate');
  });
});

describe('decide: the coordinator marker', () => {
  it('lets the coordinator through while the lock exists', () => {
    expect(fromMain("$env:QUADRION_ORCHESTRATOR='1'; git push origin main")).toBeNull();
    expect(fromMain('QUADRION_ORCHESTRATOR=1 git merge --ff-only feat/x')).toBeNull();
    expect(fromWorktree('QUADRION_ORCHESTRATOR=1 gh pr create --draft')).toBeNull();
  });

  it('sends a marked command to /coordinate when there is no lock', () => {
    const verdict = fromMain('QUADRION_ORCHESTRATOR=1 git push origin main', null);
    expect(verdict?.reason).toContain('Run /coordinate first');
    expect(verdict?.message).toContain('/coordinate');
  });
});

describe('decide: moving main', () => {
  it('denies merges, pulls and hard resets in the main checkout', () => {
    for (const command of [
      'git merge --ff-only feat/x',
      'git pull --ff-only',
      'git reset --hard feat/x',
    ]) {
      expect(fromMain(command), command).not.toBeNull();
    }
  });

  it('denies changing into the main checkout first, in any spelling', () => {
    for (const command of [
      'cd "/e/Dev/AIO Software"; git merge --ff-only feat/x',
      'cd "E:\\Dev\\AIO Software" && git merge feat/x',
      "Set-Location 'E:/Dev/AIO Software'; git merge feat/x",
      'cd /E/dev/aio\\ software && git pull',
      'git -C "E:/Dev/AIO Software" merge --ff-only feat/x',
      'cd ../../.. && git merge feat/x',
    ]) {
      expect(fromWorktree(command), command).not.toBeNull();
    }
  });

  it('denies moving the main ref from anywhere', () => {
    for (const command of [
      'git update-ref refs/heads/main feat/x',
      'git branch -f main feat/x',
      'git fetch . feat/x:main',
    ]) {
      expect(fromWorktree(command), command).not.toBeNull();
    }
  });

  it('allows ordinary branch work', () => {
    for (const command of [
      'git merge main',
      'git merge --ff-only main',
      'git pull --rebase',
      'git rebase main',
      'git reset --hard HEAD~1',
      'git branch -f feat/y main',
      'git commit -m "docs: mention git push and gh pr create"',
      `git commit -m "$(cat <<'EOF'\nfix: no git push, gh pr merge here\n\nCo-Authored-By: x\nEOF\n)"`,
      'git fetch origin main',
      'cd "/e/Dev/AIO Software" && git log --oneline -3',
      'cd "/e/Dev/AIO Software/.claude/worktrees/map-legend" && git merge main',
      'cd "/e/Dev/AIO Software"; cd .claude/worktrees/map-legend; git merge main',
      'echo git push',
      'node tools/agent/finish-task.mjs',
    ]) {
      expect(fromWorktree(command), command).toBeNull();
    }
  });

  it('allows a merge abort and reading in the main checkout', () => {
    expect(fromMain('git merge --abort')).toBeNull();
    expect(fromMain('git status && git log -3')).toBeNull();
    expect(fromMain('git reset --soft HEAD~1')).toBeNull();
  });

  it('only treats the main checkout as main when main is checked out there', () => {
    const verdict = decide({
      command: 'git merge feat/x',
      cwd: mainRoot,
      mainRoot,
      currentBranch: 'feat/other',
      coordinator,
    });
    expect(verdict).toBeNull();
  });
});
