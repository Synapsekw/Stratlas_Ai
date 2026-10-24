// @vitest-environment jsdom
import type { AntennasFile, AntennaUnit, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../workspace/workbench/project/projectListStore', () => ({ revealInList: vi.fn() }));
vi.mock('../shell', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    bridge: { call: () => Promise.resolve({ ok: false, error: 'Not configured' }) },
    jobs: { subscribe: () => () => undefined, getState: () => ({ jobs: [] }) },
  };
});

const { AntennaMenu } = await import('./AntennaMenu');
const { antennaStore } = await import('./antennaStore');
const { antennaDeleteStore } = await import('./antennaDelete');
const { shell } = await import('../shell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const unit = (id: string): AntennaUnit =>
  ({
    id,
    name: `Unit ${id}`,
    kind: 'panel',
    kindBasis: 'detected',
    status: 'draft',
  }) as unknown as AntennaUnit;

let root: Root | undefined;
let host: HTMLElement;
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const at = (id: string, projectId = 'p1') => ({ x: 40, y: 50, id, projectId });
const show = (a: ReturnType<typeof at> | null) => {
  act(() => {
    root?.render(<AntennaMenu at={a} onClose={() => undefined} />);
  });
};

beforeEach(() => {
  workspace.getState().openProject({
    id: 'p1',
    root: 'E:/p',
    manifest: { layers: [], captures: [] } as unknown as ProjectManifest,
  });
  antennaStore.setState({
    readOnly: false,
    ticked: {},
    hidden: {},
    filter: 'all',
    running: false,
    flagStarting: false,
    flagJob: null,
    file: {
      units: [unit('a'), { ...unit('b'), status: 'accepted' }, unit('c')],
    } as unknown as AntennasFile,
  });
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  shell.setState({ pkg: null });
});

describe('AntennaMenu', () => {
  it('opens on the unit with its name as the title', () => {
    show(at('a'));
    expect(q('[data-testid="antenna-menu"]')?.textContent).toContain('Unit a');
    expect(q('[data-testid="ctx-item-antenna.delete"]')).not.toBeNull();
  });

  it('acts on the ticked units when the clicked one is ticked', () => {
    antennaStore.setState({ ticked: { a: true, b: true } });
    show(at('b'));
    expect(q('[data-testid="antenna-menu"]')?.textContent).toContain('2 antennas');
    expect(q('[data-testid="ctx-item-antenna.editAzimuth"]')).toBeNull();
  });

  it('the clicked unit alone when it is not ticked', () => {
    antennaStore.setState({ ticked: { a: true, b: true } });
    show(at('c'));
    expect(q('[data-testid="antenna-menu"]')?.textContent).toContain('Unit c');
  });

  it('leaves out a ticked unit the filter hides, so Delete targets the visible one only', () => {
    antennaStore.setState({ ticked: { a: true, b: true }, filter: 'draft' });
    show(at('a'));
    expect(q('[data-testid="antenna-menu"]')?.textContent).toContain('Unit a');
    expect(q('[data-testid="antenna-menu"]')?.textContent).not.toContain('2 antennas');
    act(() => {
      q('[data-testid="ctx-item-antenna.delete"]')?.click();
    });
    expect(antennaDeleteStore.getState().ask?.ids).toEqual(['a']);
  });

  it('greys Delete while a detection runs', () => {
    antennaStore.setState({ running: true });
    show(at('a'));
    expect(q('[data-testid="ctx-item-antenna.delete"]')?.getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('draws nothing for a unit that is gone or another project', () => {
    show(at('gone'));
    expect(q('[data-testid="antenna-menu"]')).toBeNull();
    show(at('a', 'other'));
    expect(q('[data-testid="antenna-menu"]')).toBeNull();
    show(null);
    expect(q('[data-testid="antenna-menu"]')).toBeNull();
  });
});
