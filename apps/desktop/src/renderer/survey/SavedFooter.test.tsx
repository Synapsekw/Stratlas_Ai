// @vitest-environment jsdom
import { emptyMeasurements } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const look = vi.hoisted(() => ({ only: false }));
vi.mock('@aio/annotate', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAnnotateReadOnly: () => look.only,
}));

import { measureStore } from './measureStore';
import { SavedFooter } from './SavedFooter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const show = () => {
  act(() => {
    root?.render(<SavedFooter />);
  });
};

beforeEach(() => {
  look.only = false;
  measureStore.setState({
    status: 'ready',
    readOnly: false,
    file: emptyMeasurements(),
    savedText: JSON.stringify(emptyMeasurements()),
    resultsUnwritten: true,
    selected: [],
  });
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('SavedFooter', () => {
  it('offers Autosave and Save to someone who may edit', () => {
    show();
    expect(q('[data-testid="survey-autosave"]')).not.toBeNull();
    expect(q('[data-testid="survey-list-save"]')).not.toBeNull();
  });

  it('a look-only reviewer gets no Autosave and no Save, only a note', () => {
    look.only = true;
    show();
    expect(q('[data-testid="survey-autosave"]')).toBeNull();
    expect(q('[data-testid="survey-list-save"]')).toBeNull();
    expect(q('[data-testid="survey-saved-lookonly"]')?.textContent).toContain('not change');
  });
});
