// @vitest-environment jsdom
import type { LibraryEntry, SetupStatus } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Shell from '../shell';
import { setupProgress, setupRows, SetupStrip, welcomeShape } from './FirstStart';

type ShellModule = typeof Shell;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const status: SetupStatus = {
  dataRoot: 'D:\\data',
  dataRootExists: true,
  mapPacks: 0,
  pipeline: { found: false },
};

vi.mock('../shell', async (importOriginal) => {
  const real = await importOriginal<ShellModule>();
  return { ...real, useCall: () => ({ ok: true, value: status }) };
});

const entry = (id: string, demo: boolean): LibraryEntry => ({
  id,
  name: id,
  path: `D:\\data\\projects\\${id}`,
  kind: 'native',
  ...(demo ? { demo: { primary: id === 'tank' } } : {}),
});

describe('welcomeShape', () => {
  it('shows the whole welcome while only the demos are there and nothing is open', () => {
    expect(welcomeShape([entry('tank', true), entry('road', true)], false)).toBe('card');
  });

  it('collapses to the setup strip when a project exists', () => {
    // one of your own in the library
    expect(welcomeShape([entry('tank', true), entry('north-yard', false)], false)).toBe('strip');
    // or a project open, the demo included
    expect(welcomeShape([entry('tank', true)], true)).toBe('strip');
  });

  it('shows nothing on an empty or unread library', () => {
    expect(welcomeShape([], false)).toBeNull();
    expect(welcomeShape(null, false)).toBeNull();
  });
});

describe('setupProgress', () => {
  it('counts the ready lines', () => {
    // data folder ready, no map pack, no tools, the network always fine
    expect(setupProgress(setupRows(status, true))).toEqual({ done: 2, total: 4 });
  });
});

describe('SetupStrip', () => {
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

  it('is one line, "Workstation setup 2 of 4", that opens the checklist in place', () => {
    act(() => root?.render(<SetupStrip />));
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="setup-strip-toggle"]');
    expect(toggle?.textContent).toContain('Workstation setup 2 of 4');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[data-testid="setup-checklist"]')).toBeNull();
    act(() => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('[data-testid="setup-checklist"] .setup-row')).toHaveLength(4);
  });
});
