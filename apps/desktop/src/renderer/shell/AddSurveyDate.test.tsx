// @vitest-environment jsdom
import type { Capture, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { call, focusSurvey, pickAndImportFolder } = vi.hoisted(() => ({
  call: vi.fn(),
  focusSurvey: vi.fn(),
  pickAndImportFolder: vi.fn(),
}));
vi.mock('../shell', () => ({ bridge: { call } }));
vi.mock('../workspace/timeline', () => ({ timeline: { getState: () => ({ focusSurvey }) } }));
vi.mock('../builder/state', () => ({ builder: { getState: () => ({ pickAndImportFolder }) } }));

import { addDateMenu, AddSurveyDateButton } from './AddSurveyDate';

const cap = (date: string): Capture => ({ id: `capture-${date}`, label: 'Survey', date });
const manifest = (captures: Capture[]): ProjectManifest => ({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures,
  layers: [],
  severityModels: [],
  classCatalogues: [],
});

/** Main as far as these channels go. */
let disk: ProjectManifest;
function fakeMain() {
  call.mockImplementation((channel: string, req: Record<string, unknown>) => {
    if (channel === 'builder:ensureCapture') {
      const date = req.date as string;
      const found = disk.captures.find((c) => c.date === date);
      if (!found) disk = { ...disk, captures: [...disk.captures, cap(date)] };
      return Promise.resolve({
        ok: true,
        value: { ok: true, manifest: disk, captureId: `capture-${date}`, created: !found },
      });
    }
    if (channel === 'builder:updateCapture') {
      const patch = req.patch as { label?: string };
      disk = {
        ...disk,
        captures: disk.captures.map((c) => (c.id === req.captureId ? { ...c, ...patch } : c)),
      };
      return Promise.resolve({ ok: true, value: { ok: true, manifest: disk } });
    }
    return Promise.resolve({ ok: false, error: `unexpected ${channel}` });
  });
}

let host: HTMLDivElement;
let root: Root | undefined;
const onNote = vi.fn();
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const popover = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};
function mount() {
  root = createRoot(host);
  act(() => root?.render(<AddSurveyDateButton onNote={onNote} />));
}
function openIt() {
  act(() => q('add-survey-date')?.click());
}
/** Set a React-controlled input's value the way typing does. */
function type(input: HTMLInputElement | null | undefined, value: string) {
  if (!input) throw new Error('no field');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const dateField = () => popover()?.querySelector<HTMLInputElement>('input[type="date"]');
const nameField = () => popover()?.querySelector<HTMLInputElement>('input[type="text"]');

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  disk = manifest([cap('2024-11-06')]);
  workspace.setState({ project: { id: 'p', root: 'C:/p', manifest: disk } } as never);
  call.mockReset();
  focusSurvey.mockReset();
  pickAndImportFolder.mockReset();
  pickAndImportFolder.mockResolvedValue(undefined);
  onNote.mockReset();
  fakeMain();
  addDateMenu.getState().set(false);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.setState({ project: null });
});

describe('AddSurveyDateButton', () => {
  it('opens from the button and closes on the button, Escape and a press outside', async () => {
    mount();
    const btn = q('add-survey-date');
    expect(btn?.getAttribute('aria-label')).toBe('Add survey date');
    expect(btn?.getAttribute('aria-expanded')).toBe('false');
    expect(popover()).toBeNull();

    openIt();
    expect(btn?.getAttribute('aria-expanded')).toBe('true');
    const dlg = popover();
    expect(dlg?.getAttribute('aria-label')).toBe('Add survey date');
    expect(dlg?.classList.contains('dmenu')).toBe(true);
    // defaults to today, local time
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(dateField()?.value).toBe(
      `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    );
    expect(nameField()?.placeholder).toBe('Survey');

    openIt();
    expect(popover()).toBeNull();

    openIt();
    act(() => {
      dateField()?.focus();
      dateField()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(popover()).toBeNull();
    await flush();
    expect(document.activeElement).toBe(btn);

    openIt();
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(popover()).toBeNull();
  });

  it('adds a new date, names it, focuses it and closes', async () => {
    mount();
    openIt();
    type(dateField(), '2026-12-01');
    type(nameField(), '  Planned flight ');
    act(() => q('add-date-submit')?.click());
    await flush();
    expect(call.mock.calls.map((c) => c[0] as string)).toEqual([
      'builder:ensureCapture',
      'builder:updateCapture',
    ]);
    expect(call.mock.calls[0]?.[1]).toMatchObject({ projectId: 'p', date: '2026-12-01' });
    expect(call.mock.calls[1]?.[1]).toMatchObject({
      captureId: 'capture-2026-12-01',
      patch: { label: 'Planned flight' },
    });
    expect(focusSurvey).toHaveBeenCalledWith('capture-2026-12-01');
    expect(onNote).not.toHaveBeenCalled();
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(q('add-survey-date'));
  });

  it('submits on Enter in a field and leaves the name alone when none was typed', async () => {
    mount();
    openIt();
    type(dateField(), '2025-01-02');
    act(() => {
      popover()?.querySelector('form')?.requestSubmit();
    });
    await flush();
    expect(call.mock.calls.map((c) => c[0] as string)).toEqual(['builder:ensureCapture']);
    expect(focusSurvey).toHaveBeenCalledWith('capture-2025-01-02');
  });

  it('notes a day that already has a date and does not rename it', async () => {
    mount();
    openIt();
    type(dateField(), '2024-11-06');
    type(nameField(), 'Other');
    act(() => q('add-date-submit')?.click());
    await flush();
    expect(call.mock.calls.map((c) => c[0] as string)).toEqual(['builder:ensureCapture']);
    expect(onNote).toHaveBeenCalledWith('6 Nov 2024 is already a survey date.');
    expect(focusSurvey).toHaveBeenCalledWith('capture-2024-11-06');
    expect(popover()).toBeNull();
  });

  it('shows the error for a date that is not one and calls nothing', async () => {
    mount();
    openIt();
    type(dateField(), '');
    act(() => q('add-date-submit')?.click());
    await flush();
    expect(popover()?.querySelector('[role="alert"]')?.textContent).toBe(
      'Enter a date as day, month and year.',
    );
    expect(call).not.toHaveBeenCalled();
    expect(focusSurvey).not.toHaveBeenCalled();
    expect(popover()).not.toBeNull();
  });

  it('shows an error from main inline and stays open', async () => {
    call.mockResolvedValue({ ok: true, value: { ok: false, error: 'The project is locked.' } });
    mount();
    openIt();
    act(() => q('add-date-submit')?.click());
    await flush();
    expect(popover()?.querySelector('[role="alert"]')?.textContent).toBe('The project is locked.');
    expect(focusSurvey).not.toHaveBeenCalled();
  });

  it('imports a flight folder after closing', () => {
    mount();
    openIt();
    expect(q('add-date-folder')?.textContent).toContain('Import a flight folder...');
    expect(popover()?.textContent).toContain('The date is read from the files.');
    act(() => q('add-date-folder')?.click());
    expect(popover()).toBeNull();
    expect(pickAndImportFolder).toHaveBeenCalledTimes(1);
  });

  it('opens from the store (the command palette)', () => {
    mount();
    act(() => {
      addDateMenu.getState().set(true);
    });
    expect(popover()).not.toBeNull();
    expect(q('add-survey-date')?.getAttribute('aria-expanded')).toBe('true');
  });
});
