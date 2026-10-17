import { AI_LABEL_KIND } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  ANTENNA_LABEL_PROMPT_VERSION,
  antennaLabelInstructions,
  antennaLabelUserText,
  estimateAntennaLabel,
  parseAntennaLabels,
  WARNING_KEY_MAX,
  WARNINGS_MAX,
} from './antennaLabel';

describe('parseAntennaLabels', () => {
  it('parses one label per key and drops unknown labels with a warning', () => {
    const r = parseAntennaLabels(
      '{"labels":[{"key":"ant-1","label":"radio-unit","reason":"small box"},{"key":"ant-2","label":"omni","reason":"x"}]}',
      ['ant-1', 'ant-2'],
    );
    expect(r.labels).toEqual([{ unitId: 'ant-1', label: 'radio-unit', reason: 'small box' }]);
    expect(r.warnings).toHaveLength(1);
  });

  it('reads a fenced reply, ignores keys that were not asked for and repeats', () => {
    const text =
      'Here you go\n```json\n{"labels":[{"key":"ant-1","label":"panel","reason":"flat"},{"key":"ant-9","label":"dish","reason":"?"},{"key":"ant-1","label":"dish","reason":"again"}]}\n```';
    const r = parseAntennaLabels(text, ['ant-1', 'ant-2']);
    expect(r.labels).toEqual([{ unitId: 'ant-1', label: 'panel', reason: 'flat' }]);
    // ant-9 was not asked for; ant-2 got no label
    expect(r.warnings.some((w) => w.includes('ant-9'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('ant-2'))).toBe(true);
  });

  it('keeps the reason within 200 characters and tolerates a missing reason', () => {
    const r = parseAntennaLabels(
      JSON.stringify({
        labels: [
          { key: 'ant-1', label: 'other', reason: 'x'.repeat(500) },
          { key: 'ant-2', label: 'dish' },
        ],
      }),
      ['ant-1', 'ant-2'],
    );
    expect(r.labels[0]?.reason).toHaveLength(200);
    expect(r.labels[1]).toEqual({ unitId: 'ant-2', label: 'dish', reason: '' });
  });

  it('compares keys exactly: a bad label for ant-10 still leaves ant-1 unlabelled', () => {
    const r = parseAntennaLabels('{"labels":[{"key":"ant-10","label":"omni","reason":"x"}]}', [
      'ant-1',
      'ant-10',
    ]);
    expect(r.labels).toEqual([]);
    expect(r.warnings).toEqual([
      'The label for ant-10 is not one of the allowed labels. It was ignored.',
      'The reply has no label for ant-1.',
    ]);
  });

  it('cuts a long unsent key in its warning', () => {
    const key = `ant-${'x'.repeat(5000)}`;
    const r = parseAntennaLabels(JSON.stringify({ labels: [{ key, label: 'dish' }] }), []);
    expect(r.warnings).toHaveLength(1);
    const w = r.warnings[0] ?? '';
    expect(w).toContain(`"${key.slice(0, WARNING_KEY_MAX)}..."`);
    expect(w.length).toBeLessThan(WARNING_KEY_MAX + 80);
  });

  it('caps the warnings of one reply', () => {
    const labels = Array.from({ length: 100 }, (_, i) => ({
      key: `bad-${String(i)}`,
      label: 'dish',
    }));
    const r = parseAntennaLabels(JSON.stringify({ labels }), ['ant-1']);
    expect(r.warnings).toHaveLength(WARNINGS_MAX);
    expect(r.warnings[0]).toContain('"bad-0"');
    // 100 unsent keys and one missing label, 19 listed
    expect(r.warnings.at(-1)).toBe('82 more warnings were not listed.');
  });

  it('warns for every key when the reply is not JSON', () => {
    const r = parseAntennaLabels('I cannot tell.', ['ant-1', 'ant-2']);
    expect(r.labels).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('antenna label prompt', () => {
  it('never asks for numbers', () => {
    expect(antennaLabelInstructions()).not.toMatch(/azimuth|tilt|degree|size/i);
  });

  it('names every label the schema allows, once per image, JSON only', () => {
    const text = antennaLabelInstructions();
    for (const label of Object.keys(AI_LABEL_KIND)) expect(text).toContain(label);
    expect(text).toMatch(/JSON/);
    expect(text).toMatch(/20 words/);
    expect(ANTENNA_LABEL_PROMPT_VERSION).toBe('antenna-label-v1');
  });

  it('lists the keys in the order of the images', () => {
    const t = antennaLabelUserText(['ant-a', 'ant-b']);
    expect(t.indexOf('ant-a')).toBeGreaterThanOrEqual(0);
    expect(t.indexOf('ant-a')).toBeLessThan(t.indexOf('ant-b'));
  });
});

describe('estimateAntennaLabel', () => {
  it('grows with the number of images', () => {
    const one = estimateAntennaLabel(1);
    const four = estimateAntennaLabel(4);
    expect(one.images).toBe(1);
    expect(four.images).toBe(4);
    expect(four.inputTokens).toBeGreaterThan(one.inputTokens);
    expect(estimateAntennaLabel(0).inputTokens).toBe(0);
  });
});
