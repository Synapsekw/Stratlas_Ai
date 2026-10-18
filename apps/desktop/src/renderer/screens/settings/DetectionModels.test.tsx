// @vitest-environment jsdom
import type { DetectorModelCard, DetectorModelInfo } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  models: [] as unknown[],
  answers: new Map<string, (req: unknown) => unknown>(),
}));

vi.mock('../../shell', () => ({
  bridge: {
    call: (channel: string, req: unknown) => {
      const a = h.answers.get(channel);
      return Promise.resolve(
        a ? { ok: true, value: a(req) } : { ok: false, error: `no ${channel}` },
      );
    },
  },
  useCall: () => ({
    ok: true,
    value: { runtime: { available: true, provider: 'cpu', version: '1.22.0' }, models: h.models },
  }),
  shell: { getState: () => ({ updateSettings: vi.fn() }) },
  useShell: (sel: (s: object) => unknown) => sel({ settings: { inference: {} } }),
}));

import { TIP_DELAY_MS } from '@aio/ui';
import { DetectionModels } from './DetectionModels';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card = (name: string, licence: string): DetectorModelCard => ({
  schema: 'aio.detector/1',
  name,
  version: '1.0.0',
  layout: 'yolo-v8',
  input: { width: 640, height: 640 },
  classes: ['helmet', 'vest'],
  licence,
  source: 'Trained in house',
  sha256: 'a'.repeat(64),
});
const model = (
  id: string,
  licence: string,
  licenceWarning?: DetectorModelInfo['licenceWarning'],
): DetectorModelInfo => ({
  id,
  card: card(id, licence),
  where: 'user',
  sizeBytes: 19_000_000,
  ...(licenceWarning ? { licenceWarning } : {}),
});

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  h.models = [];
  h.answers.clear();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const all = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function mount() {
  root = createRoot(host);
  await act(async () => {
    root?.render(<DetectionModels />);
    await Promise.resolve();
  });
}

describe('Settings, Detection models', () => {
  it('shows a licence warning chip on an AGPL model and none on an MIT one', async () => {
    h.models = [model('ppe', 'AGPL-3.0', 'copyleft'), model('markers', 'MIT')];
    await mount();
    const rows = all('infer-model');
    expect(rows).toHaveLength(2);
    const chip = rows[0]?.querySelector<HTMLElement>('[data-testid="infer-licence-warning"]');
    expect(chip?.textContent).toBe('AGPL-3.0 · internal use');
    expect(chip?.getAttribute('data-kind')).toBe('copyleft');
    expect(chip?.className).toContain('warn');
    // its note is the tooltip, opened from the keyboard too
    vi.useFakeTimers();
    try {
      act(() => {
        chip?.focus();
      });
      act(() => {
        vi.advanceTimersByTime(TIP_DELAY_MS);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'AGPL-3.0 is copyleft: fine for internal use, check before you sell or hand out this app.',
    );
    expect(rows[1]?.querySelector('[data-testid="infer-licence-warning"]')).toBeNull();
    // the card's licence string is shown as written
    expect(rows[0]?.querySelector('[data-testid="infer-licence"]')?.textContent).toContain(
      'Licence: AGPL-3.0',
    );
  });

  it('words each kind of warning', async () => {
    h.models = [model('nc', 'CC-BY-NC-4.0', 'non-commercial'), model('odd', 'Odd-1.0', 'unknown')];
    await mount();
    expect(all('infer-licence-warning').map((c) => c.textContent)).toEqual([
      'CC-BY-NC-4.0 · internal use',
      'Odd-1.0 · check its terms',
    ]);
  });

  it('after importing a copyleft model, says it imported with the warning', async () => {
    h.answers.set('dialog:openFile', () => ({ path: 'E:\\models\\ppe\\model.onnx' }));
    h.answers.set('inference:importModel', () => ({
      ok: true,
      model: model('PPE detector', 'AGPL-3.0', 'copyleft'),
    }));
    await mount();
    act(() => {
      q('infer-accept')?.click();
    });
    await act(async () => {
      q('infer-import')?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(q('infer-import-done')?.textContent).toBe(
      'PPE detector imported. AGPL-3.0 is copyleft: fine for internal use, check before you sell or hand out this app.',
    );
  });

  it('after importing an MIT model, says only that it imported', async () => {
    h.answers.set('dialog:openFile', () => ({ path: 'E:\\models\\m\\model.onnx' }));
    h.answers.set('inference:importModel', () => ({
      ok: true,
      model: model('Markers', 'MIT'),
    }));
    await mount();
    act(() => {
      q('infer-accept')?.click();
    });
    await act(async () => {
      q('infer-import')?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(q('infer-import-done')?.textContent).toBe('Imported Markers.');
  });
});
