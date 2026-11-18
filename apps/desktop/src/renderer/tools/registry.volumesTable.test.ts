// @vitest-environment jsdom
// The command palette's "Open the volumes table": a registry entry the palette lists and that
// opens Project > Volumes, with no tile on the island and no row in the Tools tab.
import { describe, expect, it } from 'vitest';
import { paletteIndex, registryTools } from '../shell/paletteIndex';
import { workbench } from '../workspace/workbench/workbenchStore';
import { EMPTY_CTX, modeTools, toolsFor, type ToolCtx } from './registry';
import type { ToolSet } from './toolSets';

// the Volumes tools are Earthworks tools (tools by project type): a project that has the set
const ctx = (volumes: boolean, sets: ToolSet[] = ['earthworks']): ToolCtx => ({
  ...EMPTY_CTX,
  sets: new Set(sets),
  data: { ...EMPTY_CTX.data, volumes },
});

describe('the palette entry "Open the volumes table"', () => {
  it('is listed by the palette under Volumes, and opens Project > Volumes', () => {
    const tools = registryTools(ctx(true));
    const table = tools.find((x) => x.id === 'volumes.table');
    expect(table).toMatchObject({
      group: 'Volumes',
      label: 'Open the volumes table',
      available: true,
    });
    const titles = paletteIndex({ tools, groups: [], tabs: [], settingsPages: [] }).map(
      (c) => c.title,
    );
    expect(titles).toContain('Volumes: Open the volumes table');
    table?.start();
    expect(workbench.getState().front).toBe('volumes');
  });

  it('says why when the project has no pile or volume measurement', () => {
    const table = registryTools(ctx(false)).find((x) => x.id === 'volumes.table');
    expect(table?.available).toEqual({ reason: 'Needs a pile or a volume measurement' });
  });

  it('is part of a project only with Earthworks, and so is Draw volume', () => {
    // a telecom project: neither is listed, in the palette or the Tools tab
    const telecom = ctx(false, ['telecom']);
    const ids = registryTools(telecom).map((x) => x.id);
    expect(ids).not.toContain('volumes.table');
    expect(ids).not.toContain('volumes.draw');
    expect(toolsFor(telecom).map((g) => g.group)).not.toContain('volumes');
    // Earthworks, before the first pile: Draw volume is offered, and the table says why not yet
    const fresh = ctx(false);
    expect(toolsFor(fresh).flatMap((g) => g.tools.map((d) => d.id))).toContain('volumes.draw');
    expect(registryTools(fresh).map((x) => x.id)).toEqual(
      expect.arrayContaining(['volumes.draw', 'volumes.table']),
    );
  });

  it('has no tile on the island and no row in the Tools tab', () => {
    expect(modeTools('volumes').map((d) => d.id)).not.toContain('volumes.table');
    const rows = toolsFor(ctx(true)).flatMap((g) => g.tools.map((d) => d.id));
    expect(rows).toContain('volumes.draw');
    expect(rows).not.toContain('volumes.table');
  });
});
