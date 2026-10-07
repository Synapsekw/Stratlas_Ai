import { DEFAULT_APPROVAL_POLICY, type ApprovalView, type CollabState } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  allowed,
  approveRefusal,
  approvingTools,
  assertAgentCannotApprove,
  mentionCandidates,
  mineKeys,
  myWork,
  parseMentions,
  projectCollab,
  renderLite,
  signOffBlock,
  threadOf,
  tokenize,
  visibleTo,
} from './index';
import { ACTORS, F03, F05, hashOf, hlc, op, PEOPLE } from './testing';

const { rana, omar, lina, cleo } = ACTORS;

describe('mentions', () => {
  it('finds full names, first names and initials, in any script, each person once', () => {
    const people = [...PEOPLE, { actor: `a_${'q'.repeat(26)}`, name: 'سارة مثال', initials: 'سم' }];
    expect(parseMentions('@Omar please check the weld, @omar again', people)).toEqual([omar]);
    expect(parseMentions('Ask @Lina Test and @RE', people)).toEqual([lina, rana]);
    expect(parseMentions('شكرا @سارة', people)).toEqual([`a_${'q'.repeat(26)}`]);
    expect(parseMentions('@Omarx and rana@example.com', people)).toEqual([]);
  });

  it('a first name two people share names neither', () => {
    const twins = [
      { actor: omar, name: 'Omar Sample', initials: 'OS' },
      { actor: lina, name: 'Omar Test', initials: 'OT' },
    ];
    expect(parseMentions('@Omar', twins)).toEqual([]);
    expect(parseMentions('@Omar Test', twins)).toEqual([lina]);
  });

  it('suggests people while typing', () => {
    expect(mentionCandidates('hello @Om', PEOPLE)?.people.map((p) => p.actor)).toEqual([omar]);
    expect(mentionCandidates('no mention', PEOPLE)).toBeNull();
  });
});

describe('roles and approve checks', () => {
  const policy = DEFAULT_APPROVAL_POLICY;
  const base = {
    decision: 'approve' as const,
    me: omar,
    role: 'reviewer' as const,
    shared: true,
    policy,
    target: { creator: rana, materialHash: hashOf('a') },
    mine: [] as ApprovalView[],
    status: 'reviewed',
  };

  it('viewers comment only when the policy says so', () => {
    expect(allowed('comment.team', 'viewer', policy)).toBe(false);
    expect(allowed('comment.team', 'viewer', { ...policy, viewersMayComment: true })).toBe(true);
    expect(allowed('approve', 'client', policy)).toBe(false);
    expect(allowed('accept', 'client', policy)).toBe(true);
  });

  it('refuses the agent, unshared projects, viewers, the creator and a second approval', () => {
    expect(approveRefusal(base)).toBeNull();
    expect(approveRefusal({ ...base, agent: true })).toBe('agent');
    expect(approveRefusal({ ...base, shared: false })).toBe('not-shared');
    expect(approveRefusal({ ...base, role: 'viewer' })).toBe('role');
    expect(approveRefusal({ ...base, me: rana, role: 'owner' })).toBe('four-eyes');
    expect(approveRefusal({ ...base, target: { ...base.target, lastEditor: omar } })).toBe(
      'four-eyes',
    );
    expect(approveRefusal({ ...base, status: 'draft' })).toBe('not-reviewed');
    const mine: ApprovalView = {
      id: 'ap_aaaaaaaaaaaaaaaa',
      target: F05,
      by: omar,
      decision: 'approve',
      contentHash: hashOf('a'),
      at: hlc(1),
      withdrawn: false,
      current: true,
    };
    expect(approveRefusal({ ...base, mine: [mine] })).toBe('already');
    expect(approveRefusal({ ...base, mine: [{ ...mine, contentHash: hashOf('b') }] })).toBeNull();
  });

  it('the creator may request changes; a client may accept, unless acceptance is off', () => {
    expect(
      approveRefusal({ ...base, me: rana, role: 'owner', decision: 'changes-requested' }),
    ).toBe(null);
    expect(approveRefusal({ ...base, me: cleo, role: 'client', decision: 'accept' })).toBeNull();
    expect(
      approveRefusal({
        ...base,
        me: cleo,
        role: 'client',
        decision: 'accept',
        policy: { ...policy, clientAcceptance: 'off' },
      }),
    ).toBe('acceptance-off');
    expect(approveRefusal({ ...base, me: cleo, role: 'client' })).toBe('role');
  });
});

describe('the agent never approves', () => {
  it('flags approving tool names and lets request_approval through', () => {
    expect(
      approvingTools(['list_my_work', 'add_comment', 'request_approval', 'show_thread']),
    ).toEqual([]);
    expect(
      approvingTools(['approve_issue', 'sign_off_report', 'accept', 'withdraw_approval']),
    ).toEqual(['approve_issue', 'sign_off_report', 'accept', 'withdraw_approval']);
    expect(() => {
      assertAgentCannotApprove(['approve']);
    }).toThrow(/never approve/);
  });
});

describe('my work, visibility and threads', () => {
  const share = op('project.share', rana, 0, { rec: 'project', id: 'p1' }, {});
  const state = (): CollabState =>
    projectCollab([
      share,
      op('assign.set', rana, 1, F03, { target: F03, assignee: omar, due: '2026-10-09' }),
      op('assign.set', rana, 2, F05, { target: F05, assignee: omar }),
      op('comment.add', rana, 3, F03, {
        id: 'cm_aaaaaaaaaaaaaaaa',
        target: F03,
        text: '@Omar please check the weld',
        mentions: [omar],
        view: { camera: { position: [1, 2, 3], target: [0, 0, 0] } },
      }),
      op('comment.add', omar, 4, F03, {
        id: 'cm_bbbbbbbbbbbbbbbb',
        target: F03,
        text: 'On it',
        replyTo: 'cm_aaaaaaaaaaaaaaaa',
        visibility: 'client',
      }),
    ]);

  it('lists what is assigned to me, mentions me and awaits my approval', () => {
    const w = myWork(state(), omar, { statusOf: (t) => (t.id === 'i_f03' ? 'reviewed' : 'draft') });
    expect(w.assigned.map((i) => i.target.id)).toEqual(['i_f03', 'i_f05']);
    expect(w.mentions.map((i) => i.target.id)).toEqual(['i_f03']);
    expect(w.awaiting.map((i) => i.target.id)).toEqual(['i_f03']);
    expect(myWork(state(), rana).assigned).toEqual([]);
    expect([...mineKeys(state(), omar)].sort()).toEqual(['issue::i_f03', 'issue::i_f05']);
  });

  it('a client sees client-visible comments only and no assignments', () => {
    const v = visibleTo(state(), 'client');
    expect(v.comments.map((c) => c.text)).toEqual(['On it']);
    expect(v.assignments).toEqual([]);
    expect(visibleTo(state(), 'reviewer').comments).toHaveLength(2);
  });

  it('nests replies under their comment', () => {
    const t = threadOf(state().comments);
    expect(t).toHaveLength(1);
    expect(t[0]?.replies.map((r) => r.text)).toEqual(['On it']);
  });
});

describe('sign-off block', () => {
  it('lists prepared, reviewed, approved and client acceptance with dates', () => {
    const h = hashOf('a');
    const report = { kind: 'report' as const, id: 'p1' };
    const s = projectCollab(
      [
        op('project.share', rana, 0, { rec: 'project', id: 'p1' }, {}),
        op('approval.add', omar, 1, F05, {
          id: 'ap_aaaaaaaaaaaaaaaa',
          target: F05,
          decision: 'approve',
          contentHash: h,
        }),
        op('approval.add', lina, 2, report, {
          id: 'ap_bbbbbbbbbbbbbbbb',
          target: report,
          decision: 'approve',
          contentHash: h,
        }),
        op('approval.add', cleo, 3, report, {
          id: 'ap_cccccccccccccccc',
          target: report,
          decision: 'accept',
          contentHash: h,
        }),
      ],
      { materialHashOf: () => h },
    );
    const who = (a: string) => {
      const p = PEOPLE.find((x) => x.actor === a);
      return { name: p?.name ?? a, initials: p?.initials ?? '?' };
    };
    const b = signOffBlock(s, {
      projectId: 'p1',
      issueIds: ['i_f03', 'i_f05'],
      who,
      prepared: { actor: rana, date: '2026-10-07' },
    });
    expect(b.shared).toBe(true);
    expect(b.prepared).toMatchObject({ name: 'Rana Example', initials: 'RE' });
    expect(b.reviewed.map((p) => p.initials)).toEqual(['OS']);
    expect(b.approved.map((p) => p.initials)).toEqual(['LT']);
    expect(b.accepted.map((p) => p.initials)).toEqual(['CC']);
    expect(b.findings).toEqual({ approved: 1, total: 2 });
    expect(b.reviewed[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('markdown-lite', () => {
  it('bold, italic, code and mentions; links and emails stay text', () => {
    expect(tokenize('**Weld** at *toe*, see `F03` @Omar')).toEqual([
      { t: 'bold', v: 'Weld' },
      { t: 'text', v: ' at ' },
      { t: 'italic', v: 'toe' },
      { t: 'text', v: ', see ' },
      { t: 'code', v: 'F03' },
      { t: 'text', v: ' ' },
      { t: 'mention', v: 'Omar' },
    ]);
    expect(tokenize('mail rana@example.com or https://example.com/x')).toEqual([
      { t: 'text', v: 'mail rana@example.com or https://example.com/x' },
    ]);
    expect(renderLite('one\ntwo')).toHaveLength(2);
  });
});
