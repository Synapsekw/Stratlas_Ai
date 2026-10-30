import { rankCommands } from '@aio/ui';
import { describe, expect, it, vi } from 'vitest';
import { paletteIndex, type PaletteIndexInput, type PaletteTool } from './paletteIndex';

const tool = (id: string, label: string, extra: Partial<PaletteTool> = {}): PaletteTool => ({
  id,
  group: 'Measure',
  label,
  icon: 'ruler',
  available: true,
  start: vi.fn(),
  ...extra,
});

const input = (over: Partial<PaletteIndexInput> = {}): PaletteIndexInput => ({
  tools: [
    tool('elevation', 'Elevation'),
    tool('elevation-difference', 'Elevation difference'),
    tool('distance', 'Distance', { shortcutId: 'scene.measure' }),
    tool('grade', 'Grade and slope'),
    tool('area', 'Area'),
    tool('volume', 'Volume'),
    tool('section-plane', 'Section plane', { shortcutId: 'scene.section' }),
  ],
  preferred: ['distance', 'elevation', 'area', 'volume'],
  groups: [
    { id: 'measure', label: 'Measure', icon: 'ruler', tab: 'measure', open: vi.fn() },
    { id: 'display', label: 'Display', icon: 'layers', tab: 'display', open: vi.fn() },
  ],
  tabs: [
    { id: 'measure', label: 'Project', open: vi.fn() },
    { id: 'selection', label: 'Selection', open: vi.fn() },
    { id: 'issues', label: 'Issues', open: vi.fn() },
  ],
  settingsPages: [
    { id: 'ai', label: 'AI providers', open: vi.fn() },
    { id: 'tools', label: 'Processing tools', open: vi.fn() },
    { id: 'keyboard', label: 'Keyboard', open: vi.fn() },
  ],
  shortcutLabel: (id) => ({ 'scene.measure': 'M', 'scene.section': 'X' })[id as string] ?? '',
  ...over,
});

describe('paletteIndex', () => {
  it('measure finds Measure distance, Measure area and the Measure group', () => {
    const titles = rankCommands(paletteIndex(input()), 'measure').map((c) => c.title);
    expect(titles[0]).toBe('Measure: Distance');
    expect(titles.slice(0, 4)).toEqual([
      'Measure: Distance',
      'Measure: Elevation',
      'Measure: Area',
      'Measure: Volume',
    ]);
    expect(titles).toContain('Measure tools');
  });

  it('Enter on the first result for "measure" starts Distance', () => {
    const ctx = input();
    const first = rankCommands(paletteIndex(ctx), 'measure')[0];
    first?.run();
    expect(ctx.tools.find((x) => x.id === 'distance')?.start).toHaveBeenCalledOnce();
  });

  it('each tool shows its shortcut', () => {
    const list = paletteIndex(input());
    expect(list.find((c) => c.title === 'Measure: Distance')?.shortcut).toBe('M');
    expect(list.find((c) => c.title === 'Measure: Section plane')?.shortcut).toBe('X');
    expect(list.find((c) => c.title === 'Measure: Area')?.shortcut).toBeUndefined();
  });

  it('a tool not available says why and stays listed', () => {
    const start = vi.fn();
    const list = paletteIndex(
      input({
        tools: [tool('area', 'Area', { available: { reason: 'Read only here' }, start })],
      }),
    );
    const area = list.find((c) => c.title === 'Measure: Area');
    expect(area).toMatchObject({ hint: 'Read only here', disabled: true });
    area?.run();
    expect(start).not.toHaveBeenCalled();
  });

  it('island groups open their bench', () => {
    const ctx = input();
    const group = paletteIndex(ctx).find((c) => c.title === 'Display tools');
    group?.run();
    expect(ctx.groups[1]?.open).toHaveBeenCalledOnce();
  });

  it('lists tabs a group does not already open', () => {
    const titles = paletteIndex(input()).map((c) => c.title);
    expect(titles).toContain('Go to Selection tab');
    expect(titles).toContain('Go to Issues tab');
    expect(titles).not.toContain('Go to Project tab');
  });

  it('Settings pages are listed, Processing tools keeps its own command', () => {
    const titles = paletteIndex(input()).map((c) => c.title);
    expect(titles).toContain('Settings: AI providers');
    expect(titles).toContain('Settings: Keyboard');
    expect(titles).not.toContain('Settings: Processing tools');
  });
});
