// @vitest-environment jsdom
import { ProjectManifest, type PackageInfo } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shell } from '../shell';
import { WelcomeScreen } from './Welcome';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root | undefined;
beforeEach(() => {
  // the main area the screen is drawn in (App.tsx)
  host = document.createElement('main');
  host.className = 'main';
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
  shell.setState({ pkg: null });
});

const render = () => {
  act(() => {
    root = createRoot(host);
    root.render(<WelcomeScreen />);
  });
};

describe('WelcomeScreen', () => {
  // with no title bar, the page header is what drags the window and keeps clear of its buttons
  it('has a page header over the welcome, as every screen but the Scene', () => {
    workspace.getState().openProject({
      id: 'p',
      root: 'C:/p',
      manifest: ProjectManifest.parse({
        schema: 'aio.project/1',
        id: 'p',
        name: 'P',
        crs: { epsg: 32633 },
        origin: [500000, 4500000, 0],
        captures: [],
        layers: [],
        severityModels: [],
        classCatalogues: [],
      }),
    });
    shell.setState({
      pkg: { file: 'p.aio', sizeBytes: 1, header: { readOnly: true } } as unknown as PackageInfo,
    });
    render();
    const head = host.querySelector(':scope > .pg-head');
    expect(head?.querySelector('.pg-title')?.textContent).toBe('Welcome');
    expect(head?.nextElementSibling?.getAttribute('data-testid')).toBe('welcome');
  });

  it('keeps the header without a project', () => {
    render();
    expect(host.querySelector(':scope > .pg-head .pg-title')?.textContent).toBe('Welcome');
  });
});
