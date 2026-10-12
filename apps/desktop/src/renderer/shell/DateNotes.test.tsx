// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const prompt = vi.hoisted(() => vi.fn());
vi.mock('./DatePrompt', () => ({
  DatePrompt: ({ canEdit }: { canEdit: boolean }) => {
    prompt(canEdit);
    return canEdit ? <p data-testid="date-prompt" /> : null;
  },
}));

import { DateNotes, type DateNote } from './DateNotes';

let host: HTMLDivElement;
let root: Root | undefined;
const onUndo = vi.fn();
const onDismiss = vi.fn();
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function mount(collapsed: boolean, note: DateNote | null, canEdit = true) {
  root = createRoot(host);
  act(() =>
    root?.render(
      <DateNotes
        collapsed={collapsed}
        canEdit={canEdit}
        note={note}
        onPromptResult={() => undefined}
        onUndo={onUndo}
        onDismiss={onDismiss}
      />,
    ),
  );
}
const moved: DateNote = {
  text: 'Moved 1 dataset.',
  danger: false,
  undo: { moved: [{ id: 'ph', capture: null }], target: 'c1' },
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  prompt.mockReset();
  onUndo.mockReset();
  onDismiss.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('DateNotes', () => {
  it('shows the prompt and the note in the open sidebar', () => {
    mount(false, moved);
    expect(q('date-prompt')).not.toBeNull();
    expect(q('date-note')?.textContent).toContain('Moved 1 dataset.');
    act(() => q('date-undo')?.click());
    expect(onUndo).toHaveBeenCalledWith(moved.undo);
  });

  it('shows neither in the collapsed rail', () => {
    mount(true, moved);
    expect(q('date-prompt')).toBeNull();
    expect(q('date-note')).toBeNull();
    expect(prompt).not.toHaveBeenCalledWith(true);
  });

  it('passes read-only on to the prompt', () => {
    mount(false, null, false);
    expect(q('date-prompt')).toBeNull();
    expect(q('date-note')).toBeNull();
  });
});
