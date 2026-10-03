import { existsSync, readFileSync } from 'node:fs';
import { Issue } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  classIdFromLabel,
  importHclFindings,
  importKitAnnotations,
  kitFrameToLocal,
  kitSeverityModel,
  clientScaleModel,
} from './import';
import { validateIssue } from './model/ops';

const NOW = '2026-10-03T10:00:00.000Z';
const ASSETS = 'E:/Dev/AIO Software/docs/design/assets';

const hclMini = {
  photos: [
    {
      file: 'photos/F01_109_0256.jpg',
      finding_id: 'F01',
      title: 'Crack in bottom plate',
      severity: 5,
      class: 'Crack',
      area: 'Bottom plate',
      description: 'A crack.',
      report_page: 7,
      location: { pos_m: [1.165, 0.035, -0.38] },
      photo: { camera_pos_m: [1.178, 0.42, -0.095], view_dir: [0, -1, 0], size_px: [1280, 960] },
    },
  ],
};

const kitMini = {
  legend_mask_values: {
    '1': { class: 'Light staining', colour: '#fad34b' },
    '2': { class: 'Moderate rust', colour: '#ff7a2d' },
    '4': { class: 'Uncertain / heat affected', colour: '#b68ef8' },
  },
  photos: [
    {
      photo_id: 'p024',
      files: {
        photo: 'ebsm/p024.jpg',
        mask_labels: 'ebsm/p024_mask.png',
        overlay: 'ebsm/p024_overlay.png',
      },
      size_px: [1600, 1068],
      findings: [
        {
          finding_id: 'F04',
          severity: '2',
          class: '',
          component: 'Flare neck',
          zone: 'Flare head',
          note: 'Rust on fasteners.',
        },
      ],
      boxes: [
        { class_value: 2, class: 'Moderate rust', pixels: 500, bbox: [10, 20, 110, 70] },
        { class_value: 1, class: 'Light staining', pixels: 100, bbox: [0, 0, 5, 5] },
        { class_value: 4, class: 'Uncertain / heat affected', pixels: 900, bbox: [0, 0, 50, 50] },
      ],
    },
    {
      photo_id: 'p044',
      files: { photo: 'ebsm/p044.jpg', mask_labels: 'ebsm/p044_mask.png' },
      size_px: [1600, 1068],
      findings: [{ finding_id: 'F31', severity: '', class: 'Light staining', note: '' }],
      boxes: [{ class_value: 1, class: 'Light staining', pixels: 10, bbox: [1, 1, 3, 3] }],
    },
  ],
};

describe('frames and ids', () => {
  it('converts the kit frame (X north, Z east) to the local frame (X east, Z south)', () => {
    expect(kitFrameToLocal([1, 2, 3])).toEqual([3, 2, -1]);
  });

  it('slugs class labels', () => {
    expect(classIdFromLabel('Uncertain / heat affected')).toBe('uncertain-heat-affected');
  });
});

describe('importHclFindings', () => {
  const ctxFor = () => ({ models: [clientScaleModel('hcl-1-5')], catalogues: [] });

  it('makes one issue per finding with a mesh pin and the photo', () => {
    const r = importHclFindings(hclMini, {
      now: NOW,
      severityModelId: 'hcl-1-5',
      meshLayer: 'tank',
      photoLayer: 'photos',
    });
    const issue = r.issues[0];
    expect(issue).toMatchObject({
      code: 'F01',
      classId: 'crack',
      severity: 5,
      status: 'approved',
      source: 'import',
      title: 'Crack in bottom plate',
    });
    expect(issue?.sightings[0]).toMatchObject({
      on: 'mesh',
      layer: 'tank',
      geom: { type: 'spoint', p: [-0.38, 0.035, -1.165] },
    });
    expect(issue?.sightings[1]).toMatchObject({
      on: 'image',
      layer: 'photos',
      photo: 'F01_109_0256',
    });
    expect(r.catalogue.classes).toEqual([
      expect.objectContaining({ id: 'crack', label: 'Crack', severityModel: 'hcl-1-5' }),
    ]);
    if (issue) expect(validateIssue(issue, ctxFor()).ok).toBe(true);
  });

  it.skipIf(!existsSync(`${ASSETS}/hcl/findings.json`))('imports the real HCl findings', () => {
    const json: unknown = JSON.parse(readFileSync(`${ASSETS}/hcl/findings.json`, 'utf8'));
    const r = importHclFindings(json, {
      now: NOW,
      severityModelId: 'hcl-1-5',
      meshLayer: 'tank',
      photoLayer: 'photos',
    });
    expect(r.issues.map((i) => i.code)).toEqual(['F01', 'F02', 'F04', 'F05', 'F06', 'F09']);
    for (const i of r.issues) {
      expect(Issue.safeParse(i).success).toBe(true);
      expect(validateIssue(i, ctxFor()).ok).toBe(true);
    }
  });
});

describe('importKitAnnotations', () => {
  const opts = { now: NOW, severityModelId: 'kit', photoLayer: 'photos' };

  it('builds issues with box and mask sightings', () => {
    const r = importKitAnnotations(kitMini, opts);
    expect(r.issues).toHaveLength(2);
    const f04 = r.issues[0];
    expect(f04).toMatchObject({ code: 'F04', classId: 'moderate-rust', severity: 2 });
    expect(f04?.title).toBe('Moderate rust, Flare neck');
    expect(f04?.sightings).toEqual([
      {
        on: 'image',
        layer: 'photos',
        photo: 'p024',
        geom: { type: 'mask', src: { path: 'photos/p024_mask.png' } },
      },
      {
        on: 'image',
        layer: 'photos',
        photo: 'p024',
        geom: { type: 'box', x: 10, y: 20, w: 100, h: 50 },
      },
      {
        on: 'image',
        layer: 'photos',
        photo: 'p024',
        geom: { type: 'box', x: 0, y: 0, w: 5, h: 5 },
      },
    ]);
    expect(r.issues[1]).toMatchObject({
      code: 'F31',
      severity: 'uncertain',
      classId: 'light-staining',
    });
  });

  it('turns the legend into a class catalogue', () => {
    const r = importKitAnnotations(kitMini, opts);
    expect(r.catalogue.classes.map((c) => [c.id, c.color, c.hotkey])).toEqual([
      ['light-staining', '#fad34b', '1'],
      ['moderate-rust', '#ff7a2d', '2'],
      ['uncertain-heat-affected', '#b68ef8', '4'],
    ]);
  });

  for (const set of ['ebsm', 'damac']) {
    it.skipIf(!existsSync(`${ASSETS}/${set}/annotations.json`))(
      `imports the real ${set} set`,
      () => {
        const json: unknown = JSON.parse(readFileSync(`${ASSETS}/${set}/annotations.json`, 'utf8'));
        const r = importKitAnnotations(json, opts);
        expect(r.issues.length).toBeGreaterThan(0);
        const ctx = { models: [kitSeverityModel('kit')], catalogues: [r.catalogue] };
        for (const i of r.issues) {
          const v = validateIssue(i, ctx);
          expect(v.ok ? 'ok' : v.error).toBe('ok');
        }
        expect(new Set(r.issues.map((i) => i.code)).size).toBe(r.issues.length);
      },
    );
  }

  it('rejects input that is not a kit file', () => {
    expect(() => importKitAnnotations({ nope: 1 }, opts)).toThrow('kit annotations');
    expect(() => importHclFindings([], { ...opts, meshLayer: 'm' })).toThrow('findings');
  });
});
