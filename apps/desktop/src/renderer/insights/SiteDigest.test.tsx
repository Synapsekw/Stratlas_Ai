// @vitest-environment jsdom
import { changeStore } from '@aio/change';
import {
  emptyMeasurements,
  type ChangeSetSummary,
  type ProjectManifest,
  type SurveyQa,
} from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareStore } from '../survey/compareStore';
import { measureStore } from '../survey/measureStore';
import { qaStore } from '../survey/qaStore';
import { SiteDigest } from './SiteDigest';

const runs = vi.hoisted(() => ({
  actions: [] as unknown[],
  focus: [] as unknown[],
  notes: [] as string[],
  found: true,
}));
vi.mock('./runInsight', () => ({
  runInsightAction: (a: unknown) => {
    runs.actions.push(a);
    return true;
  },
  focusInsight: (i: { id: string }) => {
    runs.focus.push(i.id);
    return runs.found;
  },
}));
vi.mock('../shell/actions/toastHost', () => ({
  toastHost: () => ({ note: (text: string) => runs.notes.push(text) }),
}));
vi.mock('../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false, error: 'none' }) },
  jobs: { getState: () => ({ jobs: [] }), subscribe: () => () => undefined },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest = {
  // a working copy: the project's id is not its manifest's
  id: 'p1-manifest',
  origin: [0, 0, 0],
  captures: [
    { id: 'm1', label: 'July', date: '2026-07-01' },
    { id: 'm2', label: 'August', date: '2026-08-01' },
  ],
} as unknown as ProjectManifest;

const qa = (capture: string, status: SurveyQa['status']): SurveyQa => ({
  schema: 'aio.survey-qa/1',
  capture,
  level: 'moderate',
  status,
  checkedAt: '2026-10-01T00:00:00.000Z',
});

const summary = (open: number, i = 0): ChangeSetSummary => ({
  id: `m1-m2-p${i}`,
  from: 'm1',
  to: 'm2',
  producer: `p${i}`,
  createdAt: '2026-10-01T00:00:00.000Z',
  items: open,
  open,
});

let host: HTMLDivElement;
let root: Root | undefined;

function render(): void {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<SiteDigest />);
  });
}
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const lines = () =>
  [...host.querySelectorAll<HTMLElement>('[data-testid="site-digest-item"] .sd-line')].map((e) =>
    e.textContent.replace(/^.*?: /, ''),
  );

beforeEach(() => {
  runs.actions.length = 0;
  runs.focus.length = 0;
  runs.notes.length = 0;
  runs.found = true;
  workspace.setState({ project: { id: 'p1', root: 'C:/p1', manifest } } as never);
  qaStore.setState({ projectId: 'p1', qa: {}, loadedFor: 'p1' });
  measureStore.setState({ projectId: 'p1', file: emptyMeasurements() });
  changeStore.setState({ projectId: 'p1', summaries: [], sets: {} });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host.remove();
});

describe('SiteDigest', () => {
  it('is not shown on a project with one survey date', () => {
    workspace.setState({
      project: {
        id: 'p1',
        root: 'C:/p1',
        manifest: { ...manifest, captures: [manifest.captures[0]] },
      },
    } as never);
    render();
    expect(q('site-digest')).toBeNull();
  });

  it('waits for the QA files of the open project', () => {
    qaStore.setState({ loadedFor: 'other' });
    render();
    expect(q('site-digest')).toBeNull();
  });

  it('says so when nothing needs a look', () => {
    qaStore.setState({
      qa: {
        m2: {
          ...qa('m2', 'pass'),
          checkpoints: { count: 3, rmseM: 0.02, meanM: 0, maxAbsM: 0.03, points: [] },
        },
      },
    });
    render();
    expect(q('site-digest-clear')?.textContent).toBe(
      'Nothing needs a look on this site right now.',
    );
  });

  it('follows the stores: a QA verdict and a change set landing show at once', () => {
    render();
    expect(lines()).toEqual(['Survey of 1 Aug 2026 has not been checked yet']);
    act(() => {
      qaStore.setState({ qa: { m2: qa('m2', 'hold') } });
      changeStore.setState({ summaries: [summary(2)] });
    });
    expect(lines()).toEqual([
      'Survey of 1 Aug 2026 is on hold after a failed QA check',
      '2 changes from 1 Jul 2026 to 1 Aug 2026 to review',
    ]);
    const held = host.querySelector('[data-rule="survey-held"]');
    expect(held?.getAttribute('data-severity')).toBe('critical');
    expect(held?.textContent).toContain('Needs action');
  });

  it('runs an action, and shows the evidence on a click on the line', () => {
    changeStore.setState({ summaries: [summary(1)] });
    render();
    const review = host.querySelector<HTMLElement>('[data-rule="change-review"]');
    act(() => {
      review
        ?.querySelector<HTMLElement>('[data-testid="site-digest-action-insights.openChanges"]')
        ?.click();
    });
    expect(runs.actions).toEqual([{ id: 'insights.openChanges', pair: { from: 'm1', to: 'm2' } }]);
    act(() => {
      review?.querySelector<HTMLElement>('.sd-line')?.click();
    });
    expect(runs.focus).toEqual(['change-review:m1>m2']);
  });

  it('says so when the evidence of a line is gone', () => {
    changeStore.setState({ summaries: [summary(1)] });
    runs.found = false;
    render();
    act(() => {
      host.querySelector<HTMLElement>('[data-rule="change-review"] .sd-line')?.click();
    });
    expect(runs.notes).toEqual(['That item is no longer in the project.']);
  });

  it('folds a long list to four lines, with pile figures in the site units', () => {
    qaStore.setState({ qa: { m2: qa('m2', 'hold') } });
    changeStore.setState({ summaries: [summary(1)] });
    compareStore.setState({ captures: manifest.captures, current: {} });
    const row = (toCapture: string, netM3: number) => ({
      item: 'v',
      status: 'ok',
      cutM3: 0,
      fillM3: netM3,
      netM3,
      totalM3: netM3,
      areaM2: 1,
      areaCutM2: 0,
      areaFillM2: 1,
      areaUnchangedM2: 0,
      uncoveredM2: 0,
      fromLabel: 'Base',
      toLabel: toCapture,
      toCapture,
      deadbandM: 0,
      usedDeadband: false,
      cellM: 0.5,
      engine: 'ts',
      fingerprint: `v-${toCapture}`,
      computedAt: '2026-10-01T00:00:00.000Z',
    });
    measureStore.setState({
      file: {
        ...emptyMeasurements(),
        measurements: ['a', 'b', 'c'].map((id) => ({
          id,
          family: 'polygon',
          tool: 'volume',
          label: id,
          scope: { kind: 'site' },
          points: [[0, 0, 0]],
          items: [
            {
              id: 'v',
              from: { kind: 'lowest-point' },
              to: { kind: 'current' },
              useDeadband: false,
            },
          ],
          results: [row('m2', 150)],
          series: [row('m1', 100), row('m2', 150)],
          createdAt: '2026-07-01T00:00:00.000Z',
        })) as never,
      },
    });
    render();
    expect(lines()).toHaveLength(4);
    expect(q('site-digest-count')?.textContent).toContain('5 insights');
    const more = host.querySelector<HTMLElement>('.sd-more');
    expect(more?.textContent).toBe('Show 1 more');
    act(() => {
      more?.click();
    });
    expect(lines()).toHaveLength(5);
    expect(lines()).toContain('a grew 50.0 m³ (50%) since 1 Jul 2026');
  });
});
