import { changeStore } from '@aio/change';
import type { ProjectManifest } from '@aio/schema';
import { registerActions, defineAction } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { focusEvidence, focusInsight, runInsightAction } from './runInsight';

const calls = vi.hoisted(() => ({
  log: [] as unknown[][],
}));
vi.mock('../shell', () => ({
  shell: { getState: () => ({ pkg: null }) },
  bridge: { call: () => Promise.resolve({ ok: false, error: 'none' }) },
  jobs: { getState: () => ({ jobs: [] }), subscribe: () => () => undefined },
}));
// the real actions need the whole app; the registry items the digest names stand in for them
vi.mock('../shell/actions', () => ({ registerSidebarActions: () => undefined }));
vi.mock('../shell/actions/toastHost', () => ({
  toastHost: () => ({
    note: () => undefined,
    renameDate: () => undefined,
    moveLayers: () => undefined,
    askUnplace: () => undefined,
    emptyTrash: () => undefined,
  }),
}));
vi.mock('../change', () => ({
  openChangesTab: () => calls.log.push(['changesTab']),
}));
vi.mock('../survey/qaStore', () => ({
  openQaPanel: (p: string) => calls.log.push(['qaPanel', p]),
}));
vi.mock('../survey/measureStore', () => ({
  select: (ids: string[]) => calls.log.push(['select', ...ids]),
  revealMeasurement: (id: string) => calls.log.push(['reveal', id]),
}));
vi.mock('../workspace/timeline', () => ({
  timeline: {
    getState: () => ({
      focus: null,
      focusSurvey: (c: string) => calls.log.push(['focus', c]),
    }),
  },
}));

registerActions([
  defineAction<'measurements'>({
    id: 'measure.flyTo',
    label: 'actions.measure.flyTo',
    section: 'edit',
    targets: ['measurements'],
    run: (tg) => {
      calls.log.push(['flyTo', tg.clicked]);
    },
  }),
  defineAction<'date'>({
    id: 'date.compare',
    label: 'tree.dates.menu.compare',
    section: 'compare',
    targets: ['date'],
    run: (d, _ctx, sub) => {
      calls.log.push(['compare', d.captureId, sub]);
    },
  }),
]);

beforeEach(() => {
  calls.log.length = 0;
  workspace.setState({
    project: {
      id: 'p1',
      root: 'C:/p1',
      manifest: { id: 'p1', captures: [], layers: [] } as unknown as ProjectManifest,
    },
  } as never);
  changeStore.setState({
    pair: null,
    summaries: [
      { id: 's1', from: 'm1', to: 'm2', producer: 'issues', createdAt: '', items: 1, open: 1 },
    ],
  });
});

describe('runInsightAction', () => {
  it('runs the registry item on the target the insight names', () => {
    expect(runInsightAction({ id: 'measure.flyTo', measurement: 'a' })).toBe(true);
    expect(runInsightAction({ id: 'date.compare', pair: { from: 'm1', to: 'm2' } })).toBe(true);
    expect(calls.log).toEqual([
      ['flyTo', 'a'],
      ['compare', 'm1', 'm2'],
    ]);
  });

  it('opens Survey QA on the date and Changes on the pair', () => {
    runInsightAction({ id: 'insights.openQa', capture: 'm2' });
    runInsightAction({ id: 'insights.openChanges', pair: { from: 'm1', to: 'm2' } });
    expect(calls.log).toEqual([['focus', 'm2'], ['qaPanel', 'qa'], ['changesTab']]);
    expect(changeStore.getState().pair).toEqual({ from: 'm1', to: 'm2' });
  });

  it('refuses an action without its target', () => {
    expect(runInsightAction({ id: 'measure.flyTo' })).toBe(false);
    expect(runInsightAction({ id: 'insights.openQa' })).toBe(false);
  });
});

describe('focusEvidence', () => {
  it('shows a measurement in the list, a date, and a change set on its pair', () => {
    focusEvidence({ kind: 'measurement', id: 'a' });
    focusEvidence({ kind: 'capture', id: 'm1' });
    focusEvidence({ kind: 'changeSet', id: 's1' });
    expect(calls.log).toEqual([['select', 'a'], ['reveal', 'a'], ['focus', 'm1'], ['changesTab']]);
    expect(focusEvidence({ kind: 'changeSet', id: 'gone' })).toBe(false);
  });

  it('takes an insight to its first evidence that can be shown', () => {
    focusInsight({
      id: 'x',
      rule: 'change-review',
      severity: 'info',
      text: { key: 'insights.changeReview', params: {} },
      evidence: [
        { kind: 'changeSet', id: 'gone' },
        { kind: 'qa', capture: 'm2' },
      ],
      actions: [],
    });
    expect(calls.log).toEqual([
      ['focus', 'm2'],
      ['qaPanel', 'qa'],
    ]);
  });
});
