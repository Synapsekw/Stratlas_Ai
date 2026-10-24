// @vitest-environment jsdom
import type { DetectorModelInfo, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ models: [] as unknown[] }));

vi.mock('../../shell', () => ({
  useCall: () => ({
    ok: true,
    value: { runtime: { available: true, provider: 'cpu', version: '1' }, models: h.models },
  }),
}));

import { askAiPrefs, setAskAiPrefs } from '../../inspect/askAi/prefs';
import { AskAiSettings } from './AskAiSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const model: DetectorModelInfo = {
  id: 'm1',
  card: {
    schema: 'aio.detector/1',
    name: 'Site model',
    version: '1.0.0',
    layout: 'yolo-v8',
    input: { width: 640, height: 640 },
    classes: ['rust', 'crack'],
    licence: 'MIT',
    source: 'In house',
    sha256: 'a'.repeat(64),
    minConfidence: 0.4,
  },
  where: 'user',
  sizeBytes: 1,
};
const manifest = {
  schema: 'aio.project/1',
  id: 'p1',
  name: 'P',
  classCatalogues: [
    {
      id: 'cat',
      name: 'Classes',
      assetType: 'asset',
      classes: [
        { id: 'corrosion', label: 'Corrosion', color: '#f08a3e', severityModel: 'sev' },
        { id: 'spalling', label: 'Spalling', color: '#e5484d', severityModel: 'sev' },
      ],
    },
  ],
} as unknown as ProjectManifest;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<AskAiSettings />);
  });
}
const byId = (id: string) => host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
function pick(id: string, value: string) {
  const el = byId(id) as HTMLSelectElement | null;
  if (!el) throw new Error(id);
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  h.models = [model];
  setAskAiPrefs({
    backend: 'auto',
    localModel: null,
    minConfidence: null,
    tile: { on: false, size: null, overlap: null },
    cloudBatch: 4,
    queueThreshold: 0,
  });
  workspace.setState({ project: { id: 'p1', root: '/p', manifest } });
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
});

describe('AskAiSettings', () => {
  it('saves the backend choice', () => {
    mount();
    act(() => {
      byId('ask-ai-backend-local')?.click();
    });
    expect(askAiPrefs.getState().backend).toBe('local');
    expect((byId('ask-ai-backend-local') as HTMLInputElement | null)?.checked).toBe(true);
  });

  it('shows the stored class map of the open project and saves a change under the old key', () => {
    localStorage.setItem('stratlas.detect.classMap.p1.m1', JSON.stringify({ rust: 'corrosion' }));
    mount();
    expect((byId('ask-ai-class-rust') as HTMLSelectElement | null)?.value).toBe('corrosion');
    pick('ask-ai-class-rust', 'spalling');
    expect(
      JSON.parse(localStorage.getItem('stratlas.detect.classMap.p1.m1') ?? '{}'),
    ).toMatchObject({ rust: 'spalling' });
    expect((byId('ask-ai-class-rust') as HTMLSelectElement | null)?.value).toBe('spalling');
  });

  it('keeps the name when the empty option is picked', () => {
    localStorage.setItem('stratlas.detect.classMap.p1.m1', JSON.stringify({ rust: 'corrosion' }));
    mount();
    pick('ask-ai-class-rust', '');
    expect(
      JSON.parse(localStorage.getItem('stratlas.detect.classMap.p1.m1') ?? '{}'),
    ).toMatchObject({ rust: '' });
  });

  it('defaults the confidence and tile size to the model card', () => {
    mount();
    expect((byId('ask-ai-min-confidence') as HTMLInputElement | null)?.value).toBe('0.4');
    expect((byId('ask-ai-tile-size') as HTMLInputElement | null)?.value).toBe('640');
    expect((byId('ask-ai-tile-overlap') as HTMLInputElement | null)?.value).toBe('128');
    expect((byId('ask-ai-tile-size') as HTMLInputElement | null)?.disabled).toBe(true);
  });

  it('shows the stored values over the card defaults and saves the tiles switch', () => {
    setAskAiPrefs({ minConfidence: 0.6, cloudBatch: 6, queueThreshold: 0.5 });
    mount();
    expect((byId('ask-ai-min-confidence') as HTMLInputElement | null)?.value).toBe('0.6');
    expect((byId('ask-ai-batch') as HTMLInputElement | null)?.value).toBe('6');
    expect((byId('ask-ai-queue-threshold') as HTMLInputElement | null)?.value).toBe('0.5');
    act(() => {
      byId('ask-ai-tile')?.click();
    });
    expect(askAiPrefs.getState().tile.on).toBe(true);
    expect((byId('ask-ai-tile-size') as HTMLInputElement | null)?.disabled).toBe(false);
  });

  it('says to open a project when none is open', () => {
    workspace.setState({ project: null });
    mount();
    expect(byId('ask-ai-class-map')).toBeNull();
    expect(byId('ask-ai-class-map-none')?.textContent).toContain('Open a project');
  });
});
