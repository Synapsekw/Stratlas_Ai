// @vitest-environment jsdom
import { ProjectPurpose, type ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { EMPTY_CTX, islandModes, toolsFor, TOOLS, type ToolCtx } from '../tools/registry';
import { applyPreset, gainedChanges, type LayoutOverrides } from './applyPreset';
import { PRESETS, presetFor } from './presets';
import { NO_PROJECT_DATA, panelDataOf, projectData, type ProjectData } from './projectData';

type Kinds = Pick<ProjectManifest, 'layers' | 'captures' | 'type' | 'purpose'>;

const manifest = (over: Partial<Kinds> = {}): Kinds => ({ layers: [], captures: [], ...over });

const data = (over: Partial<ProjectData> = {}): ProjectData => ({ ...NO_PROJECT_DATA, ...over });

/** Three projects: a bare one, a survey site with video and a road, a road with piles. */
const DATA_SETS: Readonly<Record<string, ProjectData>> = {
  bare: data(),
  surveyWithVideoAndRoad: data({
    pointcloud: true,
    ortho: true,
    dsm: true,
    dated: true,
    piles: true,
    video: true,
    road: true,
    photos: true,
  }),
  roadWithPiles: data({ road: true, ortho: true, piles: true, photos: true }),
};

const ctxOf = (d: ProjectData): ToolCtx => ({ ...EMPTY_CTX, data: panelDataOf(d) });

describe('presets', () => {
  it('every purpose has a preset', () => {
    for (const p of ProjectPurpose.options) {
      const preset = PRESETS[p];
      expect(preset, p).toBeDefined();
      expect(
        preset.projectSections.every((s) => s.startsWith('project.')),
        p,
      ).toBe(true);
    }
    expect(Object.keys(PRESETS).sort()).toEqual([...ProjectPurpose.options].sort());
  });

  it('the D7 table: tab, strip, island mode, stage and Layers column per purpose', () => {
    expect(PRESETS.survey).toMatchObject({
      rightTab: 'project',
      strip: 'volume',
      islandMode: 'volumes',
      stage: '3d',
      layersOpenWide: true,
    });
    expect(PRESETS.survey.projectSections.slice(0, 3)).toEqual([
      'project.volumes',
      'project.changes',
      'project.issues',
    ]);
    expect(PRESETS.construction).toMatchObject({ rightTab: 'project', islandMode: 'compare' });
    expect(PRESETS.construction.stage).toBe('map');
    expect(PRESETS['vertical-asset']).toMatchObject({ rightTab: 'selection', strip: 'footage' });
    expect(PRESETS['confined-space']).toMatchObject({ islandMode: 'video', strip: 'footage' });
    expect(PRESETS['data-fusion']).toMatchObject({ rightTab: 'layers', strip: 'dates' });
    expect(PRESETS.road).toMatchObject({
      rightTab: 'project',
      strip: 'chainage',
      islandMode: 'road',
      stage: 'map',
      layersOpenWide: false,
    });
    expect(PRESETS.road.projectSections[0]).toBe('project.road');
    expect(PRESETS.telecom).toMatchObject({ rightTab: 'selection', islandMode: 'measure' });
  });

  it('a project names its purpose: that preset', () => {
    expect(presetFor(manifest({ purpose: 'telecom', type: 'inspection' }))).toBe(PRESETS.telecom);
    expect(presetFor(manifest({ purpose: 'construction', type: 'fusion' }))).toBe(
      PRESETS.construction,
    );
  });

  it('a project without purpose falls back by type', () => {
    expect(presetFor(manifest({ type: 'volumetric' }))).toBe(PRESETS.survey);
    expect(presetFor(manifest({ type: 'road' }))).toBe(PRESETS.road);
    expect(presetFor(manifest({ type: 'inspection' }))).toBe(PRESETS['vertical-asset']);
    expect(presetFor(manifest({ type: 'fusion' }))).toBe(PRESETS['data-fusion']);
    expect(presetFor(manifest({ type: 'twin' }))).toBe(PRESETS['data-fusion']);
    // a purpose a later build wrote reads as none
    expect(presetFor(manifest({ type: 'road', purpose: 'tunnel' }))).toBe(PRESETS.road);
    // neither: the inspection row, today's opening (Selection, View, 3D)
    expect(presetFor(manifest())).toBe(PRESETS['vertical-asset']);
  });

  it('reachable tools are the same for every preset', () => {
    for (const [name, d] of Object.entries(DATA_SETS)) {
      const ctx = ctxOf(d);
      const reach = (order: readonly (typeof PRESETS)['survey']['toolOrder'][number][]) =>
        toolsFor(ctx, order)
          .flatMap((g) => g.tools.map((x) => x.id))
          .sort();
      const modesOn = (stage: '3d' | 'map') =>
        islandModes({ ...ctx, mode: stage, tools: stage }).map((m) => m.id);
      const plain = reach([]);
      for (const [purpose, preset] of Object.entries(PRESETS)) {
        expect(reach(preset.toolOrder), `${name}, ${purpose}`).toEqual(plain);
        // the layout picks only from what the data offers: the island's modes stay the same
        const layout = applyPreset(preset, d, {});
        expect(modesOn(layout.stage), `${name}, ${purpose}: island mode`).toContain(
          layout.islandMode,
        );
      }
      // the palette lists every tool, whatever the preset (each registry tool once)
      expect(new Set(TOOLS.map((x) => x.id)).size).toBe(TOOLS.length);
    }
  });

  it('a preset leads the Tools tab with its groups and keeps every other group', () => {
    const ctx = ctxOf(DATA_SETS.surveyWithVideoAndRoad ?? data());
    const groups = toolsFor(ctx, PRESETS.road.toolOrder).map((g) => g.group);
    expect(groups[0]).toBe('road');
    expect(new Set(groups)).toEqual(new Set(toolsFor(ctx).map((g) => g.group)));
  });
});

describe('projectData', () => {
  it('reads the layer kinds, the dated surveys and what the stores hold', () => {
    const d = projectData(
      manifest({
        layers: [
          { id: 'v', name: 'v', kind: 'video', src: 'a.mp4' },
          { id: 'o', name: 'o', kind: 'raster', role: 'ortho', src: 'o.tif' },
        ] as unknown as Kinds['layers'],
        captures: [
          { id: 'a', date: '2026-01-01' },
          { id: 'b', date: '2026-02-01' },
        ] as unknown as Kinds['captures'],
      }),
      { piles: true, road: false, antennas: false, thermal: false },
    );
    expect(d).toMatchObject({ video: true, ortho: true, dsm: false, dated: true, piles: true });
    expect(d.road).toBe(false);
    expect(panelDataOf(d)).toMatchObject({ video: true, surface: true, volumes: true });
  });
});

describe('applyPreset', () => {
  it('the preset as it is when the data honours it', () => {
    const layout = applyPreset(PRESETS.survey, data({ piles: true, dated: true }), {});
    expect(layout).toMatchObject({
      rightTab: 'project',
      strip: 'volume',
      islandMode: 'volumes',
      stage: '3d',
      layersOpenWide: true,
      videoTile: 'none',
    });
    expect(layout.projectSections[0]).toBe('project.volumes');
  });

  it('volume strip without piles falls back to dates', () => {
    const layout = applyPreset(PRESETS.survey, data({ dated: true }), {});
    expect(layout.strip).toBe('dates');
    // Volumes is no Project section without piles; the island's Volumes mode waits too
    expect(layout.projectSections).not.toContain('project.volumes');
    expect(layout.islandMode).toBe('view');
  });

  it('footage without video falls back to dates', () => {
    expect(applyPreset(PRESETS['vertical-asset'], data(), {}).strip).toBe('dates');
    expect(applyPreset(PRESETS['vertical-asset'], data({ video: true }), {}).strip).toBe('footage');
    // confined space: a walk is footage too
    expect(applyPreset(PRESETS['confined-space'], data({ walks: true }), {}).strip).toBe('footage');
  });

  it('chainage without a road falls back to dates', () => {
    const layout = applyPreset(PRESETS.road, data(), {});
    expect(layout.strip).toBe('dates');
    expect(layout.projectSections).not.toContain('project.road');
    expect(layout.islandMode).toBe('view');
    // the map and the folded Layers column stay: they need no data
    expect(layout.stage).toBe('map');
  });

  it('the video tile follows the data, whatever the preset', () => {
    for (const preset of Object.values(PRESETS)) {
      expect(applyPreset(preset, data({ video: true }), {}).videoTile).toBe('docked');
      expect(applyPreset(preset, data(), {}).videoTile).toBe('none');
    }
  });

  it("the user's changes win", () => {
    const over: LayoutOverrides = {
      rightTab: 'tools',
      strip: 'dates',
      islandMode: 'measure',
      stage: 'map',
      layersOpenWide: false,
      video: 'floating',
    };
    const layout = applyPreset(PRESETS.survey, data({ piles: true, video: true }), over);
    expect(layout).toMatchObject({
      rightTab: 'tools',
      strip: 'dates',
      islandMode: 'measure',
      stage: 'map',
      layersOpenWide: false,
      videoTile: 'floating',
    });
  });

  it('stale overrides are ignored but kept', () => {
    // reopened after its only video went: the saved footage strip and the docked tile wait
    const over: LayoutOverrides = { strip: 'footage', video: 'docked', islandMode: 'video' };
    const saved = structuredClone(over);
    const layout = applyPreset(PRESETS['vertical-asset'], data(), over);
    expect(layout.strip).toBe('dates');
    expect(layout.videoTile).toBe('none');
    expect(layout.islandMode).toBe('view');
    expect(over).toEqual(saved);
    // the video back: the saved choice holds again
    const back = applyPreset(PRESETS['vertical-asset'], data({ video: true }), over);
    expect(back).toMatchObject({ strip: 'footage', videoTile: 'docked', islandMode: 'video' });
  });

  it('adding the first video docks the tile and keeps the tab', () => {
    const preset = PRESETS.survey;
    const over: LayoutOverrides = { rightTab: 'layers' };
    const before = applyPreset(preset, data({ piles: true }), over);
    const after = applyPreset(preset, data({ piles: true, video: true }), over);
    const change = gainedChanges(before, after);
    expect(change.videoTile).toBe('docked');
    // the tab, the island's mode and the stage are applied on open only
    expect(change).not.toHaveProperty('rightTab');
    expect(change).not.toHaveProperty('islandMode');
    expect(change).not.toHaveProperty('stage');
    // nothing gained, nothing to do
    expect(gainedChanges(after, after)).toEqual({});
  });
});
