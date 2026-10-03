import { ToolMeta, WindowKind } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { approvalFor, getToolSpec, TOOL_SPECS, toolsForWindow, undoable } from './tools';

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
