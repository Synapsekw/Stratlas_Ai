// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

// the Settings screen's module graph is large: its first import takes a while
describe('Settings, AI providers: agent thinking and prompt caching', { timeout: 60_000 }, () => {
  it('is on by default and saves off and on again', async () => {
    const { AgentThinking } = await import('./Settings');
    const { shell } = await import('../shell');
    const saved: (boolean | undefined)[] = [];
    // absent: on
    const settings = { ...shell.getState().settings };
    delete settings.agentThinking;
    shell.setState({
      settings,
      updateSettings: (patch) => {
        saved.push(patch.agentThinking);
        shell.setState({ settings: { ...shell.getState().settings, ...patch } });
        return Promise.resolve(null);
      },
    });
    act(() => root?.render(<AgentThinking />));
    const sw = () =>
      host.querySelector<HTMLButtonElement>('[data-testid="agent-thinking"] [role="switch"]');
    expect(sw()?.getAttribute('aria-checked')).toBe('true');
    expect(host.textContent).toContain('thinks before it acts');
    act(() => sw()?.click());
    expect(saved).toEqual([false]);
    expect(sw()?.getAttribute('aria-checked')).toBe('false');
    expect(host.textContent).toContain('Off:');
    act(() => sw()?.click());
    expect(saved).toEqual([false, true]);
  });
});
