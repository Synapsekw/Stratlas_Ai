// @vitest-environment jsdom
import { ProjectPurpose, ProjectType } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from '../survey/measureCatalogue';
import {
  availability,
  EMPTY_CTX,
  islandModes,
  ISLAND_MODES,
  measureToolId,
  MODE_DEFS,
  modeTools,
  TOOL_GROUPS,
  TOOLS,
  toolsFor,
  topTools,
  type ToolCtx,
} from './registry';
import { toolCtxOf, type ToolCtxInput } from './useToolCtx';

/** The tiles the island's quick rows had before the registry, by what they did. */
const ISLAND_TILES = [
  'view.wholeSite',
  'view.centre',
  'view.flyTo',
  'view.skyTime',
  'view.seeInside',
  'view.compare',
  'view.timeline',
  'view.askAi',
  'view.issuePins',
  'view.streetMap',
  'measure.distance',
  'measure.elevation',
  'measure.area',
  'measure.volume',
  'measure.section-plane',
  'pointcloud.show',
  'pointcloud.cleanUp',
  'volumes.swipe',
  'volumes.section',
  'video.window',
  'video.telemetry',
  'road.closeup',
  'road.pci',
  'road.density',
  'road.measure',
  'annotate.open',
  'annotate.point',
  'annotate.polyline',
  'annotate.polygon',
  'annotate.cloud-point',
  'annotate.cloud-box',
  'annotate.map.point',
  'annotate.map.line',
  'annotate.map.polygon',
];

const layer = (kind: string, id = kind) => ({ id, kind, name: id, uri: `${id}.bin` });

const input = (over: Partial<ToolCtxInput> = {}): ToolCtxInput => ({
  ...EMPTY_CTX,
  manifest: { layers: [] },
  dated: false,
  volumes: false,
  road: false,
  ...over,
});

/** Every tool's availability, by id. */
const offer = (ctx: ToolCtx) =>
  Object.fromEntries(
    toolsFor(ctx).flatMap((g) => g.tools.map((d) => [d.id, availability(d, ctx)])),
  );

describe('one tool registry', () => {
  it('every catalogue tool and island quick-row tool is registered once', () => {
    const ids = TOOLS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of ALL_TOOLS) expect(ids).toContain(measureToolId(e.tool));
    for (const id of ISLAND_TILES) expect(ids).toContain(id);
    // each in a known group, with a name and an icon
    for (const d of TOOLS) {
      expect(TOOL_GROUPS).toContain(d.group);
      expect(d.labelKey.length).toBeGreaterThan(0);
      expect(d.icon.length).toBeGreaterThan(0);
    }
  });

  it('availability depends on data, never on purpose', () => {
    // the same layers and view, every project type and purpose: the same tools, the same reasons
    const layers = [layer('pointcloud'), layer('video'), layer('photos')] as never;
    const view = { stage3d: true, measuresReady: true };
    const base = offer(toolCtxOf(input({ ...view, manifest: { layers } })));
    for (const purpose of ProjectPurpose.options) {
      const m = { layers, purpose, type: 'inspection' } as never;
      expect(offer(toolCtxOf(input({ ...view, manifest: m })))).toEqual(base);
    }
    for (const type of ProjectType.options) {
      const m = { layers, type } as never;
      expect(offer(toolCtxOf(input({ ...view, manifest: m })))).toEqual(base);
    }
    // the telecom tools are offered with a point cloud, whatever the project is for
    expect(base['measure.azimuth']).toBe(true);
  });

  it('order puts preset groups first and keeps the rest', () => {
    const ctx = toolCtxOf(
      input({ manifest: { layers: [layer('pointcloud'), layer('video')] as never } }),
    );
    const plain = toolsFor(ctx).map((g) => g.group);
    expect(plain.slice(0, 3)).toEqual(['view', 'measure', 'annotate']);
    const led = toolsFor(ctx, ['video', 'pointcloud', 'video']).map((g) => g.group);
    expect(led.slice(0, 2)).toEqual(['video', 'pointcloud']);
    // nothing is removed or doubled
    expect([...led].sort()).toEqual([...plain].sort());
    // a group with no data is not offered, led or not
    expect(toolsFor(ctx, ['road']).map((g) => g.group)).not.toContain('road');
  });

  it('a tool that cannot start here says why, and stays listed', () => {
    const ctx = toolCtxOf(input());
    const ids = toolsFor(ctx).flatMap((g) => g.tools.map((d) => d.id));
    expect(ids).toContain('measure.section-plane');
    const section = TOOLS.find((d) => d.id === 'measure.section-plane');
    if (!section) throw new Error('no section plane');
    expect(availability(section, ctx)).toEqual({ reason: 'palette.unavailable.needs3d' });
  });

  it('a project package keeps only the tools that do not write', () => {
    const ctx = toolCtxOf(input({ pkg: true, readOnly: true, stage3d: true }));
    const area = TOOLS.find((d) => d.id === 'measure.area');
    const distance = TOOLS.find((d) => d.id === 'measure.distance');
    if (!area || !distance) throw new Error('missing');
    expect(availability(area, ctx)).not.toBe(true);
    expect(availability(distance, ctx)).toBe(true);
  });
});

describe("the island's modes", () => {
  it('labelled modes in one order: Road only with a road, off the 3D view', () => {
    const plain = toolCtxOf(input());
    expect(islandModes(plain).map((m) => m.id)).toEqual(['view', 'measure', 'annotate']);
    const all = toolCtxOf(
      input({
        manifest: { layers: [layer('video')] as never },
        dated: true,
        volumes: true,
        road: true,
        mode: 'map',
        tools: 'map',
      }),
    );
    expect(islandModes(all).map((m) => m.id)).toEqual([...ISLAND_MODES]);
    expect(islandModes({ ...all, mode: '3d', tools: '3d' }).map((m) => m.id)).not.toContain('road');
  });

  it('every mode can say why it cannot be picked', () => {
    for (const m of ISLAND_MODES) expect(MODE_DEFS[m].available(EMPTY_CTX)).toBe(true);
  });

  it('a mode shows its top tools: favourites, then recent, those that start here first', () => {
    const ctx = toolCtxOf(input({ stage3d: true }));
    const top = topTools('measure', ctx, ['measure.grade', 'measure.distance']).map((d) => d.id);
    expect(top).toHaveLength(5);
    expect(top.slice(0, 2)).toEqual(['measure.grade', 'measure.distance']);
    // View on the map: the 3D tools step back behind those that work there
    const map = toolCtxOf(input({ mode: 'map', tools: 'map' }));
    const view = topTools('view', map).map((d) => d.id);
    expect(view).not.toContain('view.skyTime');
    expect(view).toContain('view.wholeSite');
  });

  it("Compare's tools are the dates' tools, each registered in its own group", () => {
    expect(modeTools('compare').map((d) => d.id)).toEqual([
      'view.compare',
      'view.timeline',
      'volumes.swipe',
    ]);
  });
});
