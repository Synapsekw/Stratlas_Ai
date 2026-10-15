// @vitest-environment jsdom
import type { Issue, IssueClass, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';

const h = vi.hoisted(() => ({
  editClass: vi.fn<(id: string, patch: unknown) => Promise<string | null>>(() =>
    Promise.resolve(null),
  ),
  deleteClass: vi.fn<(id: string, to: string | null) => Promise<string | null>>(() =>
    Promise.resolve(null),
  ),
  saveToLibrary: vi.fn(() => Promise.resolve(null as string | null)),
  undoClassEdit: vi.fn(() => Promise.resolve(true)),
  redoClassEdit: vi.fn(() => Promise.resolve(true)),
  createClass: vi.fn<(label: string) => Promise<IssueClass>>(),
  loadDetections: vi.fn<(projectId: string) => Promise<void>>(() => Promise.resolve()),
}));
interface DetState {
  projectId: string | null;
  loading: boolean;
  loadError?: string | null;
  review: { detections: { classId: string; status: string }[] };
}
vi.mock('../../classes/store', () => ({
  createClass: h.createClass,
  editClass: h.editClass,
  deleteClass: h.deleteClass,
  saveToLibrary: h.saveToLibrary,
  undoClassEdit: h.undoClassEdit,
  redoClassEdit: h.redoClassEdit,
}));
vi.mock('../../detections/store', async () => {
  const { createStore } = await import('zustand/vanilla');
  const { useStore } = await import('zustand');
  const detStore = createStore<DetState>()(() => ({
    projectId: 'p',
    loading: false,
    review: { detections: [] },
  }));
  return {
    detStore,
    loadDetections: h.loadDetections,
    useDetections: <T,>(selector: (s: DetState) => T) => useStore(detStore, selector),
  };
});
vi.mock('../../shell', () => ({
  useShell: <T,>(selector: (s: { pkg: null }) => T) => selector({ pkg: null }),
}));

const { Classes } = await import('./Classes');
const { detStore } = (await import('../../detections/store')) as unknown as {
  detStore: StoreApi<DetState>;
};
function setDetections(state: Partial<DetState>) {
  act(() => {
    detStore.setState(state);
  });
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [
    {
      id: 'sev',
      name: 'General',
      levels: [{ value: 1, label: 'Minor', color: '#78b3d6', criteria: 'M' }],
    },
  ],
  classCatalogues: [
    {
      id: 'cat',
      name: 'Classes',
      assetType: 'asset',
      classes: [
        { id: 'crack', label: 'Crack', color: '#e5484d', hotkey: 'c', severityModel: 'sev' },
        { id: 'rust', label: 'Rust', color: '#f08a3e', severityModel: 'sev' },
      ],
    },
  ],
};
const issue = { classId: 'rust' } as Issue;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<Classes />);
  });
}
function unmount() {
  act(() => {
    root?.unmount();
  });
  host?.remove();
}
beforeEach(() => {
  h.editClass.mockClear();
  h.deleteClass.mockClear();
  h.undoClassEdit.mockClear();
  h.redoClassEdit.mockClear();
  h.createClass.mockReset();
  h.loadDetections.mockClear();
  detStore.setState({
    projectId: 'p',
    loading: false,
    loadError: null,
    review: { detections: [] },
  });
  workspace.setState({ project: { id: 'p', root: '/p', manifest }, issues: [issue, issue] });
  mount();
});
afterEach(unmount);

const q = (s: string) => host?.querySelector(s) ?? null;
const inp = (s: string) => host?.querySelector<HTMLInputElement>(s) ?? null;
const sel = (s: string) => host?.querySelector<HTMLSelectElement>(s) ?? null;
const btn = (s: string) => host?.querySelector<HTMLButtonElement>(s) ?? null;
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Classes panel', () => {
  it('shows a row per class with its hotkey and issue count', () => {
    expect(q('[data-testid="classes-row-crack"]')).not.toBeNull();
    expect(inp('[aria-label="Hotkey of Crack"]')?.value).toBe('c');
    expect(q('[data-testid="classes-row-rust"]')?.textContent).toContain('2');
  });

  it('renames on Enter', async () => {
    const name = inp('[aria-label="Name of Crack"]');
    if (!name) throw new Error('no name field');
    act(() => {
      type(name, 'Wide crack');
    });
    await act(async () => {
      name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });
    expect(h.editClass).toHaveBeenCalledWith('crack', { label: 'Wide crack' });
  });

  it('shows a refused hotkey and puts the old one back', async () => {
    h.editClass.mockImplementationOnce(() => Promise.resolve('A hotkey is one letter.'));
    const key = inp('[aria-label="Hotkey of Crack"]');
    if (!key) throw new Error('no hotkey field');
    await act(async () => {
      type(key, '7');
      await Promise.resolve();
    });
    expect(h.editClass).toHaveBeenCalledWith('crack', { hotkey: '7' });
    expect(q('[data-testid="classes-row-crack"] [role="alert"]')?.textContent).toContain(
      'A hotkey is one letter.',
    );
    expect(key.value).toBe('c');
  });

  it('locks the severity scale of a used class and says why', () => {
    const rust = sel('[aria-label="Severity scale of Rust"]');
    expect(rust?.disabled).toBe(true);
    expect(rust?.title).toContain('Move them to another class');
    expect(sel('[aria-label="Severity scale of Crack"]')?.disabled).toBe(false);
  });

  it('asks where the issues of a used class go before deleting it', async () => {
    act(() => {
      btn('[data-testid="classes-delete-rust"]')?.click();
    });
    const dlg = q('[data-testid="classes-delete-dialog"]');
    expect(dlg?.textContent).toContain('2 issues and 0 detections use Rust. Move them to:');
    const select = sel('[data-testid="classes-move-to"]');
    expect(select?.value).toBe('crack');
    await act(async () => {
      btn('[data-testid="classes-move-delete"]')?.click();
      await Promise.resolve();
    });
    expect(h.deleteClass).toHaveBeenCalledWith('rust', 'crack');
  });

  it('asks too when only detections use the class, in the singular for one', () => {
    setDetections({ review: { detections: [{ classId: 'crack', status: 'draft' }] } });
    act(() => {
      btn('[data-testid="classes-delete-crack"]')?.click();
    });
    expect(q('[data-testid="classes-delete-dialog"]')?.textContent).toContain(
      '0 issues and 1 detection use Crack. Move them to:',
    );
    expect(h.deleteClass).not.toHaveBeenCalled();
  });

  it('reads the detections and waits for them before deleting a class', async () => {
    unmount();
    detStore.setState({ projectId: null, loading: false, review: { detections: [] } });
    mount();
    expect(h.loadDetections).toHaveBeenCalledWith('p');
    act(() => {
      btn('[data-testid="classes-delete-crack"]')?.click();
    });
    expect(h.deleteClass).not.toHaveBeenCalled();
    expect(q('[data-testid="classes-delete-dialog"]')?.textContent).toContain(
      'Checking which issues and detections use Crack.',
    );
    expect(btn('[data-testid="classes-move-delete"]')?.disabled).toBe(true);
    // the review arrives: a waiting detection uses Crack
    setDetections({
      projectId: 'p',
      loading: false,
      review: { detections: [{ classId: 'crack', status: 'draft' }] },
    });
    expect(q('[data-testid="classes-delete-dialog"]')?.textContent).toContain(
      '0 issues and 1 detection use Crack. Move them to:',
    );
    expect(sel('[data-testid="classes-move-to"]')?.value).toBe('rust');
    await act(async () => {
      btn('[data-testid="classes-move-delete"]')?.click();
      await Promise.resolve();
    });
    expect(h.deleteClass).toHaveBeenCalledWith('crack', 'rust');
  });

  it('offers to create the target when the used class is the only one', async () => {
    unmount();
    const rust: IssueClass = { id: 'rust', label: 'Rust', color: '#f08a3e', severityModel: 'sev' };
    const cat = { id: 'cat', name: 'Classes', assetType: 'asset' as const, classes: [rust] };
    const only: ProjectManifest = { ...manifest, classCatalogues: [cat] };
    workspace.setState({ project: { id: 'p', root: '/p', manifest: only }, issues: [issue] });
    h.createClass.mockImplementation((label) => {
      const cls: IssueClass = { id: 'stain', label, color: '#34a6d9', severityModel: 'sev' };
      workspace.setState({
        project: {
          id: 'p',
          root: '/p',
          manifest: { ...only, classCatalogues: [{ ...cat, classes: [...cat.classes, cls] }] },
        },
      });
      return Promise.resolve(cls);
    });
    mount();
    act(() => {
      btn('[data-testid="classes-delete-rust"]')?.click();
    });
    const dlg = q('[data-testid="classes-delete-dialog"]');
    expect(dlg?.textContent).toContain('1 issue and 0 detections use Rust.');
    expect(dlg?.textContent).toContain('Rust is the only class');
    expect(sel('[data-testid="classes-move-to"]')).toBeNull();
    expect(btn('[data-testid="classes-move-delete"]')?.disabled).toBe(true);
    act(() => {
      btn('[data-testid="classes-delete-new"]')?.click();
    });
    const field = inp('[aria-label="New class name"]');
    if (!field) throw new Error('no new class field');
    act(() => {
      type(field, 'Stain');
    });
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.createClass).toHaveBeenCalledWith('Stain');
    expect(sel('[data-testid="classes-move-to"]')?.value).toBe('stain');
    await act(async () => {
      btn('[data-testid="classes-move-delete"]')?.click();
      await Promise.resolve();
    });
    expect(h.deleteClass).toHaveBeenCalledWith('rust', 'stain');
  });

  it('will not delete a class while the detections could not be read', () => {
    setDetections({ loadError: 'detections/pass-1.json: permission denied' });
    act(() => {
      btn('[data-testid="classes-delete-crack"]')?.click();
    });
    expect(q('[data-testid="classes-delete-dialog"]')?.textContent).toContain(
      'The detections could not be read, so this class cannot be deleted safely.',
    );
    expect(btn('[data-testid="classes-move-delete"]')?.disabled).toBe(true);
    const cancel = [...(host?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Cancel',
    );
    act(() => {
      cancel?.click();
    });
    expect(q('[data-testid="classes-delete-dialog"]')).toBeNull();
    expect(h.deleteClass).not.toHaveBeenCalled();
  });

  // a project without a detections folder reads as an empty review (no loadError), see
  // folderFiles().passNames in main/detections.ts: its unused classes stay deletable
  it('deletes an unused class without asking and keeps focus in the panel', async () => {
    await act(async () => {
      btn('[data-testid="classes-delete-crack"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.deleteClass).toHaveBeenCalledWith('crack', null);
    expect(q('[data-testid="classes-delete-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(q('[data-testid="classes-panel"]'));
  });

  it('shows why the severity scale is locked, linked to the select', () => {
    const rust = sel('[aria-label="Severity scale of Rust"]');
    const id = rust?.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    const note = id ? document.getElementById(id) : null;
    expect(note?.textContent).toContain('Locked while issues use it');
    expect(note?.textContent).toContain('Move them to another class');
    expect(sel('[aria-label="Severity scale of Crack"]')?.hasAttribute('aria-describedby')).toBe(
      false,
    );
  });

  it('saves a name once when Enter is followed by a blur', async () => {
    const name = inp('[aria-label="Name of Crack"]');
    if (!name) throw new Error('no name field');
    act(() => {
      type(name, 'Wide crack');
    });
    await act(async () => {
      name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      name.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await Promise.resolve();
    });
    expect(h.editClass).toHaveBeenCalledTimes(1);
  });

  it('takes a typed letter as the hotkey wherever the caret is', async () => {
    const key = inp('[aria-label="Hotkey of Crack"]');
    if (!key) throw new Error('no hotkey field');
    await act(async () => {
      key.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', bubbles: true }));
      await Promise.resolve();
    });
    expect(h.editClass).toHaveBeenCalledWith('crack', { hotkey: 'k' });
    expect(key.value).toBe('k');
  });

  it('undoes with Ctrl+Z and redoes with Ctrl+Y in the panel', () => {
    const panel = q('[data-testid="classes-panel"]');
    act(() => {
      panel?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
      );
    });
    expect(h.undoClassEdit).toHaveBeenCalled();
    act(() => {
      panel?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }),
      );
    });
    expect(h.redoClassEdit).toHaveBeenCalled();
  });
});
