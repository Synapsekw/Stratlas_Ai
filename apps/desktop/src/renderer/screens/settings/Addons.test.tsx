// @vitest-environment jsdom
import { ADDON_SCHEMA, type AddonListResponse, type AddonStatus } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let list: AddonListResponse;
const patches: unknown[] = [];

vi.mock('../../shell', () => ({
  useShell: (sel: (s: { settings: { dataRoot: string } }) => unknown) =>
    sel({ settings: { dataRoot: 'D:/data' } }),
  shell: {
    getState: () => ({
      updateSettings: (patch: unknown) => {
        patches.push(patch);
        return Promise.resolve(null);
      },
    }),
  },
  bridge: {
    call: (channel: string) => {
      calls.push(channel);
      if (channel === 'addons:list') return Promise.resolve({ ok: true, value: list });
      return Promise.resolve({ ok: false, error: channel });
    },
  },
}));

const { Addons } = await import('./Addons');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const SHA = 'c'.repeat(64);
const MB = 1024 * 1024;
const ground: AddonStatus = {
  id: 'ground-classifier',
  kind: 'point-classifier',
  installed: null,
  available: {
    manifest: {
      schema: ADDON_SCHEMA,
      id: 'ground-classifier',
      name: 'Ground classifier',
      version: '1.0.0',
      kind: 'point-classifier',
      licence: 'BSD-3-Clause',
      source: 'https://example.org',
      sizeBytes: 1,
      files: [{ path: 'classifier.json', sizeBytes: 1, sha256: SHA }],
    },
    archive: { url: 'g.aioaddon', sizeBytes: 2 * MB, sha256: SHA },
  },
  update: false,
};

let host: HTMLDivElement;
let root: Root | undefined;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
beforeEach(() => {
  calls.length = 0;
  patches.length = 0;
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
});
const render = async () => {
  root = createRoot(host);
  await act(async () => {
    root?.render(<Addons />);
    await Promise.resolve();
  });
};

describe('Settings, Add-ons', () => {
  it('shows each add-on with its licence and the download size before a download', async () => {
    list = {
      baseUrl: 'https://addons.example.org/',
      addons: [
        ground,
        { id: 'segmentation', kind: 'segmenter', installed: null, available: null, update: false },
      ],
    };
    await render();
    expect(calls).toContain('addons:list');
    expect(q('addon-ground-classifier-download')?.textContent).toBe('Download (2.0 MB)');
    expect(q('addon-ground-classifier-facts')?.textContent).toContain('Licence BSD-3-Clause');
    expect(q('addon-segmentation')?.textContent).toContain('Segmentation');
    expect(q('addon-segmentation-download')).toBeNull();
    expect(q('addons-catalogue')).toBeNull();
    expect(q('addons-choose')).not.toBeNull();
  });

  it('says when downloads are not set up, and shows a row problem', async () => {
    list = {
      baseUrl: null,
      addons: [{ ...ground, available: null, problem: 'Needs pack 0.35.0.' }],
    };
    await render();
    expect(q('addons-catalogue')?.textContent).toBe(
      'Downloads are not set up on this computer. Choose an add-on file instead.',
    );
    expect(q('addon-ground-classifier-problem')?.textContent).toBe('Needs pack 0.35.0.');
  });

  it('saves the add-on address on leaving the field, and refuses one that is not a web address', async () => {
    list = { baseUrl: null, addons: [ground] };
    await render();
    const input = q('addons-address') as HTMLInputElement;
    const type = async (v: string) => {
      await act(async () => {
        // React tracks the value: set it through the prototype's setter, as typing does
        Reflect.set(HTMLInputElement.prototype, 'value', v, input);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await Promise.resolve();
      });
      await act(async () => {
        input.focus();
        input.blur();
        await Promise.resolve();
      });
    };
    await type('ftp://nope');
    expect(patches).toEqual([]);
    expect(q('addons-address-error')?.textContent).toContain('must start with https://');
    calls.length = 0;
    await type(' http://127.0.0.1:4747/addons/ ');
    expect(patches).toEqual([{ addons: { baseUrl: 'http://127.0.0.1:4747/addons/' } }]);
    expect(q('addons-address-error')).toBeNull();
    // the list is read again from the new address
    expect(calls).toContain('addons:list');
  });
});
