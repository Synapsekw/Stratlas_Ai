/**
 * The AI's suggestions on Inspect's viewer: dashed, in the AI colour, drawn where the AI put them
 * on the full-size photo whatever grid the draft is stored in, and a Fix edit saved back in that
 * grid.
 */
import type { Detection } from '@aio/annotate/detections';
import { describe, expect, it } from 'vitest';
import { draftIdOf, photoToDraft, suggestionShapes } from './viewerShapes';

const D: Detection = {
  id: 'd1',
  pass: 'ai-r1.json',
  source: { kind: 'photo', layer: 'photos', photo: 'p1' },
  size: [4000, 3000],
  geom: { type: 'box', x: 100, y: 200, w: 300, h: 400 },
  classId: 'corrosion',
  severity: 2,
  uncertain: false,
  note: '',
  confidence: 0.9,
  status: 'draft',
  origin: { kind: 'ai', provider: 'x', model: 'm', promptVersion: 'v1', runId: 'r1' },
};
const PHOTO = { width: 4000, height: 3000 };
const OPTS = {
  currentId: null,
  fixing: false,
  classLabel: (id: string) => (id === 'corrosion' ? 'Corrosion' : ''),
};

describe('suggestionShapes', () => {
  it('draws a normalized draft at its place on the photo', () => {
    const [s] = suggestionShapes(
      [{ ...D, size: [1, 1], geom: { type: 'box', x: 0.25, y: 0.5, w: 0.1, h: 0.2 } }],
      PHOTO,
      OPTS,
    );
    expect(s).toMatchObject({
      key: 'det:d1',
      dashed: true,
      color: 'var(--warn)',
      geom: { type: 'box', x: 1000, y: 1500, w: 400, h: 600 },
    });
  });

  it('draws a draft stored in another pixel grid at its place on the photo', () => {
    const [s] = suggestionShapes(
      [{ ...D, size: [2000, 1500], geom: { type: 'box', x: 100, y: 150, w: 200, h: 300 } }],
      PHOTO,
      OPTS,
    );
    expect(s?.geom).toEqual({ type: 'box', x: 200, y: 300, w: 400, h: 600 });
  });

  it('leaves a draft in the photo pixels as it is', () => {
    const [s] = suggestionShapes([D], PHOTO, OPTS);
    expect(s?.geom).toBe(D.geom);
    expect(s?.title).toBe('Corrosion 90%');
  });

  it('makes only the current draft editable, and only in Fix', () => {
    const list = [D, { ...D, id: 'd2' }];
    const look = suggestionShapes(list, PHOTO, { ...OPTS, currentId: 'd1' });
    expect(look.map((s) => [s.key, s.selected, s.editable])).toEqual([
      ['det:d1', true, false],
      ['det:d2', false, false],
    ]);
    const fix = suggestionShapes(list, PHOTO, { ...OPTS, currentId: 'd1', fixing: true });
    expect(fix.map((s) => [s.key, s.selected, s.editable])).toEqual([
      ['det:d1', true, true],
      ['det:d2', false, false],
    ]);
  });

  it('leaves out drafts already decided', () => {
    const list: Detection[] = [
      { ...D, status: 'accepted' },
      { ...D, id: 'd2', status: 'rejected' },
    ];
    expect(suggestionShapes(list, PHOTO, OPTS)).toEqual([]);
  });

  it('names a draft without a class by the AI word, with no score when it has none', () => {
    const unscored: Detection = { ...D, classId: '', label: 'rust' };
    delete unscored.confidence;
    const [s] = suggestionShapes([unscored], PHOTO, OPTS);
    expect(s?.title).toBe('rust');
  });
});

describe('photoToDraft', () => {
  it('scales a Fix edit back into a draft stored in another pixel grid', () => {
    const d = { size: [2000, 1500] as [number, number] };
    expect(photoToDraft({ type: 'box', x: 200, y: 300, w: 400, h: 600 }, d, PHOTO)).toEqual({
      type: 'box',
      x: 100,
      y: 150,
      w: 200,
      h: 300,
    });
  });

  it('scales a Fix edit back into a normalized draft', () => {
    const d = { size: [1, 1] as [number, number] };
    expect(
      photoToDraft(
        {
          type: 'polygon',
          points: [
            [1000, 1500],
            [2000, 1500],
            [2000, 3000],
          ],
        },
        d,
        PHOTO,
      ),
    ).toEqual({
      type: 'polygon',
      points: [
        [0.25, 0.5],
        [0.5, 0.5],
        [0.5, 1],
      ],
    });
  });

  it('refuses a mask', () => {
    expect(
      photoToDraft({ type: 'mask', src: { path: 'm.png' } }, { size: [1, 1] }, PHOTO),
    ).toBeNull();
  });
});

describe('draftIdOf', () => {
  it('reads the draft id of a suggestion key and nothing else', () => {
    expect(draftIdOf('det:d1')).toBe('d1');
    expect(draftIdOf('i1:0')).toBeNull();
    expect(draftIdOf('proj:i1')).toBeNull();
  });
});
