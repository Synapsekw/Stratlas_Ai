// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const where = { root: 'D:\\Sites\\A' as string | null, pkg: false, toolsFound: true };
const openProcessingTools = vi.fn();

vi.mock('../shell', () => ({
  bridge: { call: vi.fn(() => Promise.resolve({ ok: false, error: 'no dialog' })) },
  jobs: { getState: () => ({ start: vi.fn(() => Promise.resolve(null)), selected: null }) },
  useJobs: (selector: (s: { runtime: { found: boolean } }) => unknown) =>
    selector({ runtime: { found: where.toolsFound } }),
  useShell: (selector: (s: { pkg: object | null }) => unknown) =>
    selector({ pkg: where.pkg ? {} : null }),
}));
vi.mock('@aio/workspace', () => {
  const state = () => ({
    project:
      where.root === null
        ? null
        : { root: where.root, manifest: { name: 'Site A', type: 'inspection' } },
  });
  return {
    useWorkspace: (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
    workspace: { getState: state },
  };
});
vi.mock('../processingTools', () => ({
  openProcessingTools: () => {
    openProcessingTools();
  },
}));

import { PipelineDialog } from './PipelineDialog';
import { processing } from './store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
const draft = (project: string) => ({
  pipeline: 'road.build' as const,
  project,
  values: {},
});

function render() {
  act(() => {
    root ??= createRoot(host);
    root.render(<PipelineDialog />);
  });
}
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  where.root = 'D:\\Sites\\A';
  where.pkg = false;
  where.toolsFound = true;
  openProcessingTools.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  act(() => {
    processing.getState().closeDialog();
  });
});

describe('the start dialog', () => {
  it('is shown for the open project and opens on its first field', () => {
    act(() => {
      processing.getState().openDialog(draft('D:\\Sites\\A'));
    });
    render();
    expect(q('pipeline-dialog')).not.toBeNull();
    expect(document.activeElement?.closest('.dlg-b')).not.toBeNull();
    expect(document.activeElement?.tagName).toMatch(/^(INPUT|SELECT)$/);
  });

  it('gives the reason and the way out when the processing tools are missing', () => {
    where.toolsFound = false;
    act(() => {
      processing.getState().openDialog(draft('D:\\Sites\\A'));
    });
    render();
    expect(q('dialog-tools')?.textContent).toContain('Processing cannot run yet');
    expect(q('job-start')?.hasAttribute('disabled')).toBe(true);
    act(() => q('dialog-tools')?.querySelector('button')?.click());
    expect(openProcessingTools).toHaveBeenCalledTimes(1);
    expect(processing.getState().dialog).toBeNull();
  });

  it('says nothing about the tools when they are there', () => {
    act(() => {
      processing.getState().openDialog(draft('D:\\Sites\\A'));
    });
    render();
    expect(q('dialog-tools')).toBeNull();
  });

  it('forgets its request when the open project changes, so it never reappears over the next', () => {
    act(() => {
      processing.getState().openDialog(draft('D:\\Sites\\A'));
    });
    render();
    where.root = 'D:\\Sites\\B';
    render();
    expect(q('pipeline-dialog')).toBeNull();
    expect(processing.getState().dialog).toBeNull();
  });

  it('forgets its request when the project closes or a package opens', () => {
    act(() => {
      processing.getState().openDialog(draft('D:\\Sites\\A'));
    });
    render();
    where.pkg = true;
    render();
    expect(q('pipeline-dialog')).toBeNull();
    expect(processing.getState().dialog).toBeNull();
    where.pkg = false;
    act(() => {
      processing.getState().openDialog(draft('D:\\Sites\\A'));
    });
    render();
    where.root = null;
    render();
    expect(processing.getState().dialog).toBeNull();
  });
});
