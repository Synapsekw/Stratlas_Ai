// @vitest-environment jsdom
import type { SurveyMeasurement } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeasureUndoNotice } from './MeasureUndoNotice';
import { deleteMeasurements, measureStore } from './measureStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const line = (id: string): SurveyMeasurement => ({
  id,
  family: 'line',
  tool: 'distance',
  label: `Line ${id}`,
  scope: { kind: 'site' },
  points: [
    [0, 0, 0],
    [10, 0, 0],
  ],
  items: [],
  results: [],
  createdAt: '2026-10-11T00:00:00Z',
});

let root: Root | undefined;
let host: HTMLElement;
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const ids = () => measureStore.getState().file.measurements.map((m) => m.id);

beforeEach(() => {
  const file = {
    schema: 'aio.measurements/1' as const,
    measurements: [line('m1'), line('m2'), line('m3')],
  };
  measureStore.setState({
    projectId: null,
    readOnly: false,
    autosave: false,
    selected: [],
    focus: null,
    editing: null,
    file,
    savedText: JSON.stringify(file),
    undoDelete: null,
  });
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => {
    root?.render(<MeasureUndoNotice />);
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('MeasureUndoNotice', () => {
  it('shows nothing until measurements are deleted', () => {
    expect(q('[data-testid="measure-undo"]')).toBeNull();
  });

  it('says how many were deleted, and Undo brings them back', () => {
    act(() => {
      deleteMeasurements(['m1', 'm3']);
    });
    expect(q('[data-testid="measure-undo"]')?.textContent).toContain('2 measurements deleted');
    act(() => {
      q('[data-testid="measure-undo-button"]')?.click();
    });
    expect(ids()).toEqual(['m1', 'm2', 'm3']);
    expect(q('[data-testid="measure-undo"]')).toBeNull();
  });

  it('names one deleted measurement; Dismiss lets go of the undo', () => {
    act(() => {
      deleteMeasurements(['m2']);
    });
    expect(q('[data-testid="measure-undo"]')?.textContent).toContain('Line m2');
    act(() => {
      q('[data-testid="measure-undo-dismiss"]')?.click();
    });
    expect(q('[data-testid="measure-undo"]')).toBeNull();
    expect(ids()).toEqual(['m1', 'm3']);
  });
});
