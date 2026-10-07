import { describe, expect, it } from 'vitest';
import { kindGroups, passphraseProblem } from './model';
import { agoMinutes, teamUi } from './store';

describe('team dialogs model', () => {
  it('groups op kinds for the import preview', () => {
    expect(
      kindGroups({
        'issue.patch': 3,
        'issue.create': 1,
        'comment.add': 2,
        'approval.add': 1,
        'blob.add': 4,
        'member.add': 1,
        'exchange.import': 1,
      }),
    ).toEqual([
      ['team.kind.issue', 4],
      ['team.kind.comment', 2],
      ['team.kind.approval', 1],
      ['team.kind.blob', 4],
      ['team.kind.team', 1],
      ['team.kind.other', 1],
    ]);
  });

  it('asks for a passphrase of 8 characters, typed twice', () => {
    expect(passphraseProblem(false, '', '')).toBeNull();
    expect(passphraseProblem(true, 'short', 'short')).toBe('Use at least 8 characters.');
    expect(passphraseProblem(true, 'long enough', 'long enougj')).toBe(
      'The two passphrases differ.',
    );
    expect(passphraseProblem(true, 'long enough', 'long enough')).toBeNull();
  });

  it('says how many minutes ago the last sync was', () => {
    const now = Date.parse('2026-10-07T10:00:00.000Z');
    expect(agoMinutes(undefined, now)).toBeNull();
    expect(agoMinutes('2026-10-07T09:59:30.000Z', now)).toBe(0);
    expect(agoMinutes('2026-10-07T09:47:00.000Z', now)).toBe(13);
  });

  it('opens one team dialog at a time', () => {
    teamUi.getState().open('export');
    teamUi.getState().open('import');
    expect(teamUi.getState().dialog).toBe('import');
    teamUi.getState().close();
    expect(teamUi.getState().dialog).toBeNull();
  });
});
