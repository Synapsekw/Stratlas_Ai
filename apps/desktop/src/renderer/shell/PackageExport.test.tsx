// @vitest-environment jsdom
import type { PackagePlan } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const app = {
  rasterPacks: undefined as PackagePlan['rasterPacks'],
  sent: [] as { channel: string; payload: unknown }[],
};

const basePlan = {
  layers: [],
  baseBytes: 10,
  totalBytes: 10,
  totalFiles: 1,
} as unknown as PackagePlan;

function answer(channel: string, payload: unknown): unknown {
  app.sent.push({ channel, payload });
  if (channel === 'package:plan')
    return {
      ok: true,
      value: {
        ok: true,
        plan: { ...basePlan, ...(app.rasterPacks ? { rasterPacks: app.rasterPacks } : {}) },
      },
    };
  if (channel === 'package:export') return { ok: true, value: { ok: true, path: null } };
  return { ok: false, error: 'none' };
}

vi.mock('@aio/workspace', () => {
  const state = () => ({ project: { id: 'p1', manifest: { name: 'Quarry' } } });
  return {
    useWorkspace: (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
  };
});
vi.mock('../shell', () => ({
  bridge: {
    call: (channel: string, payload: unknown) => Promise.resolve(answer(channel, payload)),
  },
  shell: { getState: () => ({ setExportFor: () => undefined }) },
  useShell: (selector: (s: { exportFor: string }) => unknown) => selector({ exportFor: 'p1' }),
}));
vi.mock('@aio/ui', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useFocusTrap: () => undefined,
}));

import { PackageExportDialog } from './PackageExport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IMAGERY = {
  kind: 'imagery',
  id: 'ortho-a',
  label: 'Regional ortho',
  licence: 'Provider terms 2026',
  attribution: 'Provider',
  customerLicence: true,
  ok: true,
  bytes: 2048,
  tiles: 12,
  maxZoom: 17,
} as const;
const TERRAIN = {
  kind: 'terrain',
  id: 'dem-a',
  label: 'National DEM',
  licence: 'Open',
  attribution: 'Agency',
  customerLicence: false,
  ok: false,
  reason: 'Does not cover this site.',
} as const;

let host: HTMLDivElement;
let root: Root | undefined;
const flush = () => act(() => Promise.resolve());
beforeEach(() => {
  app.sent = [];
  (window as unknown as { aio: object }).aio = { on: () => () => undefined };
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
});
async function open() {
  root = createRoot(host);
  await act(() => {
    root?.render(<PackageExportDialog />);
    return Promise.resolve();
  });
  await flush();
}
const planCalls = () => app.sent.filter((s) => s.channel === 'package:plan');

describe('PackageExport imagery and terrain', () => {
  it('lists a customer pack unticked with the licence reminder, and a refused pack without a checkbox', async () => {
    app.rasterPacks = [IMAGERY, TERRAIN];
    await open();
    const section = host.querySelector('[data-testid="pkg-raster"]');
    expect(section?.textContent).toContain('Imagery and terrain');
    const box = host.querySelector<HTMLInputElement>('[data-testid="pkg-raster-imagery-ortho-a"]');
    expect(box?.checked).toBe(false);
    expect(section?.textContent).toContain('Provider terms 2026');
    expect(section?.textContent).toContain('Does not cover this site.');
    expect(host.querySelector('[data-testid="pkg-raster-terrain-dem-a"]')).toBeNull();
  });

  it('asks for a new plan and exports with the ticked pack', async () => {
    app.rasterPacks = [IMAGERY, TERRAIN];
    await open();
    const box = host.querySelector<HTMLInputElement>('[data-testid="pkg-raster-imagery-ortho-a"]');
    await act(() => {
      box?.click();
      return Promise.resolve();
    });
    await flush();
    expect(planCalls().at(-1)?.payload).toMatchObject({
      rasterPacks: [{ kind: 'imagery', id: 'ortho-a' }],
    });
    await act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="pkg-export"]')?.click();
      return Promise.resolve();
    });
    const exp = app.sent.find((s) => s.channel === 'package:export');
    expect(exp?.payload).toMatchObject({
      options: { rasterPacks: [{ kind: 'imagery', id: 'ortho-a' }] },
    });
  });

  it('says so when no pack covers the site', async () => {
    app.rasterPacks = [];
    await open();
    expect(host.querySelector('[data-testid="pkg-raster"]')?.textContent).toContain(
      'No installed imagery or terrain pack covers this site.',
    );
  });
});
