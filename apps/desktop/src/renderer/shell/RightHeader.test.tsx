// @vitest-environment jsdom
import { workspace } from '@aio/workspace';
import { ProjectManifest } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shell } from '../shell';
import { PANEL_ID } from './PanelHandle';
import { RightHeader } from './RightHeader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root | undefined;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  // the right panel as the Scene draws it: the header, then the agent pane with its composer
  host = document.createElement('aside');
  host.id = PANEL_ID.right;
  host.innerHTML = '<div class="hdr"></div><div class="agent"><textarea></textarea></div>';
  document.body.append(host);
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
  shell.setState({ screen: 'scene', pkg: null });
  const slot = host.querySelector<HTMLElement>('.hdr');
  if (!slot) throw new Error('no header slot');
  act(() => {
    root = createRoot(slot);
    root.render(<RightHeader />);
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  workspace.getState().closeProject();
  host.remove();
});

describe('RightHeader', () => {
  it('has an Agent button on the Scene that takes the person to the agent', () => {
    const agent = q('agent-open');
    expect(agent?.textContent).toBe('Agent');
    act(() => agent?.click());
    expect(document.activeElement).toBe(host.querySelector('.agent textarea'));
  });

  it('keeps the dock toggle off the Scene', () => {
    expect(q('agent-toggle')).toBeNull();
  });
});
