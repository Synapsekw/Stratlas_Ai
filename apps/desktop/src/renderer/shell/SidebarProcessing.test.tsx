// @vitest-environment jsdom
import type { PackageInfo } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { photoUi } from '../photogrammetry/store';
import { shell } from '../shell';
import { SidebarProcessing } from './SidebarProcessing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
const section = () => host.querySelector<HTMLElement>('[data-testid="sidebar-processing"]');
const button = () => host.querySelector<HTMLElement>('[data-testid="sidebar-create-maps"]');
const render = () => {
  act(() => {
    root = createRoot(host);
    root.render(<SidebarProcessing />);
  });
};
const openProject = () => {
  workspace.setState({ project: { id: 'p', root: 'C:/p', manifest: { layers: [] } } } as never);
};
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.setState({ project: null });
  shell.setState({ pkg: null });
  photoUi.getState().close();
});

describe('SidebarProcessing', () => {
  it('is not shown without a project', () => {
    render();
    expect(section()).toBeNull();
  });
  it('shows a Processing section with Create maps from photos as a calm row', () => {
    openProject();
    render();
    expect(section()?.getAttribute('aria-label')).toBe('Processing');
    expect(section()?.textContent).toContain('Processing');
    expect(button()?.querySelector('.lbl')?.textContent).toBe('Create maps from photos');
    // a sidebar row, not the loudest button on screen
    expect(button()?.classList.contains('nav-item')).toBe(true);
    expect(button()?.classList.contains('primary')).toBe(false);
  });
  it('opens the photo wizard', () => {
    openProject();
    render();
    act(() => button()?.click());
    expect(photoUi.getState().view).toEqual({ kind: 'wizard' });
  });
  it('is not shown in a package, which cannot change', () => {
    openProject();
    shell.setState({
      pkg: { file: 'site.aio', header: { readOnly: true } } as unknown as PackageInfo,
    });
    render();
    expect(section()).toBeNull();
  });
});
