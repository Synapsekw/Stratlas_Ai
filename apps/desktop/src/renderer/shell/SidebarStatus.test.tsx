// @vitest-environment jsdom
import type { PackageInfo } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shell } from '../shell';
import { SidebarStatus } from './SidebarStatus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = () => {
  act(() => {
    root = createRoot(host);
    root.render(<SidebarStatus />);
  });
};
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  shell.setState({ pkg: null, origin: null });
});

describe('SidebarStatus', () => {
  it('shows readonly-chip for a read-only package', () => {
    shell.setState({
      pkg: { file: 'site.aio', header: { readOnly: true } } as unknown as PackageInfo,
    });
    render();
    expect(q('readonly-chip')?.textContent).toBe('Read-only package');
    expect(q('origin-chip')).toBeNull();
  });
  it('shows origin-chip for a copy extracted from a package', () => {
    shell.setState({
      origin: {
        package: 'site.aio',
        exportedAt: '2026-04-13T00:00:00Z',
        extractedAt: '2026-04-14T00:00:00Z',
      } as never,
    });
    render();
    expect(q('origin-chip')?.textContent).toBe('Copy of site.aio');
    expect(q('readonly-chip')).toBeNull();
  });
  it('says the connection and opens its menu', () => {
    render();
    const chip = q('connection-chip');
    expect(chip?.textContent).toContain('Online');
    act(() => chip?.click());
    expect(q('connection-menu')).not.toBeNull();
  });
});
