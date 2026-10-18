// @vitest-environment jsdom
import type { PackageInfo } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { photoUi } from '../photogrammetry/store';
import { shell } from '../shell';
import { CreateMapsButton } from './CreateMapsButton';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
const button = () => host.querySelector<HTMLElement>('[data-testid="sidebar-create-maps"]');
const render = () => {
  act(() => {
    root = createRoot(host);
    root.render(<CreateMapsButton />);
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

describe('CreateMapsButton', () => {
  it('is not shown without a project', () => {
    render();
    expect(button()).toBeNull();
  });
  it('names itself and opens the photo wizard in an open project', () => {
    openProject();
    render();
    expect(button()?.querySelector('.lbl')?.textContent).toBe('Create maps from photos');
    expect(button()?.getAttribute('aria-label')).toBe('Create maps from photos');
    act(() => button()?.click());
    expect(photoUi.getState().view).toEqual({ kind: 'wizard' });
  });
  it('is not shown in a package, which cannot change', () => {
    openProject();
    shell.setState({
      pkg: { file: 'site.aio', header: { readOnly: true } } as unknown as PackageInfo,
    });
    render();
    expect(button()).toBeNull();
  });
});
