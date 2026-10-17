// @vitest-environment jsdom
import type { Issue } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from '../../../shell';
import { threeDates } from '../../__fixtures__/threeDates';
import { useStageKeys } from '../../stageKeys';
import { sectionStore } from '../sectionState';
import { workbench } from '../workbenchStore';
import { AnnotateBench, useAnnotateFollow } from './AnnotateBench';
import { annotateStage } from './annotateStage';

// the 3D view's workspace is the plain one here
vi.mock('../../compare', async () => ({
  primaryScene: (await import('@aio/workspace')).workspace,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const issue = (id: string, status: Issue['status']): Issue =>
  ({
    id,
    code: id.toUpperCase(),
    classId: 'crack',
    severityModelId: 'sev',
    severity: 2,
    status,
    title: `Finding ${id}`,
    note: '',
    author: 'a',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    sightings: [],
    source: 'human',
  }) as unknown as Issue;

let host: HTMLDivElement;
let root: Root | undefined;

/** What the sidebar mounts: the follow, and the stage's keys that start it. */
function Probe({ bench }: { bench: boolean }) {
  useAnnotateFollow();
  useStageKeys(null);
  return bench ? <AnnotateBench /> : null;
}
const render = (bench = true) => {
  root ??= createRoot(host);
  act(() => root?.render(<Probe bench={bench} />));
};
const press = (key: string) => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
};
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent.trim()) === name,
  );

beforeEach(() => {
  localStorage.clear();
  sectionStore.setState({ byBench: {} });
  annotateStage.setState({ show3d: true, showMap: false, mode: null, state: null });
  shell.getState().setAnnotating(false);
  shell.getState().setRight(false);
  workspace.getState().openProject({ id: 'p', root: '/p', manifest: threeDates });
  workbench.getState().reset();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  shell.getState().setAnnotating(false);
  workspace.getState().closeProject();
  vi.restoreAllMocks();
});

describe('A opens Annotate', () => {
  it('opens the tab on the first press and closes it on the second', () => {
    render(false);
    press('a');
    expect(shell.getState().annotating).toBe(true);
    expect(workbench.getState().front).toBe('annotate');
    expect(workbench.getState().tabs.find((t) => t.id === 'annotate')?.live).toBe(true);
    press('a');
    expect(shell.getState().annotating).toBe(false);
    expect(workbench.getState().tabs.some((t) => t.id === 'annotate')).toBe(false);
    expect(workbench.getState().front).toBe('selection');
  });

  it('opens a folded sidebar, because the tools live there now', () => {
    act(() => {
      shell.getState().setRight(true);
    });
    render(false);
    press('a');
    expect(shell.getState().rightCollapsed).toBe(false);
  });

  it('leaves the tab in place when the person had opened it themselves', () => {
    render(false);
    act(() => {
      workbench.getState().open('annotate');
    });
    press('a');
    press('a');
    const tab = workbench.getState().tabs.find((t) => t.id === 'annotate');
    expect(tab?.live).toBe(false);
  });
});

describe('AnnotateBench', () => {
  it('offers to start annotating while the tools are off', () => {
    render();
    expect(host.querySelector('[role="group"][aria-label="Annotation tools"]')).toBeNull();
    act(() => button('Annotate: pins, lines, areas, cloud regions')?.click());
    expect(shell.getState().annotating).toBe(true);
  });

  it('shows the model tools while annotating in 3D, and Close keeps its name', () => {
    act(() => {
      shell.getState().setAnnotating(true);
    });
    render();
    const group = host.querySelector('[role="group"][aria-label="Annotation tools"]');
    expect(group).not.toBeNull();
    expect(
      group?.querySelector('[role="toolbar"][aria-label="3D annotation tools"]'),
    ).not.toBeNull();
    expect(button('Pin')).toBeDefined();
    expect(group?.querySelector('[aria-label="Map annotation tools"]')).toBeNull();
    act(() => button('Close the annotation tools')?.click());
    expect(shell.getState().annotating).toBe(false);
  });

  it('shows the map tools on the map, and sets the draw mode', () => {
    const setMode = vi.fn();
    act(() => {
      shell.getState().setAnnotating(true);
      annotateStage.setState({ show3d: false, showMap: true });
      annotateStage.getState().publish({
        mode: null,
        state: null,
        setMode,
        finish: vi.fn(),
        undo: vi.fn(),
        cancel: vi.fn(),
        onClick: vi.fn(),
      });
    });
    render();
    expect(host.querySelector('[aria-label="3D annotation tools"]')).toBeNull();
    expect(
      host.querySelector('[role="toolbar"][aria-label="Map annotation tools"]'),
    ).not.toBeNull();
    act(() => button('Line')?.click());
    expect(setMode).toHaveBeenCalledWith('line');
  });

  it('lists the drafts and selects the one picked', () => {
    act(() => {
      workspace.getState().upsertIssue(issue('f01', 'draft'));
      workspace.getState().upsertIssue(issue('f02', 'approved'));
      workspace.getState().upsertIssue(issue('f03', 'draft'));
      shell.getState().setAnnotating(true);
    });
    render();
    const rows = [...host.querySelectorAll<HTMLElement>('[data-draft]')];
    expect(rows.map((r) => r.dataset.draft)).toEqual(['f01', 'f03']);
    act(() => rows[1]?.click());
    expect(workspace.getState().selection).toMatchObject({ kind: 'issue', id: 'f03' });
  });

  it('says so when there are no drafts', () => {
    render();
    expect(host.textContent).toContain('No drafts');
  });

  it('is off in a read-only package', () => {
    act(() => {
      shell.setState({ pkg: {} as never });
    });
    render();
    expect(host.textContent).toContain('read-only');
    act(() => {
      shell.setState({ pkg: null });
    });
  });
});
