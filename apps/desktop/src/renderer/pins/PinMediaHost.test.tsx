// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { cancel } = vi.hoisted(() => ({ cancel: vi.fn() }));
vi.mock('./placePin', () => ({ pinSession: { getState: () => ({ cancel }) } }));
vi.mock('./PinStrip', () => ({ PinStrip: () => null }));
vi.mock('./PinSceneMount', () => ({ PinSceneMount: () => null }));
vi.mock('./PinMapMount', () => ({ PinMapMount: () => null }));
vi.mock('./PinMenu', () => ({ PinMenu: () => null }));

const { PinMediaHost } = await import('./PinMediaHost');

const open = (id: string) => {
  workspace.getState().openProject({
    id,
    root: `C:/${id}`,
    manifest: { layers: [], captures: [] } as unknown as ProjectManifest,
  });
};
const settle = () => act(() => Promise.resolve());

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  cancel.mockClear();
  open('a');
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  workspace.getState().closeProject();
});

describe('PinMediaHost', () => {
  it('keeps a session through StrictMode mounting it twice', async () => {
    act(() => {
      root.render(
        <StrictMode>
          <PinMediaHost />
        </StrictMode>,
      );
    });
    await settle();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('ends the session when the project changes', async () => {
    act(() => {
      root.render(<PinMediaHost />);
    });
    act(() => {
      open('b');
    });
    await settle();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('ends the session when the host goes (the scene is left)', async () => {
    act(() => {
      root.render(<PinMediaHost />);
    });
    act(() => {
      root.render(<></>);
    });
    await settle();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
