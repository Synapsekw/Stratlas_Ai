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
    undoDeletes: [],
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

  it('after a second deletion, Undo takes it back and then offers the first one', () => {
    act(() => {
      deleteMeasurements(['m1']);
      deleteMeasurements(['m3']);
    });
    expect(q('[data-testid="measure-undo"]')?.textContent).toContain('Line m3');
    act(() => {
      q('[data-testid="measure-undo-button"]')?.click();
    });
    expect(ids()).toEqual(['m2', 'm3']);
    expect(q('[data-testid="measure-undo"]')?.textContent).toContain('Line m1');
    act(() => {
      q('[data-testid="measure-undo-button"]')?.click();
    });
    expect(ids()).toEqual(['m1', 'm2', 'm3']);
    expect(q('[data-testid="measure-undo"]')).toBeNull();
  });

  it('a double-click on Undo takes back one deletion, not the one before it too', () => {
    act(() => {
      deleteMeasurements(['m1']);
      deleteMeasurements(['m3']);
    });
    const press = (detail: number) => {
      act(() => {
        q('[data-testid="measure-undo-button"]')?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, detail }),
        );
      });
    };
    // the two clicks of a double-click: the notice offers m1 under the pointer after the first
    press(1);
    press(2);
    expect(ids()).toEqual(['m2', 'm3']);
    expect(q('[data-testid="measure-undo"]')?.textContent).toContain('Line m1');
    // a click of its own (or Enter, detail 0) still takes back the next one
    press(0);
    expect(ids()).toEqual(['m1', 'm2', 'm3']);
  });
});
