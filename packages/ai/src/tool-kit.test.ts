import { createWorkspace } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { fixtureIssue, fixtureManifest, fixtureWorkspace } from './test-fixtures';
import {
  appHooks,
  compareCodes,
  issueClass,
  issueClasses,
  registerAppHooks,
  ToolError,
  worstFirst,
  type RendererToolContext,
} from './tool-kit';

function ctx(ws = fixtureWorkspace()): RendererToolContext {
  return {
    workspace: ws,
    window: 'issues',
    scene: () => null,
    fetchJson: () => Promise.resolve(null),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2026-10-05T12:00:00Z'),
  };
}

describe('the order of findings', () => {
  it('orders codes by prefix, then by number', () => {
    expect(['F10', 'F2', 'D9', 'F05', 'AG01'].sort(compareCodes)).toEqual([
      'AG01',
      'D9',
      'F2',
      'F05',
      'F10',
    ]);
    expect(compareCodes('F05', 'F05')).toBe(0);
    expect(compareCodes('F2', 'F10')).toBeLessThan(0);
  });

  it('puts the worst first, uncertain last, and one level in code order', () => {
    const issues = [
      fixtureIssue({ code: 'F10', severity: 4 }),
      fixtureIssue({ code: 'A01', severity: 'uncertain' }),
      fixtureIssue({ code: 'F2', severity: 4 }),
      fixtureIssue({ code: 'B03', severity: 5 }),
      fixtureIssue({ code: 'C01', severity: 1 }),
    ];
    expect(issues.sort(worstFirst).map((i) => i.code)).toEqual(['B03', 'F2', 'F10', 'C01', 'A01']);
  });
});

describe('issue classes', () => {
  it('finds a class by its id or its label, whatever the case of the label', () => {
    const c = ctx();
    expect(issueClasses(c).map((k) => k.id)).toEqual(['corrosion', 'coating']);
    expect(issueClass(c, 'coating').label).toBe('Coating damage');
    expect(issueClass(c, 'Coating damage').id).toBe('coating');
    expect(issueClass(c, 'coating DAMAGE').id).toBe('coating');
  });

  it('lists the classes for one that is not there, or not given', () => {
    const said =
      "Choose classId from this project's classes: corrosion (Corrosion), coating (Coating damage).";
    expect(() => issueClass(ctx(), 'rust')).toThrow(new ToolError(said));
    expect(() => issueClass(ctx(), undefined)).toThrow(new ToolError(said));
  });

  it('says so in a project without classes', () => {
    const ws = createWorkspace();
    ws.getState().openProject(
      { id: 'p1', root: 'E:/x', manifest: { ...fixtureManifest(), classCatalogues: [] } },
      [],
    );
    const said =
      'This project has no issue classes yet. Propose one with propose_class; a person confirms it.';
    expect(() => issueClasses(ctx(ws))).toThrow(new ToolError(said));
    expect(() => issueClass(ctx(ws), 'corrosion')).toThrow(new ToolError(said));
  });
});

describe('registerAppHooks', () => {
  it('registers the screen hook, removes it on unregister and merges later hooks', () => {
    const off = registerAppHooks({ screen: () => 'inspect' });
    expect(appHooks.screen?.()).toBe('inspect');

    const openScreen = (): void => undefined;
    const offOpen = registerAppHooks({ openScreen });
    expect(appHooks.screen?.()).toBe('inspect');
    expect(appHooks.openScreen).toBe(openScreen);

    off();
    expect(appHooks.screen).toBeUndefined();
    expect(appHooks.openScreen).toBe(openScreen);

    offOpen();
    expect(appHooks.openScreen).toBeUndefined();
  });

  it('takes the filter, evidence and view hooks', () => {
    const off = registerAppHooks({
      showPhotos: () => ({ shown: 1, total: 2, severity: 3, severityLabel: 'High' }),
      showIssues: () => ({ shown: 4 }),
      showEvidence: () => true,
      captureView: () => () => undefined,
      viewFilters: () => ({
        photos: { onlyFindings: false, order: 'file', severity: null, scope: null },
        issues: {
          severity: 'uncertain',
          classId: null,
          status: null,
          text: '',
          sort: 'code',
          scope: null,
        },
      }),
    });
    expect(appHooks.showPhotos?.({ severity: 'highest' }).shown).toBe(1);
    expect(appHooks.showIssues?.({}).shown).toBe(4);
    expect(appHooks.showEvidence?.('i1')).toBe(true);
    expect(appHooks.viewFilters?.().issues.severity).toBe('uncertain');
    off();
    expect(appHooks.showPhotos).toBeUndefined();
  });
});
