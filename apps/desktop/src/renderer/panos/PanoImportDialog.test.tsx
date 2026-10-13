// @vitest-environment jsdom
import type { PanoScan } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { importPanos, closePanoImport } = vi.hoisted(() => ({
  importPanos: vi.fn(),
  closePanoImport: vi.fn(),
}));
vi.mock('./panos', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  importPanos,
  closePanoImport,
  maxTextureSize: () => 8192,
}));
vi.mock('../shell', () => ({ bridge: { call: vi.fn() } }));

import { panoImport } from './panos';
import { PanoImportDialog } from './PanoImportDialog';

const scan: PanoScan = {
  scanId: 'scan-1',
  spheres: [
    {
      key: 's1',
      shape: 'sphere',
      files: ['D:/card/a.JPG'],
      frames: 26,
      bytes: 5e8,
      startedAt: '2026-09-10T10:00:00',
      lat: 46.5,
      lon: 7.5,
      relAlt: 70,
      incomplete: false,
    },
    {
      key: 's2',
      shape: 'wide',
      files: ['D:/card/b.JPG'],
      frames: 21,
      bytes: 4e8,
      startedAt: '2026-09-10T10:06:00',
      lat: 46.501,
      lon: 7.501,
      relAlt: 65,
      incomplete: false,
    },
  ],
  ready: [],
  skipped: [{ file: 'D:/card/SYN_0100.JPG', reason: 'few-frames' }],
  files: 48,
  day: '2026-09-10',
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  importPanos.mockResolvedValue(null);
  panoImport.setState({ open: true, scan, busy: null, error: null, notStarted: null });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('PanoImportDialog', () => {
  it('lists the spheres with the summary, the map and the files left out', () => {
    act(() => {
      root.render(<PanoImportDialog />);
    });
    expect(q('pano-summary')?.textContent).toBe(
      '2 panoramas found (26 + 21 frames) · 1 file is not panorama frames · about 858 MB copied',
    );
    expect(q('pano-row-s2')?.textContent).toContain('Wide panorama');
    expect(q('pano-map')?.querySelectorAll('circle')).toHaveLength(2);
    expect(q('pano-skipped')?.textContent).toContain('SYN_0100.JPG');
    expect(q('pano-skipped')?.textContent).toContain('Moving drone or single shot');
    expect((q('pano-name') as HTMLInputElement).value).toBe('Panoramas 10 Sep');
    expect((q('pano-date') as HTMLInputElement).value).toBe('2026-09-10');
    expect(q('pano-quality-high')).toBeNull(); // the GPU takes 8192 px only
  });

  it('imports the checked spheres', async () => {
    act(() => {
      root.render(<PanoImportDialog />);
    });
    const box = q('pano-row-s1')?.querySelector<HTMLInputElement>('input');
    act(() => {
      box?.click();
    });
    await act(() => {
      q('pano-import-go')?.click();
      return Promise.resolve();
    });
    expect(importPanos).toHaveBeenCalledWith({
      keys: ['s2'],
      layerName: 'Panoramas 10 Sep',
      date: '2026-09-10',
      quality: 'standard',
    });
  });

  it('shows the copy progress and cannot import twice', () => {
    panoImport.setState({ busy: { phase: 'copy', done: 10, total: 47 } });
    act(() => {
      root.render(<PanoImportDialog />);
    });
    expect(q('pano-progress')?.textContent).toBe('Copying frames: 10 of 47');
    expect((q('pano-import-go') as HTMLButtonElement).disabled).toBe(true);
  });
});
