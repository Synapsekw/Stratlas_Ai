// @vitest-environment jsdom
import { defaultSurveySettings, type SurveySettings } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ written: null as SurveySettings | null }));
vi.mock('../shell', () => ({
  useShell: (sel: (s: { pkg: null }) => unknown) => sel({ pkg: null }),
  bridge: {
    call: vi.fn((channel: string, args: { settings?: SurveySettings }) => {
      if (channel === 'survey:readSettings') {
        return Promise.resolve({
          ok: true,
          value: { ok: true, settings: defaultSurveySettings(), exists: true, tables: false },
        });
      }
      if (channel === 'survey:writeSettings') {
        calls.written = args.settings ?? null;
        return Promise.resolve({ ok: true, value: { ok: true } });
      }
      if (channel === 'geoidPacks:list') {
        return Promise.resolve({ ok: true, value: { ok: true, packs: [] } });
      }
      if (channel === 'geodesy:readCalibration') {
        return Promise.resolve({ ok: true, value: { ok: true, calibration: null } });
      }
      return Promise.resolve({ ok: true, value: { ok: true, results: [] } });
    }),
  },
}));

import { openSiteSettings, SiteSettingsButton } from './SiteSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const change = (el: HTMLElement | null, v: string) => {
  if (!(el instanceof HTMLSelectElement || el instanceof HTMLInputElement))
    throw new Error('missing control');
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(el, v);
  el.dispatchEvent(
    new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
  );
};

beforeEach(() => {
  calls.written = null;
  workspace.setState({
    project: {
      id: 'p1',
      root: 'C:/p1',
      manifest: { crs: { epsg: 32633 }, origin: [500000, 5000000, 0] },
    },
  } as never);
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  document.body.innerHTML = '';
});

describe('site settings angles', () => {
  it('angles group saves dms bearings', async () => {
    act(() => {
      root.render(<SiteSettingsButton />);
    });
    act(() => {
      openSiteSettings();
    });
    await flush();
    await flush();
    expect((q('[data-testid="site-angle-style"]') as HTMLSelectElement).value).toBe('deg');
    act(() => {
      change(q('[data-testid="site-angle-style"]'), 'dms');
    });
    act(() => {
      change(q('[data-testid="site-bearing-style"]'), 'dms');
    });
    act(() => {
      change(q('[data-testid="site-angle-precision"]'), '1');
    });
    await act(async () => {
      q('[data-testid="site-settings-save"]')?.click();
      await Promise.resolve();
    });
    await flush();
    expect(calls.written?.angles).toEqual({ angle: 'dms', bearing: 'dms', precision: 1 });
  });
});
