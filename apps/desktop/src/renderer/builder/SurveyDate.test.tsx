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
function mount(items: ImportItem[], newDates: string[], priorLayers: string[]) {
  builder.setState({
    importResult: { items, error: null, newDates, priorLayers, dateSource: 'photos' },
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
  it('re-dates only the layers the import made, not a photos layer it added to', () => {
    open(
      [
        { id: 'photos-2024-11-06', capture: 'capture-2024-11-06' },
        { id: 'clip-b', capture: 'capture-2024-11-06' },
      ],
      [{ id: 'capture-2024-11-06', label: 'Survey', date: '2024-11-06' }],
    );
    mount([row('b.jpg', 'photos-2024-11-06'), row('b.mp4', 'clip-b')], [], ['photos-2024-11-06']);
    expect(props()?.layerIds).toEqual(['clip-b']);
  });

  it('shows no select when every imported layer was there before', () => {
    open([{ id: 'photos' }], []);
    mount([row('b.jpg', 'photos')], [], ['photos']);
    expect(select).not.toHaveBeenCalled();
  });

  it('prefills New survey date with the import day when that day already had a date', () => {
    open(
      [{ id: 'clip-b', capture: 'capture-2024-11-06' }],
      [{ id: 'capture-2024-11-06', label: 'Survey', date: '2024-11-06' }],
    );
    mount([row('b.mp4', 'clip-b')], [], []);
    expect(props()?.suggestedDay).toBe('2024-11-06');
  });

  it('prefills with the date the import made', () => {
    open(
      [{ id: 'clip-b', capture: 'capture-2024-11-07' }],
      [{ id: 'capture-2024-11-07', label: 'Survey', date: '2024-11-07' }],
    );
    mount([row('b.mp4', 'clip-b')], ['capture-2024-11-07'], []);
    expect(props()?.suggestedDay).toBe('2024-11-07');
  });
});
