// @vitest-environment jsdom
/**
 * Change on an AI suggestion: the class and severity form starting on the draft's own values (else
 * the project's last choice), accepting through `acceptWith`; Same as an existing finding links
 * the draft instead; a model word the project lacks can be added as a class.
 */
import type { Detection } from '@aio/annotate/detections';
import type { Issue } from '@aio/schema';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  confirmWith: ['rust', 2] as [string, number | 'uncertain'],
  newClassReason: null as string | null,
}));

vi.mock('@aio/annotate', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useNewClass: () => ({ create: () => Promise.resolve({}), disabledReason: h.newClassReason }),
  ClassSeverityForm: (p: {
    initialClassId: string | null;
    initialSeverity: number | 'uncertain' | null;
    confirmLabel: string;
    onConfirm: (c: string, s: number | 'uncertain') => string | null;
    onCancel: () => void;
    rows?: ReactNode;
    error?: string | null;
  }) => (
    <div
      data-testid="form"
      data-class={p.initialClassId ?? ''}
      data-severity={String(p.initialSeverity)}
    >
      {p.rows}
      {p.error && <p className="form-error">{p.error}</p>}
      <button
        type="button"
        data-testid="form-confirm"
        onClick={() => p.onConfirm(h.confirmWith[0], h.confirmWith[1])}
      >
        {p.confirmLabel}
      </button>
      <button type="button" data-testid="form-cancel" onClick={p.onCancel}>
        Cancel
      </button>
    </div>
  ),
}));
vi.mock('./actions', () => ({
  acceptWith: vi.fn(() => Promise.resolve({ ok: true, issueId: 'i9' })),
  linkSuggestion: vi.fn(() => Promise.resolve({ ok: true, issueId: 'i1' })),
}));
vi.mock('../detections/store', () => ({ dispatch: vi.fn() }));
vi.mock('./lastChoice', () => ({ lastChoiceFor: vi.fn(() => null) }));
vi.mock('../detections/createFromLabel', () => ({
  createClassFromLabel: vi.fn(() => Promise.resolve(null)),
}));

const { ChangePicker } = await import('./ChangePicker');
const { acceptWith, linkSuggestion } = await import('./actions');
const { lastChoiceFor } = await import('./lastChoice');
const { dispatch } = await import('../detections/store');
const { createClassFromLabel } = await import('../detections/createFromLabel');

const det = (over: Partial<Detection> = {}): Detection =>
  ({
    id: 'd1',
    pass: 'ai-1.json',
    source: { kind: 'photo', layer: 'photos', photo: 'p1' },
    size: [4000, 3000],
    geom: { type: 'box', box: [0, 0, 10, 10] },
    classId: 'crack',
    severity: 3,
    uncertain: false,
    note: '',
    status: 'draft',
    confidence: 0.9,
    origin: { kind: 'ai', model: 'm', promptVersion: '1' },
    ...over,
  }) as unknown as Detection;

const issue = (id: string, code: string): Issue =>
  ({
    id,
    code,
    title: `Finding ${code}`,
    classId: 'crack',
    severity: 2,
    severityModelId: 'sev',
    sightings: [{ on: 'image', layer: 'photos', photo: 'p1', geom: { type: 'box' } }],
  }) as unknown as Issue;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.clearAllMocks();
  h.newClassReason = null;
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const render = async (over: Partial<Parameters<typeof ChangePicker>[0]> = {}) => {
  const props = {
    projectId: 'p1',
    detection: det(),
    issues: [issue('i1', 'F01')],
    onDone: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  await act(async () => {
    root.render(<ChangePicker {...props} />);
    await Promise.resolve();
  });
  return props;
};
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (el: HTMLElement | null) => {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    el.click();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('ChangePicker fields', () => {
  const reading = {
    key: 'reading',
    label: 'Reading',
    type: 'number' as const,
    value: 42.5,
    unit: 'bar',
  };

  it('shows the form above the lists when the draft has fields', async () => {
    await render({ detection: det({ fields: [reading] }) });
    expect(byId('fields-form')).not.toBeNull();
    expect(byId('fields-form')?.nextElementSibling).toBe(byId('form'));
  });

  it('shows no form for a draft without fields', async () => {
    await render();
    expect(byId('fields-form')).toBeNull();
  });

  it('patches the edited fields before accepting', async () => {
    await render({ detection: det({ fields: [reading] }) });
    const input = byId('field-reading') as HTMLInputElement;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      set?.call(input, '17');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await click(byId('form-confirm'));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'edit',
        id: 'd1',
        patch: { fields: [{ ...reading, value: 17 }] },
      }),
    );
    expect(acceptWith).toHaveBeenCalled();
  });

  it('does not patch when nothing was edited', async () => {
    await render({ detection: det({ fields: [reading] }) });
    await click(byId('form-confirm'));
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('ChangePicker', () => {
  it("starts on the draft's class and severity", async () => {
    await render();
    expect(byId('inspect-change-picker')).not.toBeNull();
    expect(byId('form')?.dataset.class).toBe('crack');
    expect(byId('form')?.dataset.severity).toBe('3');
  });

  it('starts on the last choice when the draft has no class', async () => {
    vi.mocked(lastChoiceFor).mockReturnValue({ classId: 'rust', severity: 4 });
    await render({ detection: det({ classId: '', severity: null }) });
    expect(byId('form')?.dataset.class).toBe('rust');
    expect(byId('form')?.dataset.severity).toBe('4');
  });

  it('accepts with the picked class and severity', async () => {
    const p = await render();
    await click(byId('form-confirm'));
    expect(acceptWith).toHaveBeenCalledWith('p1', 'd1', { classId: 'rust', severity: 2 });
    expect(p.onDone).toHaveBeenCalledTimes(1);
  });

  it('shows why an accept failed and stays open', async () => {
    vi.mocked(acceptWith).mockResolvedValueOnce({ ok: false, error: 'Disk full' });
    const p = await render();
    await click(byId('form-confirm'));
    expect(host.querySelector('.form-error')?.textContent).toBe('Disk full');
    expect(p.onDone).not.toHaveBeenCalled();
  });

  it('accepts once while a call is pending', async () => {
    let finish: (v: { ok: true; issueId: string }) => void = () => undefined;
    vi.mocked(acceptWith).mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    const p = await render();
    await click(byId('form-confirm'));
    await click(byId('form-confirm'));
    expect(acceptWith).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ ok: true, issueId: 'i9' });
      await Promise.resolve();
    });
    expect(p.onDone).toHaveBeenCalledTimes(1);
  });

  it('links to an existing finding from the picker', async () => {
    const p = await render();
    await click(byId('inspect-change-same'));
    const option = host.querySelector<HTMLElement>('[role="option"]');
    expect(option?.textContent).toContain('F01');
    await click(option);
    expect(linkSuggestion).toHaveBeenCalledWith('d1', 'i1');
    expect(p.onDone).toHaveBeenCalledTimes(1);
  });

  it('opens straight on the link list for key L, and cancel leaves', async () => {
    const p = await render({ startOn: 'link' });
    expect(byId('form')).toBeNull();
    expect(host.querySelector('[role="option"]')).not.toBeNull();
    const cancel = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel');
    await click(cancel ?? null);
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it('goes back to the form when the link list opened from it is cancelled', async () => {
    const p = await render();
    await click(byId('inspect-change-same'));
    const cancel = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel');
    await click(cancel ?? null);
    expect(byId('form')).not.toBeNull();
    expect(p.onCancel).not.toHaveBeenCalled();
  });

  it("offers the AI's own word as a class only for a suggested new class", async () => {
    await render({ detection: det({ classId: '', label: 'Spalling' }) });
    expect(byId('det-create-class')).toBeNull();
    await render({ detection: det({ classId: '', label: 'Spalling', suggestedNew: true }) });
    expect(byId('det-create-class')?.textContent).toBe('Add "Spalling" as a class');
    await click(byId('det-create-class'));
    expect(createClassFromLabel).toHaveBeenCalledWith('Spalling');
  });
  it('keeps a class it cannot create focusable, with why in its tip, and creates nothing', async () => {
    h.newClassReason = 'This package is read only.';
    await render({ detection: det({ classId: '', label: 'Spalling', suggestedNew: true }) });
    const btn = byId('det-create-class') as HTMLButtonElement | null;
    expect(btn?.disabled).toBe(false);
    expect(btn?.getAttribute('aria-disabled')).toBe('true');
    await click(btn);
    expect(createClassFromLabel).not.toHaveBeenCalled();
  });
  it('shows why creating the class failed and keeps the form', async () => {
    vi.mocked(createClassFromLabel).mockResolvedValueOnce('Classes not saved: disk full');
    await render({ detection: det({ classId: '', label: 'Spalling', suggestedNew: true }) });
    await click(byId('det-create-class'));
    expect(host.querySelector('.form-error')?.textContent).toBe('Classes not saved: disk full');
    expect(byId('form')).not.toBeNull();
  });

  it('does nothing with a class create that finishes after the picker closed', async () => {
    let finish: (e: string | null) => void = () => undefined;
    vi.mocked(createClassFromLabel).mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    await render({ detection: det({ classId: '', label: 'Spalling', suggestedNew: true }) });
    await click(byId('det-create-class'));
    expect(byId('det-create-class')?.hasAttribute('disabled')).toBe(true);
    act(() => {
      root.unmount();
    });
    // the late answer neither throws nor sets state on the gone picker
    await act(async () => {
      finish('Classes not saved: disk full');
      await Promise.resolve();
    });
    root = createRoot(host);
    expect(host.querySelector('.form-error')).toBeNull();
  });
});
