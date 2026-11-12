// @vitest-environment jsdom
import type { BundledAgentStatus, LocalModelSettings } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SHA = 'b'.repeat(64);
const PACK = {
  version: '0.2.0',
  modelId: 'qwen3.5-9b-q4_k_m',
  modelSha256: SHA,
  contextTokens: 16_384,
};
const CHECK = {
  modelSha256: SHA,
  modelId: 'qwen3.5-9b-q4_k_m',
  packVersion: '0.2.0',
  passed: true,
  correct: 12,
  total: 12,
  needed: 10,
  invalidCalls: 0,
  meanLatencyMs: 400,
  checkedAt: '2026-11-12T00:00:00.000Z',
  cases: [],
};

const h = vi.hoisted(() => ({
  settings: { localModel: undefined as LocalModelSettings | undefined, routes: [] as unknown[] },
  status: null as BundledAgentStatus | null,
  updates: [] as Record<string, unknown>[],
  calls: [] as string[],
  checkAnswer: null as Record<string, unknown> | null,
}));

vi.mock('../../shell', () => ({
  useShell: (sel: (s: { settings: typeof h.settings }) => unknown) => sel({ settings: h.settings }),
  useCall: (channel: string) =>
    channel === 'ai:bundledAgent'
      ? { ok: true, value: h.status }
      : { ok: true, value: { present: false } },
  bridge: {
    call: (channel: string) => {
      h.calls.push(channel);
      return Promise.resolve({ ok: true, value: h.checkAnswer });
    },
  },
  shell: {
    getState: () => ({
      updateSettings: (patch: Record<string, unknown>) => {
        h.updates.push(patch);
        Object.assign(h.settings, patch);
        return Promise.resolve(null);
      },
    }),
  },
}));

import { LocalModel } from './LocalModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<LocalModel />);
  });
}
const rerender = () => {
  act(() => {
    root?.render(<LocalModel />);
  });
};
const q = (sel: string) => host?.querySelector(sel) ?? null;
const sourceSelect = () =>
  host?.querySelector<HTMLSelectElement>('select[aria-label="Model to use"]') ?? null;
const offlineSwitch = () =>
  host?.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Use Offline AI for everything"]',
  ) ?? null;
const checkButton = () =>
  [...(host?.querySelectorAll('button') ?? [])].find((b) =>
    b.textContent.includes('Check tool calling'),
  );

beforeEach(() => {
  h.settings = { localModel: undefined, routes: [] };
  h.status = { pack: PACK, check: null, blocked: 'Check first.' };
  h.updates = [];
  h.calls = [];
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
});

describe('Local model: the bundled Analytics model (A3)', () => {
  it('is offered only with a pack installed', () => {
    h.status = { pack: null, check: null, blocked: 'No pack.' };
    mount();
    expect(sourceSelect()).toBeNull();
  });

  it('choosing it saves the compact 16k model of the pack and keeps the own address', async () => {
    h.settings.localModel = {
      enabled: false,
      baseUrl: 'http://localhost:11434/v1',
      model: 'mine',
    };
    mount();
    const select = sourceSelect();
    if (!select) throw new Error('no source select');
    await act(async () => {
      select.value = 'bundled';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(h.updates[0]?.localModel).toEqual({
      enabled: true,
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3.5-9b-q4_k_m',
      source: 'bundled',
      toolProfile: 'compact',
      contextTokens: 16_384,
      capabilities: { tools: false, vision: true },
    });
    rerender();
    expect(q('[data-testid="bundled-model-id"]')?.textContent).toBe(
      'qwen3.5-9b-q4_k_m, Analytics pack 0.2.0, on this computer.',
    );
    // not checked yet: the offline agent switch stays off, the own server's rows are gone
    expect(offlineSwitch()?.disabled).toBe(true);
    expect(q('input[aria-label="Local model address"]')).toBeNull();
    expect(q('[data-testid="bundled-check"]')?.textContent).toBe('Check first.');
  });

  it('Check tool calling runs the check; a pass enables the offline agent switch', async () => {
    h.settings.localModel = {
      enabled: true,
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3.5-9b-q4_k_m',
      source: 'bundled',
    };
    h.checkAnswer = { ok: true, check: CHECK, status: { pack: PACK, check: CHECK, blocked: null } };
    mount();
    expect(offlineSwitch()?.disabled).toBe(true);
    const button = checkButton();
    if (!button) throw new Error('no check button');
    h.status = { pack: PACK, check: CHECK, blocked: null };
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(h.calls).toContain('ai:bundledAgentCheck');
    rerender();
    expect(q('[data-testid="bundled-check"]')?.textContent).toBe(
      'Passed: 12 of 12 right, 0.4 s per request. Offline AI can run on this model.',
    );
    expect(offlineSwitch()?.disabled).toBe(false);
    expect(h.updates.at(-1)?.localModel).toMatchObject({
      capabilities: { tools: true, vision: true },
    });
  });

  it('a failed check shows why, and the switch stays disabled', () => {
    h.settings.localModel = {
      enabled: true,
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3.5-9b-q4_k_m',
      source: 'bundled',
    };
    h.status = {
      pack: PACK,
      check: { ...CHECK, passed: false, correct: 1 },
      blocked: 'The bundled model made the right tool call in 1 of 12 checks (10 needed).',
    };
    mount();
    const line = q('[data-testid="bundled-check"]');
    expect(line?.getAttribute('role')).toBe('alert');
    expect(line?.textContent).toContain('1 of 12 checks');
    expect(offlineSwitch()?.disabled).toBe(true);
  });
});
