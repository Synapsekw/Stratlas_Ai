// @vitest-environment jsdom
import type { ProjectManifest, SurveyMeasurement } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shell } from '../shell';
import { MeasureMenu } from './MeasureMenu';
import { measureStore, select } from './measureStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest = { layers: [], captures: [] } as unknown as ProjectManifest;
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
const at = (id: string, projectId = 'p1') => ({ x: 40, y: 50, id, projectId });
const show = (a: ReturnType<typeof at> | null) => {
  act(() => {
    root?.render(<MeasureMenu at={a} onClose={() => undefined} />);
  });
};

beforeEach(() => {
  workspace.getState().openProject({ id: 'p1', root: 'E:/p', manifest });
  measureStore.setState({
    readOnly: false,
    selected: [],
    focus: null,
    editing: null,
    file: { schema: 'aio.measurements/1', measurements: [line('m1'), line('m2'), line('m3')] },
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

describe('MeasureMenu', () => {
  it('opens the measurement items, on the selection when the shape is in it', () => {
    select(['m1', 'm2']);
    show(at('m2'));
    expect(q('[data-testid="measure-menu"]')?.textContent).toContain('Delete 2 measurements');
    expect(q('[data-testid="measure-menu"]')?.textContent).toContain('2 measurements');
  });

  it('on a shape outside the selection, the shape alone', () => {
    select(['m1', 'm2']);
    show(at('m3'));
    const text = q('[data-testid="measure-menu"]')?.textContent ?? '';
    expect(text).toContain('Line m3');
    expect(text).toContain('Rename');
    expect(text).not.toContain('Delete 2');
  });

  it('greys the edits in a package', () => {
    shell.setState({ pkg: { path: 'E:/x.aiopkg' } } as never);
    show(at('m1'));
    const del = q('[data-testid="ctx-item-measure.delete"]');
    expect(del?.getAttribute('aria-disabled')).toBe('true');
    // hiding is a view setting, never an edit
    expect(q('[data-testid="ctx-item-measure.visibility"]')?.hasAttribute('aria-disabled')).toBe(
      false,
    );
  });

  it('draws nothing for a measurement that is gone or another project', () => {
    show(at('gone'));
    expect(q('[data-testid="measure-menu"]')).toBeNull();
    show(at('m1', 'other'));
    expect(q('[data-testid="measure-menu"]')).toBeNull();
    show(null);
    expect(q('[data-testid="measure-menu"]')).toBeNull();
  });
});
