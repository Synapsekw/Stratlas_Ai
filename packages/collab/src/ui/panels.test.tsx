// @vitest-environment jsdom
import type { CollabState, Issue } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTORS, F05, hlc } from '../testing';
import {
  IssueCollab,
  MineFilter,
  resetCollabStore,
  useMineIssueIds,
  type StatusEditor,
} from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { rana, omar } = ACTORS;
const HASH = 'a'.repeat(64);
const issue = (status: Issue['status']): Issue => ({
  id: 'i_f05',
  code: 'F05',
  classId: 'corrosion',
  severityModelId: 'sev4',
  severity: 2,
  status,
  title: 'Flange corrosion',
  note: '',
  author: 'Rana Example',
  createdAt: '2026-10-07T08:00:00.000Z',
  updatedAt: '2026-10-07T08:00:00.000Z',
  sightings: [{ on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] } }],
  source: 'human',
});

let state: CollabState;
let calls: { channel: string; req: unknown }[];
let answers: Record<string, unknown>;

function installBridge() {
  calls = [];
  (globalThis as { aio?: unknown }).aio = {
    invoke: (channel: string, req: unknown) => {
      calls.push({ channel, req });
      if (channel === 'collab:read') return Promise.resolve({ ok: true, state });
      if (channel === 'identity:get')
        return Promise.resolve({
          ok: true,
          identity: {
            schema: 'aio.identity/1',
            actor: omar,
            name: 'Omar Sample',
            initials: 'OS',
            createdAt: '2026-10-07T08:00:00.000Z',
          },
          device: null,
          unsigned: true,
        });
      if (channel === 'members:list')
        return Promise.resolve({
          ok: true,
          me: 'reviewer',
          members: [
            { actor: rana, name: 'Rana Example', initials: 'RE', role: 'owner' },
            { actor: omar, name: 'Omar Sample', initials: 'OS', role: 'reviewer' },
          ],
        });
      return Promise.resolve(answers[channel] ?? { ok: true });
    },
    on: () => () => undefined,
  };
}

function editorFake() {
  const setStatus = vi.fn(() => ({ ok: true }));
  const editor: StatusEditor = {
    setStatus,
    subscribe: () => () => undefined,
    state: { save: { state: 'saved' } },
  };
  return { editor, setStatus };
}

let root: Root;
let el: HTMLDivElement;
async function mount(node: React.ReactNode) {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
const click = async (b: Element | null | undefined) => {
  await act(async () => {
    (b as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
  });
};
const button = (text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(text));

beforeEach(() => {
  resetCollabStore();
  answers = {};
  state = { comments: [], assignments: [], approvals: [], policy: null };
  installBridge();
  workspace.getState().openProject(
    {
      id: 'p1',
      manifest: {
        schema: 'aio.project/1',
        id: 'p1',
        name: 'Synthetic site',
        crs: { epsg: 32639 },
        origin: [0, 0, 0],
        captures: [],
        layers: [],
        severityModels: [],
        classCatalogues: [],
      },
    } as never,
    [issue('reviewed')],
  );
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  el.remove();
  workspace.getState().closeProject();
});

const shared = (): CollabState['policy'] => ({
  approval: {
    required: 1,
    fourEyes: true,
    closeBy: 'owner',
    viewersMayComment: false,
    clientAcceptance: 'record',
    materialFields: ['class', 'severity', 'sightings', 'measurements', 'status'],
  },
  minVerification: 'self',
  packageHistory: 'summary',
});

describe('IssueCollab', () => {
  it('in a project that is not shared: comments, no approvals', async () => {
    await mount(<IssueCollab issueId="i_f05" editor={editorFake().editor} />);
    expect(el.querySelector('[data-testid="comment-thread"]')).not.toBeNull();
    await click(button('Approvals'));
    expect(el.textContent).toMatch(/Approvals start once the project is shared/);
  });

  it('shows main refusal as it is, and steps the status when an approval completes it', async () => {
    state = { ...state, policy: shared() };
    const { editor, setStatus } = editorFake();
    await mount(<IssueCollab issueId="i_f05" editor={editor} />);
    await click(button('Approvals'));
    answers['collab:approve'] = {
      ok: false,
      error: 'Another reviewer must approve this. You made it or last changed it.',
      code: 'forbidden',
    };
    await click(el.querySelector('[data-testid="approve"]'));
    expect(el.querySelector('[role="alert"]')?.textContent).toMatch(/Another reviewer/);
    expect(setStatus).not.toHaveBeenCalled();
    answers['collab:approve'] = { ok: true, approved: true };
    await click(el.querySelector('[data-testid="approve"]'));
    expect(setStatus).toHaveBeenCalledWith('i_f05', 'approved');
  });

  it('an approved issue whose approval went out of date returns to reviewed', async () => {
    workspace.getState().upsertIssue(issue('approved'));
    state = {
      ...state,
      policy: shared(),
      approvals: [
        {
          id: 'ap_aaaaaaaaaaaaaaaa',
          target: F05,
          by: omar,
          decision: 'approve',
          contentHash: HASH,
          at: hlc(1),
          withdrawn: false,
          current: false,
        },
      ],
    };
    const { editor, setStatus } = editorFake();
    await mount(<IssueCollab issueId="i_f05" editor={editor} />);
    expect(setStatus).toHaveBeenCalledWith('i_f05', 'reviewed');
    await click(button('Approvals'));
    expect(el.querySelector('[data-testid="approval-state"]')?.textContent).toBe(
      'Approval out of date',
    );
  });

  it('posts a comment with the people picked from the @ list', async () => {
    state = { ...state, policy: shared() };
    await mount(<IssueCollab issueId="i_f05" editor={editorFake().editor} />);
    const box = el.querySelector('textarea');
    if (!box) throw new Error('no comment box');
    await act(async () => {
      // React tracks the value it set: go round its tracker the way a person typing does
      Reflect.set(HTMLTextAreaElement.prototype, 'value', 'Please look @Ra', box);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await click(button('RE'));
    expect(box.value).toBe('Please look @Rana ');
    await click([...el.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Comment'));
    const sent = calls.find((c) => c.channel === 'collab:comment')?.req as {
      mentions: string[];
      text: string;
    };
    expect(sent).toMatchObject({ text: 'Please look @Rana', mentions: [rana] });
  });
});

describe('Mine filter', () => {
  it('keeps the issues assigned to me', async () => {
    state = {
      ...state,
      assignments: [{ target: F05, assignee: omar, by: rana, at: hlc(1) }],
    };
    const seen: { ids: ReadonlySet<string> | null } = { ids: null };
    function Probe() {
      seen.ids = useMineIssueIds();
      return null;
    }
    await mount(
      <>
        <MineFilter />
        <Probe />
      </>,
    );
    expect(seen.ids).toBeNull();
    expect(button('My work')?.textContent).toBe('My work (1)');
    await click(el.querySelector('[data-testid="mine-filter"]'));
    expect([...(seen.ids ?? [])]).toEqual(['i_f05']);
    await click(el.querySelector('[data-testid="my-work-button"]'));
    expect(el.querySelector('[data-testid="my-work"]')?.textContent).toMatch(
      /Assigned to me \(1\)F05/,
    );
  });
});
