// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  readOnly: false,
  pkg: false,
  description: undefined as string | undefined,
}));

vi.mock('../../shell', () => ({
  useShell: (sel: (s: { pkg: boolean }) => unknown) => sel({ pkg: state.pkg }),
}));
/** The registry's Export, as the report actions register it: a CSV, DXF and PNG submenu. */
const exported = vi.hoisted(() => [] as string[]);
vi.mock('../../shell/actions', async () => {
  const ui = await import('@aio/ui');
  let done = false;
  return {
    registerSidebarActions: () => {
      if (done) return;
      done = true;
      ui.registerActions([
        ui.defineAction<'measurements'>({
          id: 'measure.export',
          label: 'mcard.export',
          section: 'file',
          targets: ['measurements'],
          present: 'submenu',
          submenu: (_tg, ctx) => [
            { id: 'csv', label: 'CSV', testId: 'measure-export-csv' },
            {
              id: 'dxf',
              label: 'DXF',
              testId: 'measure-export-dxf',
              disabled: ctx.pkg ? 'In a package' : false,
            },
          ],
          run: (tg, _ctx, sub) => {
            exported.push(`${tg.clicked}:${String(sub)}`);
          },
        }),
      ]);
    },
  };
});
vi.mock('../../shell/actions/measureActions', () => ({ flyToMeasurement: () => true }));
vi.mock('../../shell/actions/toastHost', () => ({ toastHost: () => ({}) }));
vi.mock('../../workspace/timeline', () => ({ timeline: { getState: () => ({ focus: null }) } }));
vi.mock('../ExportDialog', () => ({ openExportDialog: () => undefined }));
vi.mock('@aio/annotate', () => ({ useAnnotateReadOnly: () => false }));
vi.mock('@aio/workspace', () => ({
  useWorkspace: (sel: (s: unknown) => unknown) =>
    sel({ project: { manifest: { captures: [], layers: [] } }, hidden: {} }),
}));
vi.mock('../measureStore', () => ({
  useMeasure: (sel: (s: unknown) => unknown) =>
    sel({
      readOnly: state.readOnly,
      file: {
        measurements: [
          {
            id: 'm1',
            label: 'Haul ramp',
            ...(state.description ? { description: state.description } : {}),
          },
        ],
      },
    }),
  patchMeasurement: () => undefined,
  updateMeasurement: () => undefined,
  select: () => undefined,
}));

const { CardActions, CardMenu } = await import('./CardActions');

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
  Object.assign(state, { readOnly: false, pkg: false, description: undefined });
});

function mount(node: ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);

/** A real press: pointerdown (which the open menu watches on the window), then click. */
async function press(el: Element) {
  act(() => {
    el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
  act(() => {
    (el as HTMLElement).click();
  });
  // let the menu's close settle (it clears its marker after the press)
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('CardMenu', () => {
  it('opens on a press of "⋯" and a second press closes it', async () => {
    mount(<CardMenu id="m1" />);
    const opener = q('card-menu') as HTMLButtonElement;
    expect(opener.getAttribute('aria-label')).toBe('Actions for Haul ramp');
    await press(opener);
    expect(q('card-menu-list')).not.toBeNull();
    // Export once: the registry's, no hand-made item beside it
    expect(document.querySelectorAll('[data-testid="ctx-item-measure.export"]')).toHaveLength(1);
    expect(q('card-menu-export')).toBeNull();
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    await press(opener);
    expect(q('card-menu-list')).toBeNull();
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    // and the next press opens it again
    await press(opener);
    expect(q('card-menu-list')).not.toBeNull();
  });
});

describe('CardActions', () => {
  it('Notes unfolds the note with aria-expanded and focuses it', () => {
    mount(<CardActions id="m1" hasChart={false} />);
    const notes = q('card-notes') as HTMLButtonElement;
    expect(notes.getAttribute('aria-expanded')).toBe('false');
    expect(notes.hasAttribute('aria-pressed')).toBe(false);
    act(() => {
      notes.click();
    });
    expect(notes.getAttribute('aria-expanded')).toBe('true');
    const field = q('card-notes-field');
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    expect(notes.getAttribute('aria-controls')).toBe(field?.id);
  });

  it('hides Notes when nothing can be written and there is no note', () => {
    state.readOnly = true;
    mount(<CardActions id="m1" hasChart={false} />);
    expect(q('card-notes')).toBeNull();
    expect(q('card-export')).not.toBeNull();
    expect(q('card-fly')).not.toBeNull();
  });

  it('Export lists the registry formats and exports the one picked', async () => {
    mount(<CardActions id="m1" hasChart={false} />);
    await press(q('card-export') ?? document.body);
    expect(q('card-export-list')).not.toBeNull();
    expect(q('card-export-dxf')?.hasAttribute('aria-disabled')).toBe(false);
    await press(q('card-export-csv') ?? document.body);
    expect(exported.at(-1)).toBe('m1:csv');
  });

  it('in a package Export stays, with only the DXF greyed', async () => {
    state.pkg = true;
    mount(<CardActions id="m1" hasChart={false} />);
    const btn = q('card-export') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await press(btn);
    expect(q('card-export-dxf')?.getAttribute('aria-disabled')).toBe('true');
    expect(q('card-export-csv')).not.toBeNull();
    expect(q('card-export-csv')?.hasAttribute('aria-disabled')).toBe(false);
  });

  it('keeps Notes, read only, when there is a note to read', () => {
    state.readOnly = true;
    state.description = 'Checked with the site engineer';
    mount(<CardActions id="m1" hasChart={false} />);
    act(() => {
      (q('card-notes') as HTMLButtonElement).click();
    });
    const field = q('card-notes-field') as HTMLTextAreaElement;
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe('Checked with the site engineer');
  });
});
