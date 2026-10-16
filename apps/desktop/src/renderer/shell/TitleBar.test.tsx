// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridge, shell } from '../shell';
import { TitleBar } from './TitleBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest = {
  name: 'Demo tank farm',
  customer: 'Demo customer',
  captures: [],
  layers: [],
} as unknown as ProjectManifest;

let host: HTMLDivElement;
let root: Root | undefined;
const originalShell = shell.getState();
const originalWorkspace = workspace.getState();
beforeEach(() => {
  vi.spyOn(bridge, 'call').mockResolvedValue({ ok: false, error: 'not in this test' });
  // the chips beside the breadcrumbs listen for main's events
  Object.assign(window, { aio: { on: () => () => undefined } });
  shell.setState({ screen: 'detections' });
  workspace.setState({ project: { id: 'p', root: 'C:/p', manifest } } as never);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<TitleBar />));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  shell.setState(originalShell, true);
  workspace.setState(originalWorkspace, true);
  vi.restoreAllMocks();
});

describe('breadcrumbs', () => {
  it('keep each separator with the crumb before it, so a crumb squeezed away takes its slash', () => {
    const nav = host.querySelector('.crumbs');
    const crumbs = [...(nav?.querySelectorAll(':scope > .crumb') ?? [])];
    expect(crumbs.map((c) => c.getAttribute('title'))).toEqual(['Demo customer', 'Demo tank farm']);
    for (const c of crumbs) expect(c.querySelector('.sep')?.textContent).toBe('/');
    expect(nav?.querySelectorAll(':scope > .sep')).toHaveLength(0);
    expect(nav?.lastElementChild?.tagName).toBe('B');
    expect(nav?.lastElementChild?.textContent).toBe('Detections');
  });
});
