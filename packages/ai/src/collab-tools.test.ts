import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findPerson } from './collab-tools';
import { runRendererTool, type RendererToolContext } from './renderer-tools';
import { fixtureIssue, fixtureManifest, fixtureWorkspace } from './test-fixtures';
import { allToolSpecs, approvalFor, riskOf } from './tools';

const RANA = `a_${'r'.repeat(26)}`;
const OMAR = `a_${'o'.repeat(26)}`;
const members = [
  { actor: RANA, name: 'Rana Example', initials: 'RE', role: 'owner' },
  { actor: OMAR, name: 'Omar Sample', initials: 'OS', role: 'reviewer' },
];

function ctx(): RendererToolContext {
  const ws = fixtureWorkspace();
  ws.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, [
    fixtureIssue({ id: 'i_f03', code: 'F03', status: 'reviewed' }),
  ]);
  return {
    workspace: ws,
    window: 'scene3d',
    scene: () => null,
    fetchJson: () => Promise.reject(new Error('HTTP 404')),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2026-10-07T12:00:00Z'),
  };
}

function bridge() {
  const invoke = vi.fn((...args: [string, unknown?]) => {
    const [channel] = args;
    if (channel === 'collab:read')
      return Promise.resolve({
        ok: true,
        state: {
          comments: [],
          approvals: [],
          assignments: [
            {
              target: { kind: 'issue', id: 'i_f03' },
              assignee: OMAR,
              due: '2026-10-09',
              by: RANA,
              at: `1790000000000.0000.d_${'a'.repeat(52)}`,
            },
          ],
          policy: { approval: { required: 1 } },
        },
      });
    if (channel === 'members:list') return Promise.resolve({ ok: true, members });
    if (channel === 'identity:get')
      return Promise.resolve({
        ok: true,
        identity: { actor: RANA, name: 'Rana Example', initials: 'RE' },
      });
    return Promise.resolve({ ok: true, id: 'cm_aaaaaaaaaaaaaaaa' });
  });
  (globalThis as { aio?: unknown }).aio = { invoke, on: () => () => undefined };
  return invoke;
}

afterEach(() => {
  delete (globalThis as { aio?: unknown }).aio;
});

describe('review workflow tools (decision 6)', () => {
  it('the registry has no tool that approves; comments and requests are writes', () => {
    const names = allToolSpecs().map((s) => s.meta.name);
    expect(names).toEqual(
      expect.arrayContaining(['list_my_work', 'show_thread', 'add_comment', 'request_approval']),
    );
    expect(names.filter((n) => /(^|_)(approve|accept|sign_?off|withdraw)(_|$)/.test(n))).toEqual(
      [],
    );
    expect(riskOf('add_comment')).toBe('write');
    expect(riskOf('request_approval')).toBe('write');
    expect(approvalFor('add_comment')).toBe(true);
    expect(riskOf('list_my_work')).toBe('read');
    expect(riskOf('show_thread')).toBe('navigate');
  });

  it('no executor can reach the approve channel', () => {
    const src = readFileSync(join(import.meta.dirname, 'collab-tools.ts'), 'utf8');
    expect(src).not.toMatch(/collab:approve|collab:withdraw/);
  });

  it('"What is assigned to Omar?" lists F03', async () => {
    bridge();
    const r = await runRendererTool('list_my_work', { person: 'Omar' }, ctx());
    expect(r.result).toMatchObject({
      person: 'Omar Sample',
      assigned: [{ item: 'F03', due: '2026-10-09', by: 'Rana Example' }],
      awaiting: [{ item: 'F03' }],
    });
  });

  it('request_approval assigns and comments with a mention, never approves', async () => {
    const invoke = bridge();
    await runRendererTool(
      'request_approval',
      { issue: 'F03', person: 'OS', due: '2026-10-09' },
      ctx(),
    );
    const channels = invoke.mock.calls.map((c) => c[0]);
    expect(channels).toContain('collab:assign');
    expect(channels).toContain('collab:comment');
    expect(channels).not.toContain('collab:approve');
    const comment = invoke.mock.calls.find((c) => c[0] === 'collab:comment')?.[1];
    expect(comment).toMatchObject({ mentions: [OMAR] });
    expect((comment as { text: string }).text).toMatch(/^@Omar please review/);
  });

  it('finds people by name, first name or initials', () => {
    expect(findPerson(members, '@omar').actor).toBe(OMAR);
    expect(findPerson(members, 're').actor).toBe(RANA);
    expect(() => findPerson(members, 'Lina')).toThrow(/No member/);
  });
});
