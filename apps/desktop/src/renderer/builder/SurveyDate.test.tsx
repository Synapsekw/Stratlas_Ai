// @vitest-environment jsdom
import type { ImportItem } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const select = vi.hoisted(() => vi.fn());
vi.mock('../change/SurveyDate', () => ({
  SurveyDateSelect: (props: unknown) => {
    select(props);
    return null;
  },
}));

import { ImportSurveyDate } from './SurveyDate';
import { builder } from './state';

const row = (file: string, layerId: string): ImportItem => ({
  file,
  kind: 'photo',
  status: 'imported',
  layerId,
});

function open(layers: { id: string; capture?: string }[], captures: unknown[]) {
  workspace.setState({
    project: { id: 'p1', root: 'C:/p', manifest: { layers, captures } },
  } as never);
}

let host: HTMLDivElement;
let root: Root | undefined;
function mount(items: ImportItem[], newDates: string[]) {
  builder.setState({
    importResult: { items, error: null, newDates, dateSource: 'photos' },
  });
  root = createRoot(host);
  act(() => root?.render(<ImportSurveyDate items={items} />));
}
const props = () =>
  select.mock.calls.at(-1)?.[0] as { layerIds: string[]; suggestedDay?: string } | undefined;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  select.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  builder.setState({ importResult: null });
  workspace.setState({ project: null } as never);
});

describe('ImportSurveyDate', () => {
  it('re-dates every layer the import names, its photos layer of the day included', () => {
    open(
      [
        { id: 'photos-2024-11-06', capture: 'capture-2024-11-06' },
        { id: 'photos-2024-11-06-2', capture: 'capture-2024-11-06' },
        { id: 'clip-b', capture: 'capture-2024-11-06' },
      ],
      [{ id: 'capture-2024-11-06', label: 'Survey', date: '2024-11-06' }],
    );
    mount(
      [
        row('b.jpg', 'photos-2024-11-06-2'),
        row('c.jpg', 'photos-2024-11-06-2'),
        row('b.mp4', 'clip-b'),
      ],
      [],
    );
    expect(props()?.layerIds).toEqual(['photos-2024-11-06-2', 'clip-b']);
  });

  it('shows no select when the import made no layer', () => {
    open([{ id: 'photos' }], []);
    mount([{ file: 'b.las', kind: 'pointcloud', status: 'queued' }], []);
    expect(select).not.toHaveBeenCalled();
  });

  it('prefills New survey date with the import day when that day already had a date', () => {
    open(
      [{ id: 'clip-b', capture: 'capture-2024-11-06' }],
      [{ id: 'capture-2024-11-06', label: 'Survey', date: '2024-11-06' }],
    );
    mount([row('b.mp4', 'clip-b')], []);
    expect(props()?.suggestedDay).toBe('2024-11-06');
  });

  it('prefills with the date the import made', () => {
    open(
      [{ id: 'clip-b', capture: 'capture-2024-11-07' }],
      [{ id: 'capture-2024-11-07', label: 'Survey', date: '2024-11-07' }],
    );
    mount([row('b.mp4', 'clip-b')], ['capture-2024-11-07']);
    expect(props()?.suggestedDay).toBe('2024-11-07');
  });
});
