// @vitest-environment jsdom
import type { WebsiteUpdateStatus } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridge, shell } from '../shell';
import { websiteUpdates } from './session';
import { WebsiteUpdatesPanel, WebsiteUpdateNotice } from './WebsiteUpdates';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const status: WebsiteUpdateStatus = {
  accountEmail: null,
  phase: 'signed-out',
  currentAppVersion: '0.24.0',
  currentPipelineVersion: '0.19.0',
  app: null,
  pipeline: null,
  error: null,
  restartAvailable: false,
  restartReason: null,
  recoveryAvailable: false,
  unsupportedReason: null,
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  shell.setState({
    settings: { ...shell.getState().settings, offlineOnly: false, websiteAutoUpdate: true },
  });
  websiteUpdates.setState({ status, busy: false, error: null });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
});
async function render() {
  await act(async () => {
    root.render(
      <>
        <WebsiteUpdatesPanel />
        <WebsiteUpdateNotice />
      </>,
    );
    await Promise.resolve();
  });
}
async function fill(selector: string, value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>(selector);
    if (input) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await Promise.resolve();
  });
}
describe('website updates interface', () => {
  it('clears the sign-in password after a failed request and shows recovery guidance', async () => {
    vi.spyOn(bridge, 'call').mockResolvedValue({
      ok: true,
      value: { ok: false, error: 'Check your email and password.' },
    });
    await render();
    await fill('input[type=email]', 'engineer@example.test');
    await fill('input[type=password]', 'secret');
    await act(async () => {
      host
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(host.querySelector<HTMLInputElement>('input[type=password]')?.value).toBe('');
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Check your email');
    expect(JSON.stringify(websiteUpdates.getState())).not.toContain('secret');
  });
  it('blocks sign-in and automatic network actions in offline-only mode', async () => {
    shell.setState({ settings: { ...shell.getState().settings, offlineOnly: true } });
    await render();
    expect(host.querySelector<HTMLInputElement>('input[type=password]')?.disabled).toBe(true);
    expect(
      [...host.querySelectorAll('button')].find((b) => b.textContent.includes('Sign in'))?.disabled,
    ).toBe(true);
    expect(host.textContent).toContain('Offline-only');
  });
  it('hydrates progress on mount, exposes verified ready details, and opens About from the global notice', async () => {
    websiteUpdates.setState({
      status: {
        ...status,
        accountEmail: 'engineer@example.test',
        phase: 'downloading',
        app: {
          version: '0.25.0',
          notes: 'A new capability',
          received: 50,
          total: 100,
          verified: false,
        },
      },
    });
    await render();
    expect(host.querySelector('progress')?.getAttribute('value')).toBe('50');
    expect(host.querySelector('[data-testid=website-update-ready]')).toBeNull();
    await act(async () => {
      const current = websiteUpdates.getState().status;
      if (!current) throw new Error('Missing update status');
      websiteUpdates.setState({
        status: {
          ...current,
          phase: 'ready',
          restartAvailable: true,
        },
      });
      await Promise.resolve();
    });
    const notice = host.querySelector<HTMLButtonElement>('[data-testid=website-update-ready]');
    expect(notice).not.toBeNull();
    await act(async () => {
      notice?.click();
      await Promise.resolve();
    });
    expect(shell.getState().settingsPage).toBe('about');
    expect(shell.getState().screen).toBe('settings');
    expect(
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Restart and update')
        ?.disabled,
    ).toBe(false);
  });
});
