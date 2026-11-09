// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ImportLayer } = await import('./ImportPanel');
const { builder } = await import('./state');
const { shell } = await import('../shell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
} as unknown as ProjectManifest;

/** A file drop as the window gets it from the system: the paths come from the bridge. */
function drop(paths: string[]): void {
  const files = paths.map((p) => ({ path: p }));
  const e = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files } });
  window.dispatchEvent(e);
}

let host: HTMLDivElement;
let root: Root | undefined;
const addFolders = vi.fn(() => Promise.resolve());
const importFiles = vi.fn(() => Promise.resolve());
let saved: { addFolders: unknown; importFiles: unknown };

beforeEach(() => {
  (window as { aio?: unknown }).aio = {
    pathForFile: (f: { path: string }) => f.path,
    on: () => () => undefined,
  };
  saved = { addFolders: shell.getState().addFolders, importFiles: builder.getState().importFiles };
  shell.setState({ addFolders });
  builder.setState({ importFiles });
  addFolders.mockClear();
  importFiles.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(<ImportLayer />);
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  shell.setState({ addFolders: saved.addFolders as never });
  builder.setState({ importFiles: saved.importFiles as never });
  workspace.getState().closeProject();
  delete (window as { aio?: unknown }).aio;
});

describe('a drop with no project open', () => {
  it('adds the dropped folders to the library, as Add project folder does', () => {
    drop(['D:/Mission 1']);
    expect(addFolders).toHaveBeenCalledWith(['D:/Mission 1']);
    expect(importFiles).not.toHaveBeenCalled();
  });

  it('imports into the open project when one is open', () => {
    workspace.getState().openProject({ id: 'p', root: 'E:/p', manifest });
    drop(['D:/Mission 1']);
    expect(importFiles).toHaveBeenCalledWith(['D:/Mission 1']);
    expect(addFolders).not.toHaveBeenCalled();
  });
});
