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
  shell: { getState: () => ({ pkg: null, go: (s: string) => calls.log.push(['go', s]) }) },
  bridge: { call: () => Promise.resolve({ ok: false, error: 'none' }) },
  jobs: { getState: () => ({ jobs: [] }), subscribe: () => () => undefined },
}));
// the real actions need the whole app; the registry items the digest names stand in for them
vi.mock('../shell/actions', () => ({ registerSidebarActions: () => undefined }));
vi.mock('../shell/actions/toastHost', () => ({
  toastHost: () => ({
    note: (text: string) => calls.log.push(['note', text]),
    renameDate: () => undefined,
    moveLayers: () => undefined,
    askUnplace: () => undefined,
    emptyTrash: () => undefined,
  }),
}));
vi.mock('../telecom/antennaStore', () => ({
  antennaStore: { getState: () => ({ file: { units: [{ id: 'ant-1' }] } }) },
  revealAntenna: (id: string, _b: unknown, ask: string) => calls.log.push(['antenna', id, ask]),
}));
vi.mock('../detections/store', () => ({
  dispatch: (a: { type: string; id: string }) => calls.log.push(['review', a.type, a.id]),
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
    // the menu's own refusal of a date (not lined up, no data)
    submenu: () => [
      { id: 'm2', label: 'August' },
      { id: 'm3', label: 'September', disabled: 'Those dates are not lined up.' },
    ],
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

  it('keeps the menu refusal of a date to compare with, and says why', () => {
    expect(runInsightAction({ id: 'date.compare', pair: { from: 'm1', to: 'm3' } })).toBe(false);
    expect(runInsightAction({ id: 'date.compare', pair: { from: 'm1', to: 'gone' } })).toBe(false);
    expect(calls.log).toEqual([
      ['note', 'Those dates are not lined up.'],
      ['note', 'That item is no longer in the project.'],
    ]);
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

describe('track insights (M2)', () => {
  it('shows an antenna of the live inventory, and refuses one that is gone', () => {
    expect(runInsightAction({ id: 'insights.openAntenna', unit: 'ant-1' })).toBe(true);
    expect(runInsightAction({ id: 'insights.openAntenna', unit: 'ant-9' })).toBe(false);
    expect(focusEvidence({ kind: 'track', id: 't', object: 'antenna', ref: 'ant-1' })).toBe(true);
    expect(calls.log).toEqual([
      ['antenna', 'ant-1', 'review'],
      ['antenna', 'ant-1', 'review'],
    ]);
  });

  it('opens a hot spot on its photo in Inspect', () => {
    expect(
      runInsightAction({ id: 'insights.openHotspot', detection: 'h1', layer: 'th', photo: 'p1' }),
    ).toBe(true);
    expect(calls.log).toEqual([
      ['go', 'inspect'],
      ['review', 'select', 'h1'],
    ]);
    expect(workspace.getState().selection).toMatchObject({ kind: 'photo', id: 'p1', layer: 'th' });
    expect(runInsightAction({ id: 'insights.openHotspot', detection: 'h1' })).toBe(false);
  });
});
