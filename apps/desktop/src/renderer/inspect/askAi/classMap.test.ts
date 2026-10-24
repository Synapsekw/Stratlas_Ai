// @vitest-environment jsdom
import type { DetectorModelInfo } from '@aio/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { classMapFor, defaultClass, readClassMap, writeClassMap } from './classMap';

const CLASSES = [
  { id: 'corrosion', label: 'Corrosion' },
  { id: 'crack', label: 'Hairline crack' },
];

const model = (classes: string[]) =>
  ({
    id: 'yolo',
    card: { name: 'Yolo', classes, input: { width: 640, height: 640 } },
  }) as unknown as DetectorModelInfo;

beforeEach(() => {
  window.localStorage.clear();
});

describe('local model class maps', () => {
  it('keeps a stored map and fills defaults for new model classes', () => {
    window.localStorage.setItem(
      'stratlas.detect.classMap.p.yolo',
      JSON.stringify({ rust: 'corrosion', corrosion: '' }),
    );
    expect(
      classMapFor('p', model(['rust', 'corrosion', 'hairline crack', 'bird']), CLASSES),
    ).toEqual({ rust: 'corrosion', corrosion: '', 'hairline crack': 'crack', bird: '' });
  });

  it('matches a model class to a project class by id or label', () => {
    expect(defaultClass(' Corrosion ', CLASSES)).toBe('corrosion');
    expect(defaultClass('hairline CRACK', CLASSES)).toBe('crack');
    expect(defaultClass('bird', CLASSES)).toBe('');
  });

  it('writes under the old key and reads back; an unreadable map is empty', () => {
    writeClassMap('p', 'yolo', { rust: 'corrosion' });
    expect(window.localStorage.getItem('stratlas.detect.classMap.p.yolo')).toBe(
      JSON.stringify({ rust: 'corrosion' }),
    );
    expect(readClassMap('p', 'yolo')).toEqual({ rust: 'corrosion' });
    window.localStorage.setItem('stratlas.detect.classMap.p.yolo', '{not json');
    expect(readClassMap('p', 'yolo')).toEqual({});
  });
});
