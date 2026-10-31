// @vitest-environment jsdom
import type { Issue } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { LocationCheckRow } from './LocationCheckRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-10-01T00:00:00.000Z';
const base = {
  id: 'i1',
  code: 'F01',
  classId: 'crack',
  severityModelId: 'tank',
  severity: 2,
  status: 'draft',
  title: 'Crack',
  note: '',
  author: 'import',
  createdAt: NOW,
  updatedAt: NOW,
  source: 'import',
  sightings: [],
} as unknown as Issue;

let root: Root | undefined;
let host: HTMLElement;
const show = (issue: Issue) => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<LocationCheckRow issue={issue} />);
  });
};
const row = () => document.querySelector<HTMLElement>('[data-testid="fly-location-check"]');

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host.remove();
});

const ext = {
  source: 'flyability' as const,
  poi: 'p',
  snapshots: ['s'],
  wallDistanceM: 3.14,
  hitDistanceM: 3.2,
  locationCheck: 'agrees' as const,
};

describe('LocationCheckRow', () => {
  it('no row for an issue that was not imported', () => {
    show(base);
    expect(row()).toBeNull();
  });

  it('reads the wall distance naturally', () => {
    show({ ...base, external: ext });
    expect(row()?.textContent).toBe('Wall distance 3.1 m, point 3.2 m away');
    expect(row()?.dataset.tone).toBe('plain');
  });

  it('warns when the location disagrees', () => {
    show({ ...base, external: { ...ext, locationCheck: 'disagrees' } });
    expect(row()?.dataset.tone).toBe('warn');
  });
});
