import { assemble, stackModel } from '@aio/modelling';
import { describe, expect, it, vi } from 'vitest';
import { buildComponentsPanel, checkNotes, rebuildFor, type ReviewHandlers } from './reviewPanel';

const handlers = (): ReviewHandlers => ({
  onSelect: vi.fn(),
  onToggle: vi.fn(),
  onStatus: vi.fn(),
  onRemove: vi.fn(),
  onAdd: vi.fn(),
  onField: vi.fn(),
  onFocus: vi.fn(),
  onSourceVisible: vi.fn(),
  onModelVisible: vi.fn(),
  onRebuild: vi.fn(),
});

const ui = {
  selected: 'flue-1',
  hidden: ['flue-2'],
  sourceVisible: true,
  modelVisible: false,
  stale: true,
  thumbnails: { 'img-photo-a': 'data:image/png;base64,AA' },
};

const clean = {
  validatorErrors: 0,
  validatorWarnings: 0,
  messages: [],
  finite: true,
  indicesValid: true,
  normalsUnit: true,
  degenerate: 0,
  duplicateTris: 0,
  unintendedHoles: [],
  intendedOpenOk: true,
  openingProblems: [],
  triangles: 1000,
  withinBudget: true,
};

describe('buildComponentsPanel', () => {
  it('carries the run findings, the view state and the build report, never dropping one', () => {
    const model = stackModel();
    const panel = buildComponentsPanel(
      {
        model,
        build: {
          triangles: 900_000,
          overBudget: true,
          detail: 'fast',
          simplified: [{ id: 'lattice-1', detail: 'fast' }],
          failed: [{ id: 'duct-1', reason: 'bad path' }],
          notes: ['a finer mesh failed'],
        },
        report: {
          ...clean,
          validatorErrors: 2,
          messages: ['accessor 3 is out of range'],
          withinBudget: false,
        },
        conflicts: [{ imageIds: ['img-photo-a'], reason: 'other asset' }],
        unresolved: ['The scale is assumed.'],
        flagged: [{ id: 'flue-3', reason: 'The run now finds two flues.' }],
      },
      ui,
      handlers(),
    );
    expect(panel.unresolved).toEqual([
      'The scale is assumed.',
      'flue-3: The run now finds two flues.',
    ]);
    expect(panel.conflicts).toHaveLength(1);
    expect(panel.hidden).toEqual(['flue-2']);
    expect(panel.modelVisible).toBe(false);
    expect(panel.stale).toBe(true);
    expect(panel.report?.failed).toEqual([{ id: 'duct-1', reason: 'bad path' }]);
    expect(panel.report?.simplified).toEqual([{ id: 'lattice-1', detail: 'fast' }]);
    expect(panel.report?.overBudget).toBe(true);
    expect(panel.report?.notes).toEqual([
      'a finer mesh failed',
      'The file check found 2 errors.',
      'accessor 3 is out of range',
      'The file is over the triangle budget.',
    ]);
  });

  it('has no report before a build, and carries the scale record', () => {
    const model = { ...stackModel(), scale: { status: 'provisional' as const } };
    const panel = buildComponentsPanel(
      { model, build: null, report: null, conflicts: [], unresolved: [], flagged: [] },
      ui,
      handlers(),
    );
    expect(panel.report).toBeNull();
    expect(panel.scale).toEqual({ status: 'provisional' });
    expect(checkNotes(null)).toEqual([]);
    expect(checkNotes(clean)).toEqual([]);
  });

  it('turns an edit into a rebuild with the person values, keeping what they entered before', () => {
    const model = stackModel();
    const o = rebuildFor(model, { id: 'flue-2', key: 'rOuter', value: 1.1 });
    expect(o.params['flue-2']).toEqual({ rOuter: 1.1 });
    expect(rebuildFor(model, { remove: 'flue-3' }).removed).toEqual(['flue-3']);
    expect(typeof assemble).toBe('function');
  });
});
