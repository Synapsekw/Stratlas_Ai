// @vitest-environment jsdom
import type { ModelRoute } from '@aio/ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  vi.resetModules();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.doUnmock('../engineer/flags');
});

/** Settings, Model routing, with the engineering model UI on or off. */
async function routing(ui: boolean) {
  vi.doMock('../engineer/flags', () => ({ ENGINEERING_MODEL_UI: ui }));
  const { Routing } = await import('./Settings');
  const { shell } = await import('../shell');
  const saved: ModelRoute[][] = [];
  shell.setState({
    updateSettings: (patch) => {
      if (patch.routes) saved.push(patch.routes);
      shell.setState({ settings: { ...shell.getState().settings, ...patch } });
      return Promise.resolve(null);
    },
  });
  act(() => root?.render(<Routing />));
  return { saved, shell };
}
const box = (task: string) =>
  host.querySelector<HTMLInputElement>(`[data-testid="treat-as-vision-${task}"]`);

// the Settings screen's module graph is large: its first import takes a while
describe('Model routing', { timeout: 60_000 }, () => {
  it('stores "Treat as vision model" on the route it was ticked for, and clears it', async () => {
    const { saved, shell } = await routing(false);
    expect(box('vision')?.checked).toBe(false);
    act(() => box('vision')?.click());
    const vision = (r: readonly ModelRoute[] | undefined) => r?.find((x) => x.task === 'vision');
    expect(vision(saved.at(-1))?.treatAsVision).toBe(true);
    // only that route
    expect(saved.at(-1)?.filter((r) => r.treatAsVision === true)).toHaveLength(1);
    expect(box('vision')?.checked).toBe(true);
    act(() => box('vision')?.click());
    expect(vision(saved.at(-1))?.treatAsVision).toBeUndefined();
    expect(vision(shell.getState().settings.routes)?.treatAsVision).toBeUndefined();
  });

  it('shows the Engineering models row only with the engineering model UI on', async () => {
    await routing(false);
    expect(box('engineer')).toBeNull();
    expect(host.textContent).not.toContain('Engineering models');
    act(() => root?.unmount());
    root = createRoot(host);
    vi.resetModules();
    const { saved } = await routing(true);
    expect(host.textContent).toContain('Engineering models');
    act(() => box('engineer')?.click());
    expect(saved.at(-1)?.find((r) => r.task === 'engineer')?.treatAsVision).toBe(true);
  });
});
