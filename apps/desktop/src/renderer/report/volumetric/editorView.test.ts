import type { SurveyMeasurement } from '@aio/schema';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeVolumetricEditor,
  figuresKey,
  openVolumetricEditor,
  picturesFingerprint,
  picturesTaken,
  reportPiles,
  volumetricView,
} from './editorView';

const pile = (id: string, over: Partial<SurveyMeasurement> = {}) =>
  ({
    id,
    family: 'polygon',
    label: id,
    points: [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
    ],
    items: [{ from: { kind: 'lowest' }, to: { kind: 'current' } }],
    results: [],
    ...over,
  }) as unknown as SurveyMeasurement;

afterEach(() => {
  volumetricView.setState({ openFor: null, taken: {}, pictureError: null });
});

describe('the volumetric editor view', () => {
  it('stays open for its project across a screen change, and closes', () => {
    openVolumetricEditor('p1');
    expect(volumetricView.getState().openFor).toBe('p1');
    closeVolumetricEditor();
    expect(volumetricView.getState().openFor).toBeNull();
  });

  it('counts the pictures taken per project', () => {
    picturesTaken('p1');
    picturesTaken('p1');
    expect(volumetricView.getState().taken).toEqual({ p1: 2 });
  });
});

describe('fingerprints', () => {
  const dates = ['c1', 'c2'];
  const pair = { from: 'c1', to: 'c2' };

  it('keeps the pictures fingerprint while nothing they show changes', () => {
    const a = picturesFingerprint([pile('m1')], dates, pair);
    expect(a).toBe(picturesFingerprint([pile('m1', { label: 'renamed' })], dates, pair));
    expect(a.length).toBeLessThanOrEqual(200);
  });

  it('changes it with an outline, a date or the compared pair', () => {
    const a = picturesFingerprint([pile('m1')], dates, pair);
    const moved = pile('m1', {
      points: [
        [0, 0, 0],
        [12, 0, 0],
        [10, 10, 0],
      ],
    });
    expect(picturesFingerprint([moved], dates, pair)).not.toBe(a);
    expect(picturesFingerprint([pile('m1')], ['c1', 'c2', 'c3'], pair)).not.toBe(a);
    expect(picturesFingerprint([pile('m1')], dates, null)).not.toBe(a);
  });

  it('changes the figures key with any stockpile edit', () => {
    const a = figuresKey([pile('m1')]);
    expect(figuresKey([pile('m1')])).toBe(a);
    expect(figuresKey([pile('m1', { label: 'renamed' })])).not.toBe(a);
  });

  it('pictures only the stockpile measurements', () => {
    const line = pile('l1', { family: 'line' });
    expect(reportPiles([pile('m1'), line]).map((m) => m.id)).toEqual(['m1']);
  });
});
