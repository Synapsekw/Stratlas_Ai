// @vitest-environment jsdom
import { ChangeSet, type AioBridge } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangePanel, type ChangePanelProps } from './ChangePanel';
import { changeStore } from './store';
import { SITE } from './testing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  delete (globalThis as { aio?: AioBridge }).aio;
  workspace.getState().closeProject();
  changeStore.setState({ projectId: null, sets: {}, summaries: [], misaligned: null, pair: null });
});

const set = (lineUp?: object) =>
  ChangeSet.parse({
    schema: 'aio.change/1',
    id: 'd1-d2-issues',
    from: 'd1',
    to: 'd2',
    producer: 'issues',
    createdAt: '2026-10-06T08:00:00Z',
    items: [{ kind: 'issue', id: 'issue:F01', verdict: 'new', at: [1, 2, 3] }],
    ...(lineUp ? { lineUp } : {}),
  });

async function render(props: Partial<ChangePanelProps> = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ChangePanel
        captures={SITE.captures.map((c) => ({ id: c.id, label: c.label }))}
        defaultPair={{ from: 'd1', to: 'd2' }}
        context={() => null}
        actions={{
          confirm: () => Promise.resolve(null),
          closeResolved: () => Promise.resolve(null),
          makeIssue: () => Promise.resolve(null),
          openIssue: () => undefined,
          canMakeIssue: () => false,
          issueCode: () => null,
          author: () => 'me',
        }}
        {...props}
      />,
    );
    await Promise.resolve();
  });
  return host;
}

function open(lined: boolean) {
  workspace.getState().openProject(
    {
      id: 'p',
      root: 'E:/x',
      manifest: {
        ...SITE,
        captures: SITE.captures.map((c) =>
          c.id === 'd2' && lined
            ? { ...c, lineUp: { eastM: 2, northM: 0, with: 'd1', at: '2026-10-10T00:00:00.000Z' } }
            : c,
        ),
      },
    },
    [],
  );
}

const q = (id: string) => host?.querySelector(`[data-testid="${id}"]`) ?? null;

describe('the Changes panel and a line-up', () => {
  it('shows the gap and Line up dates when a run was refused', async () => {
    open(false);
    changeStore.setState({
      misaligned: { from: 'd1', to: 'd2', shiftM: 2.014, producer: 'imagery' },
    });
    const onLineUp = vi.fn();
    await render({ onLineUp });
    expect(q('chg-misaligned')?.textContent).toContain('These dates are 2.01 m apart.');
    await act(async () => {
      (q('chg-lineup') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(onLineUp).toHaveBeenCalledWith('d1', 'd2');
  });

  it('shows no refusal for another pair', async () => {
    open(false);
    changeStore.setState({
      misaligned: { from: 'd2', to: 'd3', shiftM: 2, producer: 'imagery' },
    });
    await render({ onLineUp: vi.fn() });
    expect(q('chg-misaligned')).toBeNull();
  });

  it('offers Run again on a stale set', async () => {
    open(true);
    changeStore.setState({ projectId: 'p', sets: { 'd1-d2-issues': set() } });
    const onRerun = vi.fn();
    await render({ onRerun });
    expect(q('chg-stale')?.textContent).toContain('Out of date');
    await act(async () => {
      (q('chg-rerun') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(onRerun).toHaveBeenCalledWith('issues');
  });

  it('shows nothing stale for a set computed after the line-up', async () => {
    open(true);
    changeStore.setState({
      projectId: 'p',
      sets: { 'd1-d2-issues': set({ to: { eastM: 2, northM: 0 } }) },
    });
    await render({ onRerun: vi.fn() });
    expect(q('chg-stale')).toBeNull();
    expect(q('chg-rerun')).toBeNull();
  });
});
