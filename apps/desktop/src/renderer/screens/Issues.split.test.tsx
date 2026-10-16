// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { splitPrefs } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssuesScreen } from './Issues';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@aio/annotate', async (load) => ({
  ...(await load<object>()),
  IssueRegister: () => <div data-testid="issue-register" />,
}));

const manifest = {
  schema: 'aio.project/1',
  id: 'p1',
  name: 'Tank farm',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
} as unknown as ProjectManifest;

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  splitPrefs.setState({ byId: {} });
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p1', root: 'E:/projects/p1', manifest });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
});

describe('Issues on a split', () => {
  it('puts a handle between the issue list and the card, the card 420 px', () => {
    root = createRoot(host);
    act(() => root?.render(<IssuesScreen />));
    const handle = host.querySelector<HTMLElement>('[role="separator"]');
    expect(handle?.getAttribute('aria-label')).toBe('Resize the issue list');
    expect(handle?.getAttribute('aria-valuenow')).toBe('420');
    // the list and the card are the split's two panes
    expect(host.querySelector('.split-pane > .iss-main')).not.toBeNull();
    expect(host.querySelector('.split-pane > .iss-side')).not.toBeNull();
  });
});
