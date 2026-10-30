import { describe, expect, it } from 'vitest';
import { TAB_IDS } from '../workspace/workbench/tabsModel';
import {
  applyPreset,
  BANDS,
  bandOf,
  clampRight,
  NO_DATA,
  PANEL_TABS,
  PRESETS,
  projectData,
  PURPOSES,
  purposeOf,
  reachable,
  sectionDef,
  sectionFor,
  sectionsOf,
  stripFor,
  toolSections,
  waitingGroups,
  type ProjectData,
} from './model';

const SURVEY_WITH_VIDEO: ProjectData = {
  ...NO_DATA,
  video: true,
  pointcloud: true,
  mesh: true,
  raster: true,
  dates2: true,
  piles: true,
};
const ROAD_WITH_PILES: ProjectData = {
  ...NO_DATA,
  raster: true,
  photos: true,
  road: true,
  piles: true,
};
const BARE: ProjectData = { ...NO_DATA, photos: true };

describe('bands', () => {
  it('follows the D1 table at the band edges', () => {
    expect(bandOf(1920)).toBe('wide');
    expect(bandOf(1440)).toBe('wide');
    expect(bandOf(1439)).toBe('mid');
    expect(bandOf(1280)).toBe('mid');
    expect(bandOf(1279)).toBe('narrow');
    expect(bandOf(1100)).toBe('narrow');
    expect(BANDS.wide).toMatchObject({ layers: 'open', rightPx: 360, stripPx: 160 });
    expect(BANDS.mid).toMatchObject({ layers: 'collapsed', rightPx: 320, stripPx: 140 });
    expect(BANDS.narrow).toMatchObject({ layers: 'overlay', rightPx: 300, stripPx: 120 });
  });

  it('keeps a dragged width inside the band', () => {
    expect(clampRight('narrow', 900)).toBe(400);
    expect(clampRight('narrow', 100)).toBe(280);
    expect(clampRight('wide', 410.4)).toBe(410);
  });
});

describe('four tabs', () => {
  it('every one of the 20 old ids maps to a tab and a section that exists', () => {
    expect(TAB_IDS).toHaveLength(20);
    for (const id of TAB_IDS) {
      const { tab, section } = sectionFor(id);
      expect(PANEL_TABS).toContain(tab);
      expect(sectionDef(section)?.tab, id).toBe(tab);
    }
  });

  it('sections appear for the data, never for the type', () => {
    const tools = sectionsOf('tools', BARE).map((s) => s.id);
    expect(tools).not.toContain('tools.video');
    expect(sectionsOf('tools', { ...BARE, video: true }).map((s) => s.id)).toContain('tools.video');
    expect(waitingGroups(BARE)).toContain('video');
  });
});

describe('presets', () => {
  it('every purpose has a preset', () => {
    for (const p of PURPOSES) expect(PRESETS[p]).toBeDefined();
  });

  it('a project without purpose falls back by type', () => {
    expect(purposeOf({ type: 'volumetric' })).toBe('survey');
    expect(purposeOf({ type: 'road' })).toBe('road');
    expect(purposeOf({ type: 'inspection' })).toBe('vertical-asset');
    expect(purposeOf({ type: 'fusion' })).toBe('data-fusion');
    expect(purposeOf({ type: 'twin' })).toBe('data-fusion');
    expect(purposeOf({ type: 'fusion', purpose: 'telecom' })).toBe('telecom');
  });

  it('reachable tools are the same for every preset', () => {
    for (const data of [SURVEY_WITH_VIDEO, ROAD_WITH_PILES, BARE]) {
      const first = [...reachable(PRESETS.survey, data)].sort();
      for (const p of PURPOSES) expect([...reachable(PRESETS[p], data)].sort(), p).toEqual(first);
    }
  });

  it('a survey project with video docks the tile and keeps its own tab', () => {
    const d = applyPreset(PRESETS.survey, SURVEY_WITH_VIDEO);
    expect(d.video).toBe('docked');
    expect(d.tab).toBe('project');
    expect(d.open).toEqual(['project.volumes']);
    expect(d.strip).toBe('volume');
  });

  it('a road project with piles still lists Volumes', () => {
    expect(toolSections(PRESETS.road, ROAD_WITH_PILES).map((s) => s.id)).toContain('tools.volumes');
    expect(applyPreset(PRESETS.road, ROAD_WITH_PILES).strip).toBe('chainage');
  });

  it('falls back when the data cannot honour the strip', () => {
    expect(stripFor(PRESETS.survey, BARE)).toBe('dates');
    expect(stripFor(PRESETS['vertical-asset'], BARE)).toBe('dates');
    expect(stripFor(PRESETS.road, BARE)).toBe('dates');
    expect(applyPreset(PRESETS.road, BARE).islandMode).toBe('view');
  });

  it('reads the data from the manifest', () => {
    const d = projectData(
      {
        layers: [{ kind: 'video' }, { kind: 'pointcloud' }] as never,
        captures: [
          { id: 'a', date: '2026-01-01' },
          { id: 'b', date: '2026-02-01' },
        ] as never,
      },
      { piles: false, road: false },
    );
    expect(d).toMatchObject({ video: true, pointcloud: true, dates2: true, mesh: false });
  });
});
