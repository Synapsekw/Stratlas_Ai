// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { defaultSurveySettings } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { volumetricView } from '../report/volumetric/editorView';
import { bridge } from '../shell';
import { ReportsScreen } from './Reports';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest = {
  name: 'Tank farm',
  captures: [],
  layers: [],
  severityModels: [],
} as unknown as ProjectManifest;

const REPLIES: Record<string, unknown> = {
  'report:list': { files: [] },
  'survey:readMeasurements': {
    ok: true,
    file: { version: 1, measurements: [] },
    readOnly: false,
  },
  'survey:readSettings': { ok: true, settings: defaultSurveySettings(), exists: false },
  'survey:readTemplates': { ok: true, project: null, user: { version: 1, templates: [] } },
  'survey:readHaulRuns': { ok: true, runs: [] },
  'survey:readHydroRuns': { ok: true, runs: [] },
};

let host: HTMLDivElement;
let root: Root | undefined;
const original = workspace.getState();

beforeEach(async () => {
  vi.spyOn(bridge, 'call').mockImplementation(((channel: string) =>
    Promise.resolve(
      channel in REPLIES
        ? { ok: true, value: REPLIES[channel] }
        : { ok: false, error: 'not in this test' },
    )) as typeof bridge.call);
  workspace.setState({ project: { id: 'tank', root: 'C:/tank', manifest }, issues: [] } as never);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<ReportsScreen />);
    await Promise.resolve();
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.setState(original, true);
  volumetricView.setState({ openFor: null, taken: {}, pictureError: null });
  REPLIES['survey:readMeasurements'] = NO_MEASUREMENTS;
  vi.restoreAllMocks();
});

const NO_MEASUREMENTS = REPLIES['survey:readMeasurements'];
const stockpile = {
  id: 'm1',
  family: 'polygon',
  tool: 'polygon',
  label: 'SP1',
  scope: 'site',
  points: [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
  ],
  items: [{ from: { kind: 'lowest' }, to: { kind: 'current' } }],
  results: [],
  createdAt: '2026-10-01T00:00:00.000Z',
};

async function remount() {
  act(() => root?.unmount());
  root = createRoot(host);
  await act(async () => {
    root?.render(<ReportsScreen />);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('Reports screen', () => {
  it('says what to export when there is no report to read yet', () => {
    const viewer = host.querySelector('[aria-label="Report viewer"]');
    expect(viewer?.textContent).toBe(
      'No PDF report to read yet. Export the project report or the issue register to make one.',
    );
  });

  it('offers no survey or run section to a project without that data', () => {
    const sections = [...host.querySelectorAll('[data-testid="house-report"] .rep-check')].map(
      (l) => l.textContent,
    );
    expect(sections).toContain('Executive summary');
    for (const name of ['Landfill airspace and compaction', 'Haul-road compliance', 'Hydrology'])
      expect(sections).not.toContain(name);
  });

  it('greys the project report export of a project with no data yet, and says why', () => {
    const exportBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent.startsWith('Export project report PDF'),
    );
    // greyed but focusable, so its reason reaches the tooltip and the screen reader
    expect(exportBtn?.getAttribute('aria-disabled')).toBe('true');
    const reason = exportBtn?.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(reason)?.textContent).toBe('Add data to the project first.');
  });

  it('offers no customer report to a project without stockpile volumes', () => {
    expect(host.querySelector('[data-testid="customer-reports"]')).toBeNull();
  });

  it('offers the volumetric report for stockpile volumes and opens its editor', async () => {
    REPLIES['survey:readMeasurements'] = {
      ok: true,
      file: { version: 1, measurements: [stockpile] },
      readOnly: false,
    };
    await remount();
    const block = host.querySelector('[data-testid="customer-reports"]');
    expect(block?.textContent).toContain('Customer reports');
    expect(block?.textContent).toContain('Volumetric report');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="open-volumetric-report"]')?.click();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="volumetric-editor"]')).not.toBeNull();
    expect(volumetricView.getState().openFor).toBe('tank');
  });
});
