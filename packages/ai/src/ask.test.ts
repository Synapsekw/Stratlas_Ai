import type { AskItem, FieldSpec } from '@aio/schema';
import { AskItem as AskItemSchema } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  ASK_MARKER,
  ASK_MODELS,
  ASK_PROMPT_VERSION,
  ASK_SEND_MAX_PX,
  CHANGE_FIELDS,
  MAX_ASK_ITEMS,
  askMaxTokens,
  askPrompt,
  askProviderOptions,
  coerceField,
  estimateAsk,
  guardItems,
  parseAskReply,
  readJsonList,
  routeAsk,
} from './ask';

const num: FieldSpec = { key: 'pressure', label: 'Pressure', type: 'number', unit: 'bar' };
const yn: FieldSpec = { key: 'leak', label: 'Leak', type: 'yesno' };
const ch: FieldSpec = { key: 'state', label: 'State', type: 'choice', choices: ['Open', 'Closed'] };
const txt: FieldSpec = { key: 'tag', label: 'Tag', type: 'text' };

describe('constants', () => {
  it('match the contract', () => {
    expect(ASK_PROMPT_VERSION).toBe('ask-v1');
    expect(ASK_MARKER).toBe('<aio-ask>');
    expect(MAX_ASK_ITEMS).toBe(30);
    expect(ASK_SEND_MAX_PX).toEqual({ cloud: 1568, local: 1344 });
    expect(CHANGE_FIELDS.map((f) => [f.key, f.type])).toEqual([
      ['change_type', 'choice'],
      ['what', 'text'],
    ]);
    expect(CHANGE_FIELDS[0]?.choices).toEqual(['new', 'removed', 'moved', 'progress', 'damage']);
    expect(ASK_MODELS.map((m) => m.model)).toEqual([
      'claude-haiku-5-5',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'gpt-6.1-sol',
      'gpt-6-luna',
    ]);
    expect(ASK_MODELS.filter((m) => m.best).map((m) => m.model)).toEqual(['claude-opus-5-5']);
  });
});

describe('readJsonList', () => {
  it('reads a bare list', () => {
    expect(readJsonList('[{"a":1}]')).toEqual({ list: [{ a: 1 }], repaired: false, cut: false });
  });
  it('reads a fenced list', () => {
    expect(readJsonList('Here:\n```json\n[{"a":1},{"a":2}]\n```')?.list).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });
  it('drops think blocks', () => {
    expect(readJsonList('<think>maybe [1, {</think>[{"a":1}]')?.list).toEqual([{ a: 1 }]);
  });
  it('repairs a doubled brace', () => {
    expect(readJsonList('[{"a":1}}]')).toEqual({ list: [{ a: 1 }], repaired: true, cut: false });
  });
  it('keeps the items before a cut', () => {
    expect(readJsonList('[{"a":1},{"a":2},{"a":3, "b": "half')).toEqual({
      list: [{ a: 1 }, { a: 2 }],
      repaired: false,
      cut: true,
    });
  });
  it('turns a lone object into a one item list', () => {
    expect(readJsonList('{"a":1}')?.list).toEqual([{ a: 1 }]);
  });
  it('gives null for prose', () => {
    expect(readJsonList('I cannot see any gauges in this photo.')).toBeNull();
  });
  it('reads an empty list', () => {
    expect(readJsonList('[]')?.list).toEqual([]);
  });
});

describe('parseAskReply', () => {
  const reply = (box: number[]) => JSON.stringify([{ bbox_2d: box, label: 'gauge', note: 'n' }]);
  const boxOf = (r: ReturnType<typeof parseAskReply>) => {
    if ('error' in r) throw new Error(r.error);
    return r.items[0]?.box;
  };
  const near = (got: number[] | undefined, want: number[]) => {
    expect(got).toHaveLength(4);
    want.forEach((w, n) => {
      expect(got?.[n]).toBeCloseTo(w, 6);
    });
  };

  it('reads qwen3 boxes in 0 to 1000', () => {
    const r = parseAskReply(reply([100, 200, 300, 500]), {
      family: 'qwen3',
      kind: 'find',
      sent: { width: 1344, height: 1008 },
      fields: [],
    });
    near(boxOf(r), [0.1, 0.2, 0.3, 0.5]);
    if ('error' in r) return;
    expect(r.items[0]).toEqual({
      box: [0.1, 0.2, 0.3, 0.5],
      label: 'gauge',
      note: 'n',
      fields: [],
    });
    expect(AskItemSchema.safeParse(r.items[0]).success).toBe(true);
  });
  it('reads qwen25 boxes in sent pixels', () => {
    const r = parseAskReply(reply([134.4, 201.6, 403.2, 504]), {
      family: 'qwen25',
      kind: 'find',
      sent: { width: 1344, height: 1008 },
      fields: [],
    });
    near(boxOf(r), [0.1, 0.2, 0.3, 0.5]);
  });
  it('reads cloud boxes in sent pixels', () => {
    const r = parseAskReply(reply([156.8, 235.2, 470.4, 588]), {
      family: 'cloud',
      kind: 'find',
      sent: { width: 1568, height: 1176 },
      fields: [],
    });
    near(boxOf(r), [0.1, 0.2, 0.3, 0.5]);
  });
  it('sorts swapped corners', () => {
    const r = parseAskReply(reply([300, 500, 100, 200]), {
      family: 'qwen3',
      kind: 'find',
      sent: { width: 1344, height: 1008 },
      fields: [],
    });
    near(boxOf(r), [0.1, 0.2, 0.3, 0.5]);
  });
  it('drops a box under 3 sent pixels with a warning', () => {
    const r = parseAskReply(reply([10, 10, 12, 40]), {
      family: 'cloud',
      kind: 'find',
      sent: { width: 1568, height: 1176 },
      fields: [],
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.items).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/smaller than 3 pixels/);
  });
  it('answers an error with the model words for prose', () => {
    const r = parseAskReply('Sorry, I see nothing here.', {
      family: 'qwen3',
      kind: 'find',
      sent: { width: 1344, height: 1008 },
      fields: [],
    });
    expect('error' in r && r.error).toMatch(/^The model did not answer in the format asked for/);
    expect('error' in r && r.error).toContain('Sorry, I see nothing here.');
  });
  it('reads fields, and for change the built-in ones first with what as the label', () => {
    const r = parseAskReply(
      JSON.stringify([
        { bbox_2d: [100, 100, 400, 400], change_type: 'New', what: 'crane', note: 'x', tag: 'A1' },
      ]),
      { family: 'qwen3', kind: 'change', sent: { width: 1344, height: 1008 }, fields: [txt] },
    );
    if ('error' in r) throw new Error(r.error);
    const item = r.items[0];
    expect(item?.label).toBe('crane');
    expect(item?.fields.map((f) => [f.key, f.value])).toEqual([
      ['change_type', 'new'],
      ['what', 'crane'],
      ['tag', 'A1'],
    ]);
  });
  it('does not repeat the built-in fields when the caller passes them', () => {
    const r = parseAskReply(JSON.stringify([{ bbox_2d: [100, 100, 400, 400] }]), {
      family: 'qwen3',
      kind: 'change',
      sent: { width: 1344, height: 1008 },
      fields: [...CHANGE_FIELDS, txt],
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.items[0]?.fields.map((f) => f.key)).toEqual(['change_type', 'what', 'tag']);
    expect(r.items[0]?.label).toBe('item');
  });
  it('warns on a repaired or cut reply', () => {
    const r = parseAskReply('[{"bbox_2d":[100,100,400,400]}}]', {
      family: 'qwen3',
      kind: 'find',
      sent: { width: 1344, height: 1008 },
      fields: [],
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.items).toHaveLength(1);
    expect(r.warnings.join(' ')).toMatch(/repaired/);
  });
});

describe('coerceField', () => {
  it('reads numbers', () => {
    expect(coerceField(num, 4.2).value).toEqual({
      key: 'pressure',
      label: 'Pressure',
      type: 'number',
      value: 4.2,
      unit: 'bar',
    });
    expect(coerceField(num, '4.2').value.value).toBe(4.2);
    expect(coerceField(num, '4,2 bar').value.value).toBe(4.2);
    const na = coerceField(num, 'n/a');
    expect(na.value.value).toBeNull();
    expect(na.warning).toBeTruthy();
  });
  it('reads yes and no', () => {
    expect(coerceField(yn, 'Yes.').value.value).toBe('yes');
    expect(coerceField(yn, true).value.value).toBe('yes');
    expect(coerceField(yn, 'no').value.value).toBe('no');
    const maybe = coerceField(yn, 'maybe');
    expect(maybe.value.value).toBe('unknown');
    expect(maybe.warning).toBeTruthy();
  });
  it('reads choices', () => {
    const off = coerceField(ch, 'half open');
    expect(off.value.value).toBeNull();
    expect(off.warning).toBeTruthy();
    expect(coerceField(ch, 'closed')).toEqual({
      value: { key: 'state', label: 'State', type: 'choice', value: 'Closed' },
    });
  });
  it('trims text to 200', () => {
    expect(coerceField(txt, ` ${'x'.repeat(300)} `).value.value).toHaveLength(200);
  });
  it('gives null without a warning for a missing key', () => {
    expect(coerceField(num, undefined)).toEqual({
      value: { key: 'pressure', label: 'Pressure', type: 'number', value: null, unit: 'bar' },
    });
  });
});

describe('guardItems', () => {
  const sent = { width: 1000, height: 1000 };
  const item = (box: [number, number, number, number]): AskItem => ({
    box,
    label: 'x',
    note: '',
    fields: [],
  });

  it('merges copies of one box', () => {
    const r = guardItems(
      Array.from({ length: 50 }, () => item([0.1, 0.1, 0.2, 0.2])),
      { sent },
    );
    expect(r.items).toHaveLength(1);
  });
  it('caps distinct boxes at 30', () => {
    const many = Array.from({ length: 40 }, (_, n) =>
      item([
        (n % 8) * 0.1,
        Math.floor(n / 8) * 0.1,
        (n % 8) * 0.1 + 0.05,
        Math.floor(n / 8) * 0.1 + 0.05,
      ]),
    );
    const r = guardItems(many, { sent });
    expect(r.items).toHaveLength(30);
    expect(r.items[0]).toBe(many[0]);
    expect(r.warnings).toContain('The model listed 40 items; the first 30 are kept.');
  });
  it('drops a whole-frame box unless the request asks for the whole image', () => {
    const big = item([0.01, 0.01, 0.99, 0.99]);
    expect(guardItems([big], { sent }).items).toEqual([]);
    expect(guardItems([big], { sent, wholeImage: true }).items).toEqual([big]);
  });
  it('merges two boxes sharing 70 % of the smaller into the larger', () => {
    const small = item([0, 0, 0.1, 0.1]);
    const large = item([0.03, 0, 0.3, 0.3]);
    // overlap 0.07 x 0.1 = 0.007, 70 % of the small box's 0.01.
    expect(guardItems([small, large], { sent }).items).toEqual([large]);
  });
  it('keeps boxes sharing less than 60 %', () => {
    const a = item([0, 0, 0.1, 0.1]);
    const b = item([0.05, 0, 0.3, 0.3]);
    expect(guardItems([a, b], { sent }).items).toEqual([a, b]);
  });
});

describe('routeAsk', () => {
  const anthropic = { usable: true, providers: ['anthropic', 'openai'] as const };
  const openai = { usable: true, providers: ['openai'] as const };
  const off = { usable: false, providers: ['anthropic'] as const };
  const ready = { ready: true };
  const notReady = { ready: false };
  const cloud = (model: string, provider = 'anthropic') => ({
    route: { kind: 'cloud', provider, model },
    weakOffline: false,
  });

  it('routes automatically with Anthropic', () => {
    const r = (kind: 'find' | 'change' | 'ask', scope: 'photo' | 'all' | 'dates', local = ready) =>
      routeAsk({ kind, scope, choice: 'auto', cloud: anthropic, local });
    expect(r('change', 'dates')).toEqual(cloud('claude-sonnet-5-5'));
    expect(r('ask', 'photo')).toEqual(cloud('claude-sonnet-5-5'));
    expect(r('find', 'all')).toEqual(cloud('claude-haiku-5-5'));
    expect(r('find', 'photo')).toEqual({ route: { kind: 'local' }, weakOffline: false });
    expect(
      routeAsk({ kind: 'find', scope: 'selected', choice: 'auto', cloud: anthropic, local: ready }),
    ).toEqual({ route: { kind: 'local' }, weakOffline: false });
    expect(r('find', 'photo', notReady)).toEqual(cloud('claude-haiku-5-5'));
  });
  it('maps to OpenAI when it is the only key', () => {
    expect(
      routeAsk({ kind: 'change', scope: 'dates', choice: 'auto', cloud: openai, local: ready }),
    ).toEqual(cloud('gpt-6.1-sol', 'openai'));
    expect(
      routeAsk({ kind: 'find', scope: 'all', choice: 'auto', cloud: openai, local: ready }),
    ).toEqual(cloud('gpt-6-luna', 'openai'));
  });
  it('runs everything on this PC without the cloud', () => {
    expect(
      routeAsk({ kind: 'find', scope: 'all', choice: 'auto', cloud: off, local: ready }),
    ).toEqual({ route: { kind: 'local' }, weakOffline: false });
    expect(
      routeAsk({ kind: 'change', scope: 'dates', choice: 'auto', cloud: off, local: ready }),
    ).toEqual({ route: { kind: 'local' }, weakOffline: true });
    expect(
      routeAsk({ kind: 'ask', scope: 'photo', choice: 'auto', cloud: off, local: ready }),
    ).toEqual({ route: { kind: 'local' }, weakOffline: true });
    expect(
      routeAsk({
        kind: 'ask',
        scope: 'photo',
        choice: 'auto',
        cloud: { usable: true, providers: [] },
        local: ready,
      }),
    ).toEqual({ route: { kind: 'local' }, weakOffline: true });
  });
  it('answers none when nothing can run', () => {
    expect(
      routeAsk({ kind: 'find', scope: 'photo', choice: 'auto', cloud: off, local: notReady }),
    ).toEqual({ none: 'nothing' });
    expect(
      routeAsk({
        kind: 'find',
        scope: 'photo',
        choice: 'local',
        cloud: anthropic,
        local: notReady,
      }),
    ).toEqual({ none: 'local' });
    expect(
      routeAsk({
        kind: 'find',
        scope: 'photo',
        choice: { provider: 'anthropic', model: 'claude-opus-5-5' },
        cloud: openai,
        local: ready,
      }),
    ).toEqual({ none: 'cloud' });
    expect(
      routeAsk({
        kind: 'find',
        scope: 'photo',
        choice: { provider: 'anthropic', model: 'claude-opus-5-5' },
        cloud: off,
        local: ready,
      }),
    ).toEqual({ none: 'cloud' });
  });
  it('honours an explicit choice', () => {
    expect(
      routeAsk({ kind: 'find', scope: 'all', choice: 'local', cloud: anthropic, local: ready }),
    ).toEqual({ route: { kind: 'local' }, weakOffline: false });
    expect(
      routeAsk({
        kind: 'find',
        scope: 'photo',
        choice: { provider: 'anthropic', model: 'claude-opus-5-5' },
        cloud: anthropic,
        local: ready,
      }),
    ).toEqual(cloud('claude-opus-5-5'));
  });
});

describe('askProviderOptions and askMaxTokens', () => {
  it('sets the effort', () => {
    expect(askProviderOptions('anthropic', 'claude-sonnet-5-5', 'find')).toEqual({
      anthropic: { effort: 'low' },
    });
    expect(askProviderOptions('anthropic', 'claude-opus-5-5', 'change')).toEqual({
      anthropic: { effort: 'medium' },
    });
    expect(askProviderOptions('anthropic', 'claude-opus-5-5', 'find')).toEqual({
      anthropic: { effort: 'low' },
    });
    expect(askProviderOptions('openai', 'gpt-6-luna', 'find')).toEqual({
      openai: { reasoningEffort: 'low' },
    });
  });
  it('caps the answer length', () => {
    expect(['find', 'change', 'ask'].map((k) => askMaxTokens(k as 'find', 'cloud'))).toEqual([
      8000, 12000, 6000,
    ]);
    expect(['find', 'change', 'ask'].map((k) => askMaxTokens(k as 'find', 'local'))).toEqual([
      2048, 2048, 700,
    ]);
  });
});

describe('askPrompt', () => {
  const three = [num, yn, ch];
  it('writes a qwen3 find prompt with three fields', () => {
    expect(
      askPrompt({
        family: 'qwen3',
        kind: 'find',
        prompt: 'Find all pressure gauges.',
        fields: three,
        images: [{ width: 1344, height: 1008 }],
      }),
    ).toBe(
      'Find all pressure gauges.\nGive each item its own tight box. Output JSON only: [{"bbox_2d": [x1, y1, x2, y2], "label": "<short name>", "note": "<what and where, max 20 words>", "pressure": <Pressure in bar as a number, or null if you cannot read it>, "leak": "yes|no|unknown", "state": "Open|Closed"}] with bbox_2d coordinates normalised to 0-1000. Output [] if there is none.',
    );
  });
  it('writes a cloud find prompt with three fields', () => {
    expect(
      askPrompt({
        family: 'cloud',
        kind: 'find',
        prompt: 'Find all pressure gauges.',
        fields: three,
        images: [{ width: 1568, height: 1176 }],
      }),
    ).toBe(
      '<aio-ask>\nFind all pressure gauges.\nGive each item its own tight box. Output JSON only: [{"bbox_2d": [x1, y1, x2, y2], "label": "<short name>", "note": "<what and where, max 20 words>", "pressure": <Pressure in bar as a number, or null if you cannot read it>, "leak": "yes|no|unknown", "state": "Open|Closed"}]. Output [] if there is none. Box coordinates are integer pixels of the image (it is 1568 x 1176 pixels as sent), x to the right, y down.',
    );
  });
  it('writes a change prompt with the built-in fields first', () => {
    expect(
      askPrompt({
        family: 'cloud',
        kind: 'change',
        prompt: 'Look at the scaffolding.',
        fields: [...CHANGE_FIELDS, txt],
        images: [
          { width: 1568, height: 1176, label: '3 March 2026' },
          { width: 1568, height: 1176, label: '9 June 2026' },
        ],
      }),
    ).toBe(
      '<aio-ask>\nImage 1 was taken on 3 March 2026 and Image 2 on 9 June 2026, from about the same spot. Look at the scaffolding.\nList every real change between them; ignore lighting, shadows, water glare and small camera shifts. For each change output one object: {"bbox_2d": [x1, y1, x2, y2], "change_type": "new|removed|moved|progress|damage", "what": "<the object>", "note": "<what changed, max 20 words>", "tag": "<Tag, max 10 words>"}, where the box marks the change on Image 2. Output a JSON list only, at most 10 items. Output [] if nothing changed. Box coordinates are integer pixels of each image (both are 1568 x 1176 pixels as sent), x to the right, y down.',
    );
  });
  it('writes an ask prompt without the marker for local', () => {
    expect(
      askPrompt({
        family: 'qwen3',
        kind: 'ask',
        prompt: 'Is the hatch closed?',
        fields: [],
        images: [{ width: 1344, height: 1008 }],
      }),
    ).toBe(
      'You help an inspection engineer review drone inspection photos. Answer in plain text, briefly and concretely. Say when something cannot be seen clearly. Do not grade severity; the engineer sets it.\nIs the hatch closed?',
    );
  });
});

describe('estimateAsk', () => {
  it('prices one Haiku photo under a cent', () => {
    const e = estimateAsk({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      kind: 'find',
      images: [{ width: 1568, height: 1176 }],
      prompt: 'Find all gauges.',
      fields: [num],
      requests: 1,
    });
    expect(e.requests).toBe(1);
    expect(e.outputTokens).toBe(600);
    expect(e.costUsd).toBeGreaterThan(0);
    expect(e.costUsd).toBeLessThan(0.01);
  });
  it('costs nothing on this PC', () => {
    expect(
      estimateAsk({
        provider: 'local',
        model: 'qwen3.5-9b-q4_k_m',
        kind: 'change',
        images: [
          { width: 1344, height: 1008 },
          { width: 1344, height: 1008 },
        ],
        prompt: 'x',
        fields: [],
        requests: 1,
      }).costUsd,
    ).toBe(0);
  });
});
