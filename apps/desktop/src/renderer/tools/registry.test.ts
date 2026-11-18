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
  stageModeAvailable,
  TOOL_GROUPS,
  TOOLS,
  toolsFor,
  toolsShown,
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
  'volumes.draw',
  'volumes.swipe',
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
  flightlines: false,
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

  describe('what is offered follows the project (founder, 18 Nov 2026)', () => {
    const layers = [layer('pointcloud'), layer('mesh'), layer('video'), layer('photos')] as never;
    const view = { stage3d: true, measuresReady: true };
    const ctxFor = (m: object, over: Partial<ToolCtxInput> = {}) =>
      toolCtxOf(input({ ...view, manifest: { layers, ...m }, ...over }));
    const groupsOf = (ctx: ToolCtx) => toolsFor(ctx).map((g) => g.group);

    it('a mesh alone does not show Coverage, photos alone do not show Thermal', () => {
      const confined = ctxFor({ purpose: 'confined-space', type: 'inspection' });
      expect(groupsOf(confined)).toEqual([
        'view',
        'measure',
        'annotate',
        'pointcloud',
        'terrain',
        'video',
        'engineering',
        'environment',
      ]);
      // no telecom measuring tool in a confined space project
      const ids = Object.keys(offer(confined));
      expect(ids.filter((id) => /azimuth|antenna-tilt|clearance/.test(id))).toEqual([]);
      expect(ids).toContain('measure.distance');
    });

    it('each project type brings its own groups', () => {
      const of = (purpose: string) => groupsOf(ctxFor({ purpose }));
      expect(of('telecom')).toContain('coverage');
      expect(of('telecom')).not.toContain('thermal');
      expect(of('vertical-asset')).toContain('thermal');
      expect(of('vertical-asset')).not.toContain('coverage');
      expect(of('survey')).toContain('checks');
      expect(of('road')).not.toContain('checks');
      // Terrain analysis and Engineering are in every project
      for (const purpose of ProjectPurpose.options) {
        expect(of(purpose)).toContain('terrain');
        expect(of(purpose)).toContain('engineering');
      }
      expect(of('data-fusion')).toEqual(expect.arrayContaining(['checks', 'coverage', 'thermal']));
      // the telecom tools start in a telecom project with a 3D view
      expect(offer(ctxFor({ purpose: 'telecom' }))['measure.azimuth']).toBe(true);
    });

    it('an older project follows what its type stands for', () => {
      const byType: Record<ProjectType, boolean> = {
        volumetric: false,
        road: false,
        inspection: true,
        fusion: true,
        twin: true,
      };
      for (const type of ProjectType.options)
        expect(groupsOf(ctxFor({ type })).includes('thermal'), type).toBe(byType[type]);
    });

    it('a set that is on still needs its data', () => {
      const bare = toolCtxOf(input({ ...view, manifest: { layers: [], purpose: 'telecom' } }));
      expect(groupsOf(bare)).not.toContain('coverage');
      // its measuring family has no data test: it is there, and says why a tool cannot start
      expect(Object.keys(offer(bare))).toContain('measure.azimuth');
    });

    it('records and the list a person chose bring a set into any project', () => {
      const held = { earthworks: false, road: false, telecom: true, thermal: false };
      const withAntennas = ctxFor({ purpose: 'survey' }, { held });
      expect(groupsOf(withAntennas)).toContain('coverage');
      expect(Object.keys(offer(withAntennas))).toContain('measure.azimuth');
      const chosen = ctxFor({ purpose: 'survey', toolSets: ['thermal'] });
      expect(groupsOf(chosen)).toContain('thermal');
      expect(groupsOf(chosen)).not.toContain('checks');
    });

    it('the palette list is the tools that are part of the project', () => {
      const ids = (m: object) => toolsShown(ctxFor(m)).map((d) => d.id);
      expect(ids({ purpose: 'data-fusion' })).toEqual(TOOLS.map((d) => d.id));
      expect(ids({ purpose: 'confined-space' })).not.toContain('measure.azimuth');
      expect(ids({ purpose: 'confined-space' })).toContain('view.compare');
      // the kit's swipe is an Earthworks tool: it comes with the kit, in any project
      expect(ids({ purpose: 'confined-space' })).not.toContain('volumes.swipe');
    });
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

describe('Tools > Volumes after the finalization (18 Nov 2026)', () => {
  const ids = modeTools('volumes').map((d) => d.id);

  it('keeps only what acts on the view: Draw volume and Swipe', () => {
    expect(ids).toEqual(['volumes.draw', 'volumes.swipe']);
    // the Table tile (the list is Project > Volumes) and the kit section line are gone; the
    // palette alone keeps "Open the volumes table" (`registry.volumesTable.test.ts`)
    expect(TOOLS.find((d) => d.id === 'volumes.table')?.paletteOnly).toBe(true);
    expect(TOOLS.map((d) => d.id)).not.toContain('volumes.section');
  });

  it('Draw volume starts wherever a measurement can be saved, as Measure > Volume', () => {
    const draw = TOOLS.find((d) => d.id === 'volumes.draw');
    const measure = TOOLS.find((d) => d.id === 'measure.volume');
    if (!draw || !measure) throw new Error('missing');
    for (const ctx of [
      toolCtxOf(input()),
      toolCtxOf(input({ readOnly: true })),
      toolCtxOf(input({ pkg: true, readOnly: true })),
    ])
      expect(availability(draw, ctx)).toEqual(availability(measure, ctx));
    expect(availability(draw, toolCtxOf(input()))).toBe(true);
  });

  it("Swipe's greyed-out reason is true: an older stockpile project, two dates, in 3D", () => {
    const swipe = TOOLS.find((d) => d.id === 'volumes.swipe');
    if (!swipe) throw new Error('no swipe');
    const in3d = { stage3d: true };
    // a project with piles but no stockpile kit: the kit and its two dates are what is missing
    expect(availability(swipe, toolCtxOf(input({ ...in3d, volumes: true })))).toEqual({
      reason: 'toolReg.reason.needsKit',
    });
    expect(availability(swipe, { ...toolCtxOf(input(in3d)), kit: true, kitDates: 1 })).toEqual({
      reason: 'toolReg.reason.needsKit',
    });
    // the kit with two dates, on the map: it needs the 3D view
    expect(
      availability(swipe, {
        ...toolCtxOf(input({ mode: 'map', tools: 'map' })),
        kit: true,
        kitDates: 2,
      }),
    ).toEqual({ reason: 'palette.unavailable.needs3d' });
    expect(availability(swipe, { ...toolCtxOf(input(in3d)), kit: true, kitDates: 2 })).toBe(true);
  });
});

describe("the island's modes", () => {
  it('labelled modes in one order: Road only with a road, off the 3D view', () => {
    const plain = toolCtxOf(input());
    expect(islandModes(plain).map((m) => m.id)).toEqual(['view', 'measure', 'annotate']);
    const all = toolCtxOf(
      input({
        manifest: { layers: [layer('video')] as never, purpose: 'data-fusion' },
        dated: true,
        volumes: true,
        road: true,
        mode: 'map',
        tools: 'map',
      }),
    );
    // a road compares by chainage: no Compare mode, as before the registry
    expect(islandModes(all).map((m) => m.id)).toEqual(ISLAND_MODES.filter((m) => m !== 'compare'));
    expect(islandModes({ ...all, mode: '3d', tools: '3d' }).map((m) => m.id)).not.toContain('road');
    const noRoad = { ...all, data: { ...all.data, road: false } };
    expect(islandModes(noRoad).map((m) => m.id)).toEqual(ISLAND_MODES.filter((m) => m !== 'road'));
    // a mode of a tool set that is not part of the project is not listed
    const noSets = { ...all, sets: new Set<never>() };
    expect(islandModes(noSets).map((m) => m.id)).toEqual(['view', 'measure', 'annotate', 'video']);
    // Volumes comes with Earthworks, before the first pile; Road waits for its road model
    const fresh = toolCtxOf(input({ manifest: { layers: [], purpose: 'data-fusion' } }));
    expect(islandModes(fresh).map((m) => m.id)).toEqual(['view', 'measure', 'annotate', 'volumes']);
  });

  it('every mode can say why it cannot be picked', () => {
    for (const m of ISLAND_MODES) expect(MODE_DEFS[m].available(EMPTY_CTX)).toBe(true);
  });

  it('Map, Split and a mode that needs the map are greyed with a reason without a map', () => {
    const local = toolCtxOf(input({ mapAvailable: false }));
    expect(stageModeAvailable('3d', local)).toBe(true);
    expect(stageModeAvailable('map', local)).toEqual({ reason: 'fly.map.local' });
    expect(stageModeAvailable('split', local)).toEqual({ reason: 'fly.map.local' });
    // a saved split without the map (a photo beside 3D) stays open; Map stays greyed
    const noMapSplit = toolCtxOf(input({ mapAvailable: false, splitHasMap: false }));
    expect(stageModeAvailable('split', noMapSplit)).toBe(true);
    expect(stageModeAvailable('map', noMapSplit)).toEqual({ reason: 'fly.map.local' });
    // a georeferenced project keeps them
    const geo = toolCtxOf(input());
    expect(stageModeAvailable('map', geo)).toBe(true);
    expect(stageModeAvailable('split', geo)).toBe(true);
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

  it('Compare dates follows the stage: greyed with why until it can compare', () => {
    const compare = TOOLS.find((d) => d.id === 'view.compare');
    if (!compare) throw new Error('no compare');
    const dated = toolCtxOf(input({ dated: true }));
    expect(availability(compare, dated)).toEqual({ reason: 'toolReg.reason.needsStage' });
    const off = { available: false, twin: false, label: '', open: () => undefined };
    expect(availability(compare, { ...dated, compare: off })).toEqual({
      reason: 'toolReg.reason.needsDates',
    });
    expect(availability(compare, { ...dated, compare: { ...off, available: true } })).toBe(true);
    // a road has no timeline tool
    const timeline = TOOLS.find((d) => d.id === 'view.timeline');
    if (!timeline) throw new Error('no timeline');
    expect(availability(timeline, toolCtxOf(input({ dated: true, road: true })))).not.toBe(true);
  });
});
