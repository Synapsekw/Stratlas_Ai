// @vitest-environment jsdom
import { ASK_MARKER } from '@aio/ai';
import type { AskItem } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import type { DetectItem } from '../../detections/convert';
vi.mock('../../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false, error: 'not in this test' }) },
  useCall: () => null,
  useShell: () => '',
}));

import { askConfirmInfo, askItemsToDrafts, sendFields, type AskDraftRequest } from './custom';

const ITEM: DetectItem = { kind: 'photo', layer: 'ph', photo: 'p1' };
const CLASSES = [
  { id: 'gauge', label: 'Gauge' },
  { id: 'valve', label: 'Valve' },
];
const REQUEST: AskDraftRequest = {
  id: 'gauges',
  name: 'Read gauges',
  kind: 'find',
  prompt: 'Find every pressure gauge and read it.',
  fields: [{ key: 'bar', label: 'Pressure', type: 'number', unit: 'bar' }],
};
const item = (over: Partial<AskItem> = {}): AskItem => ({
  box: [0.1, 0.2, 0.3, 0.5],
  label: 'gauge',
  note: 'left of the pump',
  fields: [{ key: 'bar', label: 'Pressure', type: 'number', value: 4.2, unit: 'bar' }],
  ...over,
});

const drafts = (items: AskItem[], request: AskDraftRequest = REQUEST) => {
  let n = 0;
  return askItemsToDrafts({
    items,
    item: ITEM,
    size: { width: 4000, height: 3000 },
    request,
    classes: CLASSES,
    runId: 'r1',
    pass: 'ai-r1.json',
    provider: 'local',
    model: 'qwen3.5-9b-q4_k_m',
    now: '2026-10-29T10:00:00.000Z',
    newId: () => `d${String(++n)}`,
  });
};

describe('askItemsToDrafts', () => {
  it('scales boxes to the original 4000 x 3000 photo', () => {
    const [d] = drafts([item()]);
    expect(d?.size).toEqual([4000, 3000]);
    expect(d?.geom).toEqual({ type: 'box', x: 400, y: 600, w: 800, h: 900 });
    expect(d?.source).toEqual({ kind: 'photo', layer: 'ph', photo: 'p1' });
    expect(d?.status).toBe('draft');
    expect(d?.note).toBe('left of the pump');
  });

  it("takes the request's default class and severity", () => {
    const [d] = drafts([item({ label: 'something' })], {
      ...REQUEST,
      defaults: { classId: 'valve', severity: 3 },
    });
    expect(d?.classId).toBe('valve');
    expect(d?.severity).toBe(3);
  });

  it('else a class whose label matches the item label, ignoring case, else none', () => {
    const [a, b] = drafts([item({ label: 'GAUGE' }), item({ label: 'crack' })]);
    expect(a?.classId).toBe('gauge');
    expect(a?.severity).toBeNull();
    expect(b?.classId).toBe('');
    expect(b?.label).toBe('crack');
  });

  it('keeps the read values and names the request in the origin', () => {
    const [d] = drafts([item()]);
    expect(d?.fields).toEqual([
      { key: 'bar', label: 'Pressure', type: 'number', value: 4.2, unit: 'bar' },
    ]);
    expect(d?.origin).toEqual({
      kind: 'ai',
      provider: 'local',
      model: 'qwen3.5-9b-q4_k_m',
      promptVersion: 'ask-v1',
      runId: 'r1',
      request: 'gauges',
    });
    const typedIn: AskDraftRequest = {
      name: '',
      kind: 'find',
      prompt: REQUEST.prompt,
      fields: [],
    };
    const [typed] = drafts([item({ fields: [] })], typedIn);
    expect(typed?.origin).not.toHaveProperty('request');
    expect(typed?.fields).toBeUndefined();
  });
});

describe('askConfirmInfo', () => {
  it('shows the exact prompt sent for the first image and an estimate per image', () => {
    const items: DetectItem[] = [ITEM, { ...ITEM, photo: 'p2' }, { ...ITEM, photo: 'p3' }];
    const c = askConfirmInfo({
      route: { kind: 'cloud', provider: 'anthropic', model: 'claude-haiku-5-5' },
      items,
      request: REQUEST,
      requests: 3,
    });
    expect(c).toMatchObject({
      provider: 'anthropic',
      providerLabel: 'Anthropic',
      model: 'claude-haiku-5-5',
      photos: 3,
      frames: 0,
      instructions: '',
      hint: '',
    });
    expect(c.preview).toHaveLength(3);
    expect(c.userText.startsWith(ASK_MARKER)).toBe(true);
    expect(c.userText).toContain('Find every pressure gauge and read it.');
    // the guessed 2560 x 1708 photo goes as 1568 x 1046
    expect(c.userText).toContain('1568 x 1046');
    expect(c.estimate.requests).toBe(3);
    expect(c.estimate.inputTokens).toBeGreaterThan(0);
  });

  it('a change request reads the two built-in values first', () => {
    const change: AskDraftRequest = { ...REQUEST, kind: 'change', prompt: 'What changed?' };
    expect(sendFields(change).map((f) => f.key)).toEqual(['change_type', 'what', 'bar']);
    const c = askConfirmInfo({
      route: { kind: 'cloud', provider: 'anthropic', model: 'claude-sonnet-5-5' },
      items: [ITEM, { ...ITEM, photo: 'p2' }],
      request: change,
      requests: 1,
    });
    expect(c.userText).toContain('Image 1');
    expect(c.estimate.requests).toBe(1);
  });
});
