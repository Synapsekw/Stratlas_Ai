import { ToolMeta, WindowKind } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  approvalFor,
  COMPACT_TOOLS,
  getToolSpec,
  TOOL_SPECS,
  toolsForWindow,
  undoable,
} from './tools';

describe('tool catalogue', () => {
  it('has valid metadata for every tool', () => {
    for (const spec of TOOL_SPECS) expect(ToolMeta.safeParse(spec.meta).success).toBe(true);
  });

  it('has unique names', () => {
    const names = TOOL_SPECS.map((s) => s.meta.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('ships the initial tools', () => {
    for (const n of [
      'list_layers',
      'list_clips',
      'find_clips_near',
      'set_time',
      'play_clip',
      'fly_to',
      'select',
      'list_issues',
      'create_issue_draft',
      'set_layer_visible',
      'capture_frame',
      'summarize_issues',
    ]) {
      expect(getToolSpec(n), n).toBeDefined();
    }
  });

  it('offers every window at least the read tools', () => {
    for (const w of WindowKind.options) {
      const names = toolsForWindow(w).map((s) => s.meta.name);
      expect(names).toContain('list_issues');
      expect(names).toContain('list_layers');
    }
  });

  it('only offers window tools where they make sense', () => {
    const issues = toolsForWindow('issues').map((s) => s.meta.name);
    expect(issues).not.toContain('set_layer_visible');
    const video = toolsForWindow('video').map((s) => s.meta.name);
    expect(video).toContain('capture_frame');
    expect(video).toContain('play_clip');
  });
});

describe('tool input schemas', () => {
  const parse = (name: string, input: unknown) => {
    const spec = getToolSpec(name);
    if (!spec) throw new Error(`missing ${name}`);
    return spec.input.safeParse(input);
  };

  it('find_clips_near takes an asset, issue or point and a positive radius', () => {
    expect(parse('find_clips_near', { target: { kind: 'asset', id: '20-T-0002' } }).success).toBe(
      true,
    );
    expect(
      parse('find_clips_near', { target: { kind: 'point', p: [1, 2, 3] }, radiusM: 40 }).success,
    ).toBe(true);
    expect(
      parse('find_clips_near', { target: { kind: 'point', p: [1, 2] }, radiusM: 40 }).success,
    ).toBe(false);
    expect(
      parse('find_clips_near', { target: { kind: 'asset', id: 'x' }, radiusM: -1 }).success,
    ).toBe(false);
  });

  it('set_time needs exactly one way to say the time', () => {
    expect(parse('set_time', { iso: '2023-02-21T15:11:26Z' }).success).toBe(true);
    expect(parse('set_time', { utcMs: 1676992286000 }).success).toBe(true);
    expect(parse('set_time', { clipId: 'v1', clipSeconds: 56.4 }).success).toBe(true);
    expect(parse('set_time', {}).success).toBe(false);
    expect(parse('set_time', { iso: 'yesterday' }).success).toBe(false);
  });

  it('create_issue_draft validates severity and title', () => {
    expect(parse('create_issue_draft', { title: 'Corrosion on roof', severity: 3 }).success).toBe(
      true,
    );
    expect(parse('create_issue_draft', { title: '', severity: 3 }).success).toBe(false);
    expect(parse('create_issue_draft', { title: 'x', severity: 'bad' }).success).toBe(false);
    expect(parse('create_issue_draft', { title: 'x', severity: 'uncertain' }).success).toBe(true);
  });

  it('list_issues filters are optional and bounded', () => {
    expect(parse('list_issues', {}).success).toBe(true);
    expect(parse('list_issues', { status: 'draft', severityMin: 3, limit: 20 }).success).toBe(true);
    expect(parse('list_issues', { limit: 5000 }).success).toBe(false);
  });

  it('select accepts a selection or clears it', () => {
    expect(parse('select', { kind: 'asset', id: '20-T-0002' }).success).toBe(true);
    expect(parse('select', { clear: true }).success).toBe(true);
    expect(parse('select', { kind: 'nonsense', id: 'x' }).success).toBe(false);
  });
});

describe('approval policy', () => {
  it('asks before write and send tools and never before read or navigate', () => {
    expect(approvalFor('create_issue_draft')).toBe(true);
    expect(approvalFor('capture_frame')).toBe(true);
    expect(approvalFor('list_issues')).toBe(false);
    expect(approvalFor('fly_to')).toBe(false);
    expect(approvalFor('set_time')).toBe(false);
  });

  it('asks for unknown tools', () => {
    expect(approvalFor('rm_rf')).toBe(true);
  });

  it('marks view changes as undoable', () => {
    for (const n of ['set_time', 'play_clip', 'fly_to', 'select', 'set_layer_visible']) {
      expect(undoable(n), n).toBe(true);
    }
    expect(undoable('list_issues')).toBe(false);
  });
});

describe('compact tool profile (small local models)', () => {
  const names = (w: WindowKind, p: 'full' | 'compact') =>
    toolsForWindow(w, p).map((s) => s.meta.name);

  it('offers a short list with short descriptions in every window', () => {
    for (const w of WindowKind.options) {
      const compact = toolsForWindow(w, 'compact');
      expect(compact.length, w).toBeGreaterThan(3);
      // 13 everyday tools, the four change tools (C1, every window) and the four modelling
      // tools (C5: 3D view, map and point cloud)
      expect(compact.length, w).toBeLessThanOrEqual(21);
      expect(compact.length, w).toBeLessThan(toolsForWindow(w, 'full').length);
      for (const s of compact) {
        expect(s.meta.description.length, s.meta.name).toBeLessThanOrEqual(100);
        expect(s.meta.description, s.meta.name).not.toMatch(/[–—]/);
        expect(COMPACT_TOOLS[s.meta.name], s.meta.name).toBe(s.meta.description);
      }
    }
  });

  it('keeps the camera, issue and layer tools in the 3D view', () => {
    expect(names('scene3d', 'compact')).toEqual(
      expect.arrayContaining([
        'find_places',
        'fly_to',
        'set_view',
        'list_issues',
        'create_issue_draft',
        'list_layers',
        'set_layer_visible',
      ]),
    );
  });

  it('respects the windows a tool belongs to', () => {
    expect(names('issues', 'compact')).not.toContain('set_layer_visible');
    for (const w of WindowKind.options) {
      const full = names(w, 'full');
      for (const n of names(w, 'compact')) expect(full, `${w} ${n}`).toContain(n);
    }
  });

  it('names the change and modelling tools, so they join once registered', () => {
    for (const n of [
      'compare_captures',
      'list_changes',
      'show_change',
      'run_change_detection',
      'propose_model_parts',
      'fit_primitives',
      'edit_model_part',
      'build_model',
    ]) {
      expect(COMPACT_TOOLS[n], n).toBeDefined();
    }
  });

  it('offers the registered change (C1) and modelling (C5) tools by their real names', () => {
    for (const n of [
      'compare_captures',
      'list_changes',
      'show_change',
      'run_change_detection',
      'propose_model_parts',
      'fit_primitives',
      'edit_model_part',
      'build_model',
    ]) {
      expect(getToolSpec(n), n).toBeDefined();
      expect(names('scene3d', 'compact'), n).toContain(n);
    }
  });

  it('keeps the full list and descriptions by default', () => {
    expect(toolsForWindow('scene3d')).toEqual(toolsForWindow('scene3d', 'full'));
    expect(getToolSpec('fly_to')?.meta.description.length).toBeGreaterThan(100);
  });
});
